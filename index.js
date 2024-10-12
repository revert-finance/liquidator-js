require('dotenv').config()
const { ethers, BigNumber } = require('ethers')
const { quoteUniversalRouter, registerErrorHandler, npmContract, provider, signer, setupWebsocket, 
        getPool, getAllLogs, getPoolPrice, getAmounts, getTokenAssetPriceX96,
        getTickSpacing, getFlashloanPoolOptions, getV3VaultAddress, getFlashLoanLiquidatorAddress,
        executeTx, getTokenDecimals, getTokenSymbol, getPoolToToken,
        getRevertUrlForDiscord, getExplorerUrlForDiscord, Q32, Q96 } = require('./lib/common')

const v3VaultContract = new ethers.Contract(getV3VaultAddress(), require("./contracts/V3Vault.json").abi, provider)
const floashLoanLiquidatorContract = new ethers.Contract(getFlashLoanLiquidatorAddress(), require("./contracts/FlashloanLiquidator.json").abi, provider)

const positionLogInterval = 1 * 6000 // log positions each 1 min
const enableNonFlashloanLiquidation = false

const positions = {}
const cachedTokenDecimals = {}
const cachedCollateralFactorX32 = {}

let cachedExchangeRateX96
let asset, assetDecimals, assetSymbol
let lastWSLifeCheck = new Date().getTime()

async function updateDebtExchangeRate() {
  const info = await v3VaultContract.vaultInfo()
  cachedExchangeRateX96 = info.debtExchangeRateX96
}

async function loadPositions() {
  let adds = await getAllLogs(v3VaultContract.filters.Add())
  let removes = await getAllLogs(v3VaultContract.filters.Remove())
  let loadedPositions = 0
  // from newest to oldest - process each event once - remove deactivated positions
  while (adds.length > 0) {
      const event = adds[adds.length - 1]
      const tokenId = v3VaultContract.interface.parseLog(event).args.tokenId
      const isActive = removes.filter(e => tokenId.eq(v3VaultContract.interface.parseLog(e).args.tokenId) && (e.blockNumber > event.blockNumber || (e.blockNumber == event.blockNumber && e.logIndex > event.logIndex))).length === 0
      if (isActive) {
        await updatePosition(tokenId)
        loadedPositions++
      }
      adds = adds.filter(e => !v3VaultContract.interface.parseLog(e).args.tokenId.eq(tokenId))
  }
  console.log(`Loaded ${loadedPositions} active positions`)
}


// loads all needed data for position
async function updatePosition(tokenId) {
  // if processing - retry later
  if (positions[tokenId] && (positions[tokenId].isChecking || positions[tokenId].isExecuting || positions[tokenId].isUpdating)) { 
    setTimeout(async() => await updatePosition(tokenId), 10000)
    return
  }

  if (!positions[tokenId]) {
    positions[tokenId] = { isUpdating: true }
  } else {
    positions[tokenId].isUpdating = true
  }
  
  try {
    const debtShares = await v3VaultContract.loans(tokenId)
    if (debtShares.gt(0)) {
      // add or update
      const { liquidity, tickLower, tickUpper, fee, token0, token1 } = await npmContract.positions(tokenId);
      const tickSpacing = getTickSpacing(fee)
      const poolAddress = await getPool(token0, token1, fee)
      
      const owner = await v3VaultContract.ownerOf(tokenId)

      // get current fees - for estimation
      const fees = await npmContract.connect(v3VaultContract.address).callStatic.collect([tokenId, ethers.constants.AddressZero, BigNumber.from(2).pow(128).sub(1), BigNumber.from(2).pow(128).sub(1)])

      if (cachedTokenDecimals[token0] === undefined) {
        cachedTokenDecimals[token0] = await getTokenDecimals(token0)
      }
      if (cachedTokenDecimals[token1] === undefined) {
        cachedTokenDecimals[token1] = await getTokenDecimals(token1)
      }
      const decimals0 = cachedTokenDecimals[token0]
      const decimals1 = cachedTokenDecimals[token1]

      if (!cachedCollateralFactorX32[token0]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token0)
        cachedCollateralFactorX32[token0] = tokenConfig.collateralFactorX32
      }
      if (!cachedCollateralFactorX32[token1]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token1)
        cachedCollateralFactorX32[token1] = tokenConfig.collateralFactorX32
      }

      const collateralFactorX32 = cachedCollateralFactorX32[token0] < cachedCollateralFactorX32[token1] ? cachedCollateralFactorX32[token0] : cachedCollateralFactorX32[token1]

      positions[tokenId] = { ...positions[tokenId], tokenId, liquidity, tickLower, tickUpper, tickSpacing, fee, token0: token0.toLowerCase(), token1: token1.toLowerCase(), decimals0, decimals1, poolAddress, debtShares, owner, collateralFactorX32, fees0: fees.amount0, fees1: fees.amount1 }

    } else {
      delete positions[tokenId]
    }
  } catch(err) {
    // retry on error after 1 min
    setTimeout(async() => await updatePosition(tokenId), 60000)
    console.log("Error updating position " + tokenId.toString(), err)
  }

  if (positions[tokenId]) {
    positions[tokenId].isUpdating = false
  }
}

