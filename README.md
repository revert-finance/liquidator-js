# liquidator-js

Implementation of a simple liquidator bot for Revert Lend. 

This version uses websocket pool price updates to know when to recheck positions. 

Revert Lend contract is currently deployed on Arbitrum only

https://arbiscan.io/address/0x74e6afef5705beb126c6d3bf46f8fad8f3e07825


## Getting Started

Before running the script create a .env config file with the needed config/secrets.

```
PRIVATE_KEY_LIQUIDATOR=...
RPC_URL_ARBITRUM=...
WS_RPC_URL_ARBITRUM=...
NETWORK=arbitrum
```

PRIVATE_KEY_LIQUIDATOR is the private key for the EAO account which has enough ETH to execute liquidations. For flashloan liquidations no USDC need to be present in the account. To enable non-flashloan liquidations you need to add USDC to the account and approve the V3Vault contract.


Install needed dependencies.
```
npm install
```


## Run the script

```
node index.js
```
