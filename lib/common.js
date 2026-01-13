const axios = require('axios');
const ethers = require("ethers");
const univ3prices = require('@thanpolas/univ3prices')
const Mutex = require('async-mutex').Mutex
const mutex = new Mutex()
const fs = require('fs')

const { AlphaRouter, SwapType } = require('@uniswap/smart-order-router')
const { Token, CurrencyAmount, TradeType, Percent, ChainId } = require('@uniswap/sdk-core')

const mode = "LIQUIDATOR"
const network = process.env.NETWORK
const exchange = process.env.EXCHANGE || "uniswap-v3"

function isAerodromeVault() {
    return exchange === "aerodrome" && network === "base"
}

const IERC20_ABI = require("../contracts/IERC20.json")
const POOL_ABI = require("../contracts/IUniswapV3Pool.json")
const FACTORY_RAW = require("../contracts/IUniswapV3Factory.json")
const NPM_RAW = require("../contracts/INonfungiblePositionManager.json")
const AERODROME_NPM_ABI = require("../contracts/IAerodromeNPM.json")

const BigNumber = ethers.BigNumber

const Q32 = BigNumber.from(2).pow(32)
const Q64 = BigNumber.from(2).pow(64)
const Q96 = BigNumber.from(2).pow(96)

const genericPoolContract = new ethers.Contract(ethers.constants.AddressZero, POOL_ABI)

// cache for price pools used to estimate token value in ETH
const pricePoolCache = {}

const observationCardinalityIncreases = {}

// current prices are stored here
const prices = {}

const provider = new ethers.providers.JsonRpcProvider(process.env["RPC_URL_" + network.toUpperCase()])
const privateProvider = process.env["PRIVATE_RPC_URL_" + network.toUpperCase()] ? new ethers.providers.JsonRpcProvider(process.env["PRIVATE_RPC_URL_" + network.toUpperCase()]) : provider

// Support separate private key for Aerodrome liquidator, falls back to default
const privateKey = isAerodromeVault()
    ? (process.env["PRIVATE_KEY_LIQUIDATOR_AERODROME"] || process.env["PRIVATE_KEY_" + mode])
    : process.env["PRIVATE_KEY_" + mode]
const signer = new ethers.Wallet(privateKey, provider)
const privateSigner = new ethers.Wallet(privateKey, privateProvider)

const npmAbi = isAerodromeVault() ? AERODROME_NPM_ABI : NPM_RAW.abi
const npmContract = new ethers.Contract(getNPMAddress(), npmAbi, provider)

// current ws provider, is replaced on disconnect
let wsProvider;

// last nonce
let lastNonce;
const pendingTxs = {};

// gas price for tx execution
async function getGasPriceData() {
    if (network == "mainnet" || network == "arbitrum") {
        // mainnet EIP-1559 handling
        const { maxFeePerGas, maxPriorityFeePerGas } = await provider.getFeeData()
        return { maxFeePerGas, maxPriorityFeePerGas }
    } else {
        return { gasPrice: await provider.getGasPrice() }
    }
}

// executes transaction and does checking until it is really executed
// IMPORTANT this method must not be called in parallel because of nonce handling
async function executeTx(tx, callback) {
    const release = await mutex.acquire()
    try {
        let nonce
        // first time load nonce
        if (!lastNonce) {
            nonce = await provider.getTransactionCount(signer.address)
        } else {
            nonce = lastNonce + 1
        }
        const gasPriceData = await getGasPriceData()
        tx = { ...tx, ...gasPriceData, nonce }

        // set pending tx - BEFORE sending because sending may fail (in this case will be resent)
        pendingTxs[nonce] = tx
        lastNonce = nonce
        setTimeout(async () => await checkTx(nonce, signer, 0, callback), 10000)

        const result = await privateSigner.sendTransaction(tx)

        return { hash: result.hash }
    } catch (err) {
        console.log(err)
        await callback(false)
        return { error: err }
    } finally {
        release();
    }
}