// checks position 
async function checkPosition(position) {
  
  if (!position || position.isChecking || position.isExecuting || position.isUpdating) {
    return
  }
  position.isChecking = true

  let info, amount0, amount1

  // check if liquidation needed - step I  
  try {
    const poolPrice = await getPoolPrice(position.poolAddress)
    const amounts = position.liquidity.gt(0) ? getAmounts(poolPrice.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity) : { amount0: BigNumber.from(0), amount1 : BigNumber.from(0) }
    amount0 = amounts.amount0.add(position.fees0)
    amount1 = amounts.amount1.add(position.fees1)

    const price0X96 = await getTokenAssetPriceX96(position.token0, asset)
    const price1X96 = await getTokenAssetPriceX96(position.token1, asset)

    const assetValue = price0X96.mul(amount0).div(Q96).add(price1X96.mul(amount1).div(Q96))
    const collateralValue = assetValue.mul(position.collateralFactorX32).div(Q32)
    const debtValue = position.debtShares.mul(cachedExchangeRateX96).div(Q96)

    if (debtValue.gt(collateralValue)) {
      // only call this once per minute to update position (&fees)
      if (!position.lastLiquidationCheck || position.lastLiquidationCheck + 60000 < Date.now()) {
        info = await v3VaultContract.loanInfo(position.tokenId)
        position.lastLiquidationCheck = Date.now()
      }
    }

    if (debtValue.gt(0) && (!position.lastLog || position.lastLog + positionLogInterval < Date.now())) {
      const factor = collateralValue.mul(100).div(debtValue).toNumber() / 100
      if (factor < 1.1) {
        const msg = `Low collateral factor ${factor.toFixed(2)} for ${getRevertUrlForDiscord(position.tokenId)} with debt ${ethers.utils.formatUnits(debtValue, assetDecimals)} ${assetSymbol}`
        console.log(msg)
        position.lastLog = Date.now()
      }
    }

  } catch (err) { 
    console.log("Error checking position " + position.tokenId.toString(), err)
    info = null
  }

  if (info && info.liquidationValue.gt(0)) {

    // run liquidation - step II  
    try {
      // amount that will be available to the contract - remove a bit for withdrawal slippage
      const amount0Available = amount0.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)
      const amount1Available = amount1.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)

      const deadline = Math.floor(Date.now() / 1000 + 1800)

      // prepare swaps
      let amount0In = BigNumber.from(0)
      let swapData0 = "0x"
      let pools = []
      if (position.token0 != asset && amount0Available.gt(0)) {
        amount0In = amount0Available
        const quote = await quoteUniversalRouter(position.token0, asset, position.decimals0, assetDecimals, amount0In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData0 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      let amount1In = BigNumber.from(0)
      let swapData1 = "0x"
      if (position.token1 != asset && amount1Available.gt(0)) {
        amount1In = amount1Available
        const quote = await quoteUniversalRouter(position.token1, asset, position.decimals1, assetDecimals, amount1In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData1 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      pools.push(position.poolAddress)

      const flashLoanPoolOptions = getFlashloanPoolOptions(asset)
      const flashLoanPool = flashLoanPoolOptions.filter(o => !pools.includes(o.toLowerCase()))[0]

      const reward = info.liquidationValue.sub(info.liquidationCost)
      
      const minReward = BigNumber.from(0) // 0% of reward must be recieved in assset after swaps and everything - rest in leftover token - no problem because flashloan liquidation

      let params = {tokenId : position.tokenId, debtShares: position.debtShares, vault: v3VaultContract.address, flashLoanPool, amount0In, swapData0, amount1In, swapData1, minReward, deadline  } 
            
      let useFlashloan = true
      let gasLimit
      try {
        gasLimit = await floashLoanLiquidatorContract.connect(signer).estimateGas.liquidate(params)
      } catch (err) {
        console.log("Error trying flashloan liquidation for " + position.tokenId.toString(), err)

        if (enableNonFlashloanLiquidation) {
          // if there is any error with liquidation - fallback to non-flashloan liquidation
          useFlashloan = false
          params = { tokenId : position.tokenId, amount0Min: BigNumber.from(0), amount1Min: BigNumber.from(0), recipient: signer.address, permitData: "0x", deadline}
          gasLimit = await v3VaultContract.connect(signer).estimateGas.liquidate(params)
        } else {
          throw err
        }
      }
              
      const tx = useFlashloan ? 
                    await floashLoanLiquidatorContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) }) : 
                    await v3VaultContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) })

      position.isExecuting = true 
      const { hash, error } = await executeTx(tx, async (success) => {
          position.isExecuting = false
      })

      if (hash) {
          const msg = `Executing liquidation ${useFlashloan ? "with" : "without" } flashloan for ${getRevertUrlForDiscord(position.tokenId)} with reward of ${ethers.utils.formatUnits(reward, assetDecimals)} ${assetSymbol} - ${getExplorerUrlForDiscord(hash)}`
          console.log(msg)
      } else {
          throw error
      }
    } catch (err) { 
      console.log("Error liquidating position " + position.tokenId.toString(), err)
    }
  } else if (info) {
    // update values if not liquidatable - but estimation indicated it was
    position.isChecking = false
    await updatePosition(position.tokenId)
  }

  position.isChecking = false
}

