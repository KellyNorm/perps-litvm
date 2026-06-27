# Testnet launch — hosted keeper (Railway)

Durable runbook for hosting the standalone keeper that fills `executeRequest` on
chain 4441 and earns the 0.5 mUSD per-fill fee. **No secrets in this file** — the
keeper private key lives ONLY in Railway's secret store.

## ✅ Keeper hosted 24/7 on Railway — PROVEN end-to-end (2026-06-27)
- Dedicated keeper key `0xCCd143E9Ae97E82a178A9E99799c4EA52ff35748` (NOT deployer) —
  funded with gas zkLTC, permissionless `executeRequest` confirmed (needs no on-chain auth).
- Unattended fill proven: req#13 close ETH filled by the hosted keeper
  (tx `0x773377b436259ddc1b9b0fb2d109c0cb9b7156d6b231de3ebf2c4ad922832402`),
  `RequestExecuted.keeper` == dedicated key, local machine idle.
- Fee earning confirmed: +0.5 mUSD per close fill.
- Restart recovery confirmed: manual restart → fresh banner → id-counter backfill +
  WS reconnect → resumes filling (req#14 open BTC, tx
  `0xfdf283109d0e61a34aee430b26195b32db044d951bd757167d9248909f4a59d5`, status 1).
- Live latency 12.4s (seen→open 2.1 / open→payload 9.9 / submit 0.38 / confirm 0.06) —
  floor is oracle (RedStone) cadence, not the keeper.
- Railway config in-repo: root `railway.json` (`node keeper/keeper.mjs`), committed ABI
  under `keeper/abi/`, `ON_FAILURE` restart.

## Testnet launch gates
- [x] Keeper running 24/7 (hosted on Railway, auto-recovers on crash/restart)
- [x] Dedicated keeper key (separate from deployer; funded; fee-earning)
- [ ] Public frontend (Vercel + custom domain + faucet button)
- [ ] Public-path smoke as a non-deployer account (end-to-end trade by a fresh user)

## Service shape (as deployed)
- Railway deploys from the **repo root** (the keeper-only `Root Directory` field was
  not used). Root `railway.json` is authoritative; `keeper/railway.json` is dormant.
- Start command: `node keeper/keeper.mjs` (root `railway.json` + root `package.json`
  `start` script; both point at the keeper entrypoint from root).
- Node: **20–22** (pinned via `engines` in root `package.json`; local dev runs v24).
- Restart-on-crash: `restartPolicyType: ON_FAILURE`, 10 retries (root `railway.json`).
- Deps installed by Railway from the **root** `package.json` (ethers v5 + RedStone SDK).
- ABIs are vendored at `keeper/abi/` (loaded relative to the keeper file), so the host
  needs no Foundry `out/` and never runs `forge build`.

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

## Dashboard steps (EXECUTED 2026-06-27)
1. New Project → Deploy from GitHub repo → select `perps-litvm`.
2. Variables → add the Required keys above (paste `KEEPER_PRIVATE_KEY` value here only).
3. Deploy. Start command + restart policy come from the **root** `railway.json`
   (`node keeper/keeper.mjs`) — Railway builds from the repo root, so no Root Directory
   override is needed.
4. Logs showed `keeper account: 0xCCd1…5748  (dedicated — earns the fill fee)`, chain
   4441, `WS connected`, and `heartbeat — … fills N, fees earned …`.

## Hands-off verification (DONE 2026-06-27)
- From the TRADER account (separate key, no nonce clash with the keeper):
  `node keeper/scripts/create-request.mjs <action> <feed>` → prints a requestId.
- Confirmed the **hosted** keeper discovered and filled it (`RequestExecuted`, fee +0.5)
  with nothing running locally (req#13).
- Restart test passed: manual Railway restart → fresh banner → active set reconstructed
  from the on-chain id counter + WS reconnect → resumed filling (req#14).