// gets all logs for a given filter (works only on alchemy for now)
// this method should help us avoid
// creating subgraphs for each small contract
async function getAllLogs(filter) {
    const logs = []
    const currentBlock = await provider.getBlockNumber()
    
    let fromBlock = 0 //240513631
    const chunkSize = 10000000 // Process 10k blocks at a time
    
    while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + chunkSize - 1, currentBlock)
        
        try {
            console.log(`Fetching logs from block ${fromBlock} to ${toBlock}`)
            
            const events = await provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                ...filter
            })
            
            logs.push(...events)
            console.log(`Found ${events.length} events, total: ${logs.length}`)
            
            // Move to next chunk
            fromBlock = toBlock + 1
            
        } catch (err) {
            if (err.code === 'SERVER_ERROR' && err.body && err.body.includes('query returned more than')) {
                // If we hit the 10k result limit even with 10k blocks, 
                // that block range has too many events. Try smaller chunks.
                console.log(`Too many results in blocks ${fromBlock}-${toBlock}, trying smaller chunks`)
                
                // Try with 1000 block chunks instead
                const smallerToBlock = Math.min(fromBlock + 999, currentBlock)
                const events = await provider.getLogs({
                    fromBlock: fromBlock,
                    toBlock: smallerToBlock,
                    ...filter
                })
                
                logs.push(...events)
                fromBlock = smallerToBlock + 1
                
            } else {
                throw err
            }
        }
    }
    
    console.log(`Finished loading logs. Total events: ${logs.length}`)
    return logs
}

function getDummyTx(nonce) {
    return { value: 0, nonce, to: ethers.utils.AddressZero }
}

async function checkTx(nonce, signer, intents, callback) {
    try {
        // confirmed tx count
        const currentNonce = await provider.getTransactionCount(signer.address)

        console.log("Checking nonce", nonce, "current", currentNonce, "intent", intents)

        if (currentNonce > nonce) {
            console.log("Tx with nonce", nonce, "complete")
            
            delete pendingTxs[nonce]

            // call callback with true if tx was executed
            await callback(intents <= 3)

            return
        } else if (currentNonce === nonce) {

            // replace it with current gas price - same nonce
            const gasPriceData = await getGasPriceData()

            console.log("Replacing tx with gas", gasPriceData)

            // after 3 intents - give up - try cheap dummy tx to free up nonce
            const txToSend = intents < 3 ? pendingTxs[nonce] : getDummyTx(nonce)
            const newTx = { ...txToSend, ...gasPriceData }

            intents++

            const result = await signer.sendTransaction(newTx)

            console.log("Replacement TX for nonce " + nonce + " " + result.hash)
        } else {
            // keep timeout there are other tx before this one
        }
    } catch (err) {
        // if error happens same hash is checked later on
        console.log("error in checkTx", nonce, intents, err)
    }
    setTimeout(async () => await checkTx(nonce, signer, intents, callback), 10000)
}

async function findPricePoolForTokenCached(address) {

    if (pricePoolCache[address]) {
        return pricePoolCache[address]
    }

    const minimalBalanceETH = BigNumber.from(10).pow(18)
    let maxBalanceETH = BigNumber.from(0)
    let pricePoolAddress = null
    let isToken1WETH = null

    const nativeTokenAddress = getNativeTokenAddress()
    const nativeToken = new ethers.Contract(nativeTokenAddress, IERC20_ABI, provider)

    for (let fee of [100, 500, 3000, 10000]) {
        const candidatePricePoolAddress = await getPool(address, nativeTokenAddress, fee)
        if (candidatePricePoolAddress > 0) {
            const poolContract = new ethers.Contract(candidatePricePoolAddress, POOL_ABI, provider)

            const balanceETH = (await nativeToken.balanceOf(candidatePricePoolAddress))
            if (balanceETH.gt(maxBalanceETH) && balanceETH.gte(minimalBalanceETH)) {
                pricePoolAddress = candidatePricePoolAddress
                maxBalanceETH = balanceETH
                if (isToken1WETH === null) {
                    isToken1WETH = (await poolContract.token1()).toLowerCase() == nativeTokenAddress;
                }
            }

        }
    }

    pricePoolCache[address] = { address: pricePoolAddress, isToken1WETH }

    return pricePoolCache[address]
}

async function getTokenDecimals(token) {
    const tokenContract = new ethers.Contract(token, IERC20_ABI, provider)
    return await tokenContract.decimals()
}

async function getTokenSymbol(token) {
    const tokenContract = new ethers.Contract(token, IERC20_ABI, provider)
    return await tokenContract.symbol()
}