async function checkAllPositions() {
  console.log("Performing regular check of all positions");
  try {
    for (const position of Object.values(positions)) {
      await checkPosition(position);
    }
  } catch (error) {
    console.error("Error during regular position check:", error);
  }
}

async function run() {
  
  registerErrorHandler()

  asset = (await v3VaultContract.asset()).toLowerCase()
  assetDecimals = await getTokenDecimals(asset)
  assetSymbol = await getTokenSymbol(asset)

  await updateDebtExchangeRate()

  // setup websockets for monitoring changes to positions
  setupWebsocket([
      {
          filter: v3VaultContract.filters.Add(),
          handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
      },
      {
          filter: v3VaultContract.filters.Remove(),
          handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
      },
      {
          filter: v3VaultContract.filters.Borrow(),
          handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
      },
      {
          filter: v3VaultContract.filters.Repay(),
          handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
      },
      {
          filter: v3VaultContract.filters.WithdrawCollateral(),
          handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
      },
      {
          filter: npmContract.filters.IncreaseLiquidity(),
          handler: async (e) => {
            const tokenId = npmContract.interface.parseLog(e).args.tokenId
            if (positions[tokenId]) {
              await updatePosition(tokenId) 
            }
          }
      }
    ], async function(poolAddress) {
   

      const time = new Date()
      // every 5 minutes
      if (time.getTime() > lastWSLifeCheck + 300000) {
          console.log("WS Live check", time.toISOString())
          lastWSLifeCheck = time.getTime()
      }

      // if price reference pool price changed - check all positions with affected token
      const affectedToken = getPoolToToken(asset, poolAddress)
      if (affectedToken) {
        const toCheckPositions = Object.values(positions).filter(p => p.token0 === affectedToken ||  p.token1 === affectedToken)
        for (const position of toCheckPositions) {
            await checkPosition(position)
        }
      }
  })

  await loadPositions()

  setInterval(async () => { await updateDebtExchangeRate() }, 60000)

  // Set up regular interval checks
  const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
  setInterval(checkAllPositions, CHECK_INTERVAL);
}

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  // Close any open connections, stop any ongoing operations
  process.exit(0);
});

run()