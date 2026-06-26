# Testnet launch — hosted keeper (Railway)

Durable runbook for hosting the standalone keeper that fills `executeRequest` on
chain 4441 and earns the 0.5 mUSD per-fill fee. **No secrets in this file** — the
keeper private key lives ONLY in Railway's secret store.

## Service shape
- Root dir: `keeper/` — standalone Node service, `type: module`, no build step.
- Start command: `node keeper.mjs` (also `npm start`; pinned in `keeper/railway.json`).
- Node: **20–22** (pinned via `engines` in `keeper/package.json`; local dev runs v24).
- Restart-on-crash: `restartPolicyType: ON_FAILURE`, 10 retries (`keeper/railway.json`).
- Deps installed by Railway from `keeper/package.json` (ethers v5 + RedStone SDK).

## Keeper account policy
- **Dedicated throwaway key**, holds only gas zkLTC, earns testnet mUSD fees.
- NEVER the deployer (`0xE9Dd…2292`, owns governance/pool) and NEVER a personal key.
- `executeRequest` is **permissionless** (any caller earns the fee) — the fresh key
  needs no on-chain authorization. Verified: a fill from the dedicated key earned
  0.5 mUSD on-chain.
- Fund it with a little zkLTC for gas (one fill ≈ 0.000004 zkLTC; net-positive).

## Railway secret list (Variables tab)
Required:

| Key | Value |
|---|---|
| `LITVM_RPC_URL` | `https://liteforge.rpc.caldera.xyz/infra-partner-http` |
| `KEEPER_PRIVATE_KEY` | *(the dedicated keeper key — paste into Railway only, never the repo)* |
| `POSITION_MANAGER_ADDRESS` | `0x9396D36F713302FF39E0bA5b38012656f8E4eACF` |
| `MUSD_ADDRESS` | `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF` |
| `REDSTONE_DATA_SERVICE` | `redstone-primary-prod` |

Optional (code defaults shown — set only to override):

| Key | Default |
|---|---|
| `KEEPER_WS_URL` | `wss://liteforge.rpc.caldera.xyz/infra-partner-ws` |
| `KEEPER_WS_FALLBACK` | `wss://liteforge.rpc.caldera.xyz/ws` |
| `START_BLOCK` | unset (attaches at head) |
| `KEEPER_LOOP_MS` | `2500` |
| `KEEPER_CATCHUP_MS` | `30000` |

NOT needed by the keeper: `GOVERNANCE_ADDRESS`, `LIQUIDITY_POOL_ADDRESS`,
`DEPLOYER_PRIVATE_KEY`, `TRADER_PRIVATE_KEY` (it reads only PM + mUSD).

## Dashboard steps (to run when ready — NOT yet executed)
1. New Project → Deploy from GitHub repo → select `perps-litvm`.
2. Service settings → **Root Directory** = `keeper`.
3. Variables → add the Required keys above (paste `KEEPER_PRIVATE_KEY` value here only).
4. Deploy. Start command + restart policy come from `keeper/railway.json`.
5. Watch logs for `keeper account: 0x…  (dedicated — earns the fill fee)` then
   `heartbeat — … fills N, fees earned …`.

## Hands-off verification (after deploy)
- From the TRADER account (separate key, no nonce clash with the keeper):
  `node keeper/scripts/create-request.mjs open BTC` → prints a requestId.
- Confirm the **hosted** keeper discovers and fills it (`RequestExecuted`, fee +0.5)
  with nothing running locally.
- Restart test: redeploy / crash the Railway service, confirm it comes back and
  resumes filling (the active set is reconstructed from the on-chain id counter).