async function getPoolPrice(poolAddress, force) {
    let price = prices[poolAddress]
    if (!force && price) {
        return price
    }
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider)
    const slot0 = await poolContract.slot0()
    prices[poolAddress] = { tick: slot0.tick, sqrtPriceX96: slot0.sqrtPriceX96 }
    return prices[poolAddress]
}

async function getPool(token0, token1, fee) {
    const factoryContract = new ethers.Contract(getFactoryAddress(), FACTORY_RAW.abi, provider)
    const poolAddress = await factoryContract.getPool(token0, token1, fee)
    return poolAddress.toLowerCase()
}

function getAerodromeFactoryAddress() {
    return "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"
}

async function getAerodromePool(token0, token1, tickSpacing) {
    const factoryContract = new ethers.Contract(
        getAerodromeFactoryAddress(),
        ['function getPool(address,address,int24) view returns (address)'],
        provider
    )
    const poolAddress = await factoryContract.getPool(token0, token1, tickSpacing)
    return poolAddress.toLowerCase()
}

function toEthersBigInt(ca) {
    return ethers.utils.parseUnits(ca.toFixed(), ca.currency.decimals)
}

async function quoteUniversalRouter(tokenIn, tokenOut, tokenInDecimals, tokenOutDecimals, amountIn, recipient, slippageX10000, deadline, feeX10000, feeRecipient) {

    const chainId = getChainId(network)

    const router = new AlphaRouter({ chainId: chainId, provider: provider })

    const inputToken = new Token(chainId, tokenIn, tokenInDecimals, 'I', 'I')
    const outputToken = new Token(chainId, tokenOut, tokenOutDecimals, 'O', 'O')

    const inputAmount = CurrencyAmount.fromRawAmount(inputToken, amountIn.toString())

    // collect all used pools
    const pools = []

    // get quote from smart order router
    const route = await router.route(
        inputAmount,
        outputToken,
        TradeType.EXACT_INPUT,
        {
            type: SwapType.UNIVERSAL_ROUTER,
            recipient: recipient,
            slippageTolerance: new Percent(slippageX10000, 10000),
            deadline: deadline
        },
        { 
            protocols: ["V3"]
        }
    )

    // subtract fee from output token amount - if present
    let commands = "0x"
    let inputs = []

    const universalRouterAddress = getUniversalRouterAddress()

    for (const routePart of route.route) {
        const routeTypes = []
        const routeData = []
        for (const [i, token] of routePart.tokenPath.entries()) {
            if (i > 0) {
                routeTypes.push("uint24")
                routeData.push(routePart.route.pools[i - 1].fee)
            }
            routeTypes.push("address")
            routeData.push(token.address)
        }

        pools.push(...(routePart.poolAddresses || routePart.poolIdentifiers))

        const packedRoute = ethers.utils.solidityPack(routeTypes, routeData)
        const amountIn = toEthersBigInt(routePart.amount)
        const amountOutMin = toEthersBigInt(routePart.quote).mul(10000 - slippageX10000).div(10000)

        // exact input command
        commands += "00"

        inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "uint256", "uint256", "bytes", "bool"], [universalRouterAddress, amountIn, amountOutMin, packedRoute, false]));
    }

    let amountFee = ethers.BigNumber.from(0)
    let amountOut = toEthersBigInt(route.quote)

    if (feeX10000 > 0) {
        // add fee transfer command for input token
        amountFee = amountOut.mul(feeX10000).div(10000) // estimate amount fee here - depends on the swap
        commands += "06"
        inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenOut, feeRecipient, feeX10000]))
    }


    // sweep commands for input and output tokens
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenIn, recipient, 0]))
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenOut, recipient, 0]))


    const data = getUniversalRouterSwapData(commands, inputs, deadline)

    return {
        amountIn: amountIn,
        amountFee: amountFee,
        amountOut: amountOut.sub(amountFee),
        amountOutMin: amountOut.mul(10000 - slippageX10000).div(10000),
        data: data,
        pools: pools
    }
}

function getUniversalRouterSwapDataSinglePool(tokenIn, tokenOut, fee, amountIn, amountOutMin, recipient, deadline) {
    let commands = "0x"
    let inputs = []

    const packedRoute = ethers.utils.solidityPack(["address", "uint24", "address"], [tokenIn, fee, tokenOut])

    // exact input command
    commands += "00"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "uint256", "uint256", "bytes", "bool"], [recipient, amountIn, amountOutMin, packedRoute, false]));

    // sweep command for input token (if not all swapped)
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenIn, recipient, 0]))

    const data = getUniversalRouterSwapData(commands, inputs, deadline)

    return { data }
}

