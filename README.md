# Liquidator-js

An open-source implementation of a simple liquidation bot for Revert Lend. This bot is designed to perform liquidations and also to serve as an example implementation for developers interested in building similar tools.

## Overview

This bot monitors active positions on the Revert Lend protocol and executes liquidations when certain conditions are met. It uses a combination of WebSocket connections and periodic checks to stay updated on the state of the positions and the market.

Key features:

- **WebSocket Monitoring**: Listens to real-time events from the Uniswap contracts to update positions as their underlying value changes.
- **Periodic Position Checks**: Regularly checks all positions at set intervals.
- **Flashloan Liquidations**: Executes liquidations using flashloans, requiring no upfront capital in the asset being liquidated.
- **Non-Flashloan Liquidations**: Optionally supports liquidations without flashloans if the liquidator holds the necessary USDC and has approved the V3Vault contract.

Revert Lend contract is currently deployed on Arbitrum only:

- [Revert Lend Contract on Arbiscan](https://arbiscan.io/address/0x74e6afef5705beb126c6d3bf46f8fad8f3e07825)

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- An Ethereum-compatible wallet with sufficient ETH on Arbitrum
- Access to Arbitrum RPC endpoints (both HTTP and WebSocket)

### Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/revert-finance/liquidator-js.git
   cd liquidator-js
   ```

2.	**Install Dependencies**
   ```bash
  	npm install
   ```

3. **Create a `.env` File**

   Before running the script, create a `.env` file in the root directory with the following configurations:

   ```dotenv
   PRIVATE_KEY_LIQUIDATOR=your_private_key_here
   RPC_URL_ARBITRUM=your_arbitrum_rpc_url_here
   WS_RPC_URL_ARBITRUM=your_arbitrum_websocket_url_here
   NETWORK=arbitrum
   ```

4. **Optional: Non-Flashloan Liquidations**

   To enable non-flashloan liquidations:

   - Deposit the required amount of USDC into your liquidator account.
   - Approve the V3Vault contract to spend your USDC.

     ```javascript
     // Example approval script (ensure to customize token addresses and amounts)
     const USDC_CONTRACT = new ethers.Contract(USDC_ADDRESS, IERC20_ABI, signer);
     await USDC_CONTRACT.approve(V3_VAULT_ADDRESS, ethers.constants.MaxUint256);
     ```

## Running the Bot

Start the bot by running:

```bash
node index.js
```

## How It Works

### Monitoring Positions

The bot maintains an internal cache of active positions by:

- Loading all active positions on startup.
- Listening to events (`Add`, `Remove`, `Borrow`, `Repay`, `WithdrawCollateral`, `IncreaseLiquidity`) to update positions in real-time.

### Checking Positions

Positions are checked for liquidation opportunities in two ways:

1. **Event-Driven Checks**: When swap events on monitored uniswap pools are detected via WebSocket, the bot checks the affected positions immediately.
2. **Periodic Checks**: Every 15 minutes, the bot performs a full scan of all positions to ensure no opportunities are missed with the swap events strategy.

### Liquidation Process

When a position is eligible for liquidation:

- The bot estimates the liquidation value and prepares the necessary swap data using the Uniswap Universal Router.
- **Flashloan Liquidations**: The bot uses a flashloan to perform the liquidation without needing upfront USDC.
- **Non-Flashloan Liquidations**: If enabled, the bot can perform liquidations using its own USDC balance.


## Configuration Options

A few options can be configured in the `index.js` file:

- `positionLogInterval`: Interval for logging low collateral factors (default is every 1 minute).
- `enableNonFlashloanLiquidation`: Set to `true` to enable non-flashloan liquidations (default is `false`).
- `CHECK_INTERVAL`: Interval for periodic position checks (default is every 15 minutes).

## Important Notes

- **Gas Fees**: Ensure your liquidator account has enough ETH on Arbitrum to cover gas fees.
- **Security**: Keep your private keys secure. Do not share or commit them to version control.
- **Dependencies**: The bot relies on several external services (e.g., RPC providers). Ensure your connections are reliable.

## Additional Resources

- **Revert Lend Documentation**: [Docs](https://docs.revert.finance/revert/revert-lend)


## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License.

---

*Disclaimer: Use this bot responsibly and at your own risk. The maintainers are not responsible for any financial losses incurred.*
