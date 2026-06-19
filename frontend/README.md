# TachyonFi — frontend (PR-11a, read-only foundation)

React + Vite (plain JSX) trading UI for the perps DEX on LitVM LiteForge (chain 4441).
This PR is **read-only**: every number is wired to chain or the RedStone live mark —
no mock data, no synthetic chart history. The only write is the mUSD faucet.

## Run

```bash
cd frontend
cp .env.example .env      # addresses already point at the chain-4441 deploy
npm install
npm run dev               # http://localhost:5173
```

Loads **without a wallet** (reads go through a `JsonRpcProvider` on `VITE_RPC_URL`).
Connecting an injected wallet (MetaMask) is only needed for balances, your positions,
and the faucet; if the wallet isn't on 4441 the UI prompts `wallet_addEthereumChain`
with the LiteForge params.

## Config (`.env`, gitignored)

`VITE_RPC_URL`, `VITE_CHAIN_ID=4441`, `VITE_MUSD_ADDRESS`,
`VITE_LIQUIDITY_POOL_ADDRESS`, `VITE_POSITION_MANAGER_ADDRESS`,
`VITE_REDSTONE_DATA_SERVICE=redstone-main-demo`. Read via `import.meta.env`.
**Never** put a private key here.

## Notes

- ABIs in `src/abi/*.json` are copied verbatim from the Foundry artifacts in `../out`.
  Regenerate after a redeploy (copy the `abi` field of `out/<C>.sol/<C>.json`).
- Market keys are `bytes32(symbol)` — exactly how `PositionManager.sol` encodes
  `MARKET_BTC`/`MARKET_ETH` (see `src/lib/marketKey.js`). Only markets returning
  `supportedMarkets == true` are shown (BTC/ETH today).
- Engine math (funding/day, borrow/day, liq price, uPnL, health) mirrors
  `PositionManager.sol`; see `src/lib/engine.js`.
- Prices come from the RedStone pull oracle (`redstone-main-demo`), same fetch/decode
  as `scripts/smoke-perps.mjs`. The chart **accumulates** from polls (sparse → fills).