function getUniversalRouterSwapData(commands, inputs, deadline) {
    const universalRouterAddress = getUniversalRouterAddress()
    const universalRouterData = ethers.utils.defaultAbiCoder.encode(["tuple(bytes,bytes[],uint256)"], [[commands, inputs, deadline]])
    return ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [universalRouterAddress, universalRouterData])
}

function sqrt(bn) {
    x = BigNumber.from(bn)
    let z = x.add(1).div(2)
    let y = x
    while (z.sub(y).isNegative()) {
        y = z
        z = x.div(z).add(z).div(2)
    }
    return y
}

function getChainId() {
    return {
        "mainnet": ChainId.MAINNET,
        "polygon": ChainId.POLYGON,
        "optimism": ChainId.OPTIMISM,
        "arbitrum": ChainId.ARBITRUM_ONE,
        "bnb": ChainId.BNB,
        "evmos": 9001,
        "base": ChainId.BASE
    }[network];
}

function getNativeTokenAddress() {
    return {
        "mainnet": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "polygon": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        "optimism": "0x4200000000000000000000000000000000000006",
        "arbitrum": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        "bnb": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        "evmos": "0xd4949664cd82660aae99bedc034a0dea8a0bd517",
        "base": "0x4200000000000000000000000000000000000006"
    }[network];
}
function getNativeTokenSymbol() {
    return network === "evmos" ? "EVMOS" : (network === "polygon" ? "MATIC" : (network === "bnb" ? "BNB" : "ETH"))
}
function getFactoryAddress() {
    return {
        "mainnet": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "polygon": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "optimism": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "arbitrum": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "bnb": (exchange === "uniswap-v3" ? "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7" : "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
        "evmos": "0xf544365e7065966f190155f629ce0182fc68eaa2",
        "base": "0x33128a8fc17869897dce68ed026d694621f6fdfd"
    }[network];
}
function getNPMAddress() {
    if (isAerodromeVault()) {
        return "0x827922686190790b37229fd06084350E74485b72"
    }
    return {
        "mainnet": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "polygon": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "optimism": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "arbitrum": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "bnb": (exchange === "uniswap-v3" ? "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613" : "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
        "evmos": "0x5fe5daaa011673289847da4f76d63246ddb2965d",
        "base": "0x03a520b32c04bf3beef7beb72e919cf822ed34f1"
    }[network];
}
function getUniversalRouterAddress() {
    return {
        "mainnet": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        "polygon": "0x643770E279d5D0733F21d6DC03A8efbABf3255B4",
        "optimism": "0xeC8B0F7Ffe3ae75d7FfAb09429e3675bb63503e4",
        "arbitrum": "0x5E325eDA8064b456f4781070C0738d849c824258",
        "bnb": "0xeC8B0F7Ffe3ae75d7FfAb09429e3675bb63503e4",
        "evmos": "",
        "base": "0x6fF5693b99212Da76ad316178A184AB56D299b43"
    }[network];
}
function getV3VaultAddress() {
    if (isAerodromeVault()) {
        return "0x22ce292d882c7799183949509b011512352454cb"
    }
    return {
        "mainnet": "0xa2754543f69dC036764bBfad16d2A74F5cD15667",
        "polygon": "",
        "optimism": "",
        "arbitrum": "0x74e6afef5705beb126c6d3bf46f8fad8f3e07825",
        "bnb": "",
        "evmos": "",
        "base": "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599"
    }[network];
}
function getFlashLoanLiquidatorAddress() {
    return {
        "mainnet": "0xa44080F20464de260e25F35A69d6BDa50f2cc79D",
        "polygon": "",
        "optimism": "",
        "arbitrum": "0x5b94d444dfba48780524a1f0cd116f8a57bfefc2",
        "bnb": "",
        "evmos": "",
        "base": "0x6BCB1Ae7b3aec6086066dC4348dc679C93eeAC5b"
    }[network];
}

function getRevertUrlForDiscord(id) {
    const exchangeName = isAerodromeVault() ? "aerodrome-position" :
                         (network === "evmos" ? "forge-position" :
                         (exchange === "pancakeswap-v3" ? "pancake-position" : "uniswap-position"))
    return `<https://revert.finance/#/${exchangeName}/${network}/${id.toString()}>`
}

function getExplorerUrlForDiscord(hash) {
    const url = {
        "mainnet": "https://etherscan.io/tx/",
        "polygon": "https://polygonscan.com/tx/",
        "optimism": "https://optimistic.etherscan.io/tx/",
        "arbitrum": "https://arbiscan.io/tx/",
        "bnb": "https://bscscan.com/tx/",
        "evmos": "https://www.mintscan.io/evmos/tx/",
        "base": "https://basescan.org/tx/"
    }[network]

    return `[${hash}](<${url}${hash}>)`
}

function getFlashloanPoolOptions(asset) {
    return {
        "arbitrum": {
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831": ["0xc6962004f452be9203591991d15f6b388e09e8d0", "0xbe3ad6a5669dc0b8b12febc03608860c31e2eef6", "0xc473e2aee3441bf9240be85eb122abb059a3b57c",
                                                           "0x6f38e884725a116C9C7fBF208e79FE8828a2595F"]

        },
        "base": {
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ["0xd0b53D9277642d899DF5C87A3966A349A798F224", "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef", "0x6c561B446416E1A00E8E93E221854d6eA4171372", 
                                                           "0xD364eb55E17700b54bd75fEB3F14582eD7A29444", "0xf1Fdc83c3A336bdbDC9fB06e318B08EadDC82FF4"]
        },
        "mainnet": {
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35", 
                                                           "0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168", "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
                                                           "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8", "0x9a772018FbD77fcD2d25657e5C547BAfF3Fd7D16"]
        }
    }[network][asset];
}
function getTokensToPools(asset) {
    return {
        "arbitrum": {
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
                "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { // DAI with USDC
                    address: "0x7cf803e8d82a50504180f417b8bc7a493c0a0503",
                    isToken0: true
                },
                "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { // WETH with USDC
                    address: "0xc6962004f452be9203591991d15f6b388e09e8d0",
                    isToken0: false
                },
                "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { // WBTC with USDC
                    address: "0x0e4831319a50228b9e450861297ab92dee15b44f",
                    isToken0: false
                },
                "0x912ce59144191c1204e64559fe8253a0e49e6548": { // ARB with USDC
                    address: "0xb0f6ca40411360c03d41c5ffc5f179b8403cdcf8",
                    isToken0: false
                },
                "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { // USDC.e with USDC
                    address: "0x8e295789c9465487074a65b1ae9Ce0351172393f",
                    isToken0: true
                },
                "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { // USDT with USDC
                    address: "0xbe3ad6a5669dc0b8b12febc03608860c31e2eef6",
                    isToken0: true
                },
                "0x5979d7b546e38e414f7e9822514be443a4800529": { // wstETH with USDC.e (no USDC pool available)
                    address: "0xc7341e85996eeb05897d3dec79448b6e4ccc09cf",
                    isToken0: false
                }
            }
        },
        "base": {
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { // USDC on Base
                "0x4200000000000000000000000000000000000006": { // WETH with USDC
                    address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
                    isToken0: false
                },
                "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": { // cbBTC with USDC
                    address: "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef",
                    isToken0: true
                }
            }
        },
        "mainnet": {
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { // USDC on Mainnet
                "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { // WETH with USDC
                    address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
                    isToken0: true
                },
                "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { // WBTC with USDC
                    address: "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35",
                    isToken0: false
                },
                "0xdac17f958d2ee523a2206206994597c13d831ec7": { // USDT with USDC
                    address: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
                    isToken0: true
                }
            }
        }
    }[network][asset];
}

// setups websocket for prices and adds reconnection handling
function setupWebsocket(filters, poolChangeCallback) {

    console.log("WS Provider created")

    wsProvider = new ethers.providers.WebSocketProvider(process.env["WS_RPC_URL_" + network.toUpperCase()])

    let pingTimeout = null
    let keepAliveInterval = null

    wsProvider._websocket.on('open', () => {

        console.log("WS Provider connected")

        keepAliveInterval = setInterval(() => {
            wsProvider._websocket.ping()
            pingTimeout = setTimeout(() => {
                try {
                    wsProvider._websocket.terminate()
                } catch (err) {
                    console.log(err)
                    // failed terminating - so its still open - should be ok
                }
            }, 15000)
        }, 7500)

        // if pools (prices) need to be monitored
        if (poolChangeCallback) {
            const filter = genericPoolContract.filters.Swap(null, null)
            filter.address = null
            wsProvider.on(filter, async (...args) => {
                try {
                    const event = args[args.length - 1]
                    const a = genericPoolContract.interface.parseLog(event).args
                    prices[event.address.toLowerCase()] = { tick: a.tick, sqrtPriceX96: a.sqrtPriceX96 }
                    await poolChangeCallback(event.address.toLowerCase())
                } catch (err) {
                    console.log("Error processing swap event", err)
                }
            })
        }

        // add custom filters
        for (const filter of filters) {
            wsProvider.on(filter.filter, async (...args) => {
                const event = args[args.length - 1]
                await filter.handler(event)
            })
        }
    })

    wsProvider._websocket.on('close', () => {

        console.log("WS Provider disconnected")

        clearInterval(keepAliveInterval)
        clearTimeout(pingTimeout)
        setupWebsocket(filters, poolChangeCallback)
    })

    wsProvider._websocket.on('pong', () => {
        clearInterval(pingTimeout)
    })
}

function getAmounts(sqrtPriceX96, lowerTick, upperTick, liquidity) {
    const lowerSqrtPriceX96 = BigNumber.from(univ3prices.tickMath.getSqrtRatioAtTick(lowerTick).toString())
    const upperSqrtPriceX96 = BigNumber.from(univ3prices.tickMath.getSqrtRatioAtTick(upperTick).toString())
    const amounts = univ3prices.getAmountsForLiquidityRange(sqrtPriceX96, lowerSqrtPriceX96, upperSqrtPriceX96, liquidity)
    return { amount0: BigNumber.from(amounts[0].toString()), amount1: BigNumber.from(amounts[1].toString()) }
}

async function getTokenAssetPriceX96(token, asset) {
    if (token === asset) {
        return BigNumber.from(2).pow(96)
    }

    const tokensToPools = getTokensToPools(asset)

    let priceToken = await getPoolPrice(tokensToPools[token].address)
    let priceTokenX96 = priceToken.sqrtPriceX96.mul(priceToken.sqrtPriceX96).div(Q96)
    if (tokensToPools[token].isToken0) {
        priceTokenX96 = Q96.mul(Q96).div(priceTokenX96)
    }

    return priceTokenX96
}


function logWithTimestamp(...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

function getPoolToToken(asset, pool) {
    const tokensToPools = getTokensToPools(asset)
    const lowerCasePool = pool.toLowerCase()
    return Object.keys(tokensToPools).filter(x => tokensToPools[x].address.toLowerCase() === lowerCasePool)[0]
}

module.exports = {
    provider,
    signer,
    npmContract,

    getNativeTokenAddress,
    getNPMAddress,
    getFactoryAddress,
    getV3VaultAddress,
    getFlashLoanLiquidatorAddress,
    getNativeTokenSymbol,
    getFlashloanPoolOptions,
    getTokenAssetPriceX96,
    getRevertUrlForDiscord,
    getExplorerUrlForDiscord,
    isAerodromeVault,
    getAerodromePool,
    getAerodromeFactoryAddress,
    registerErrorHandler: function () {
        process.on('uncaughtException', (err) => handleGlobalError(err))
        process.on('unhandledRejection', (err) => handleGlobalError(err))

        function handleGlobalError(err) {
            console.log("Global error", err)
        }
    },
    getAmounts,
    getPoolPrice,
    getPool,
    getPoolToToken,
    setupWebsocket,
    executeTx,
    getGasPriceData,
    getAllLogs,
    quoteUniversalRouter,
    getUniversalRouterSwapDataSinglePool,
    getTokenDecimals,
    getTokenSymbol,
    getTickSpacing: function (fee) {
        return fee == 100 ? 1 : (fee == 500 ? 10 : (fee == 3000 ? 60 : (fee == 2500 ? 50 : 200)))
    },
    Q32,
    Q64,
    Q96,
    network,
    exchange,
    sqrt,
    POOL_ABI,
    logWithTimestamp
}