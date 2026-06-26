# Stack-redeploy runbook (chain 4441)

**Status:** STEP 0 discovery — review before executing. No deploy/tx has run.
**Why:** the deployed PositionManager `0xd83a…f5d7` predates Governance, exposure
caps, request consolidation, and the circuit-breaker. One batched redeploy brings
all four live; then the breaker is armed with the locked values.

Each step is a discrete, copy-pasteable command so execution is mechanical and
resumable if the Codespace drops. Run from repo root `/workspaces/perps-litvm/perps-litvm`.

## Pre-flight (once)
```bash
cd /workspaces/perps-litvm/perps-litvm
set -a; source .env; set +a            # exports keys/addresses for all node + cast steps
cast wallet address "$DEPLOYER_PRIVATE_KEY"          # confirm deployer
cast balance "$(cast wallet address "$DEPLOYER_PRIVATE_KEY")" --rpc-url "$LITVM_RPC_URL"  # zkLTC for gas
forge test && forge fmt --check        # green tree before deploying
```

## STEP 1 — Deploy the fresh stack
```bash
forge script script/DeployProdStack.s.sol:DeployProdStack \
  --rpc-url "$LITVM_RPC_URL" --broadcast | tee /tmp/redeploy.log
```
Deploys, in order: **Governance(deployer)** → **LiquidityPool(mUSD,…,governance)**
→ **PositionManager(pool, governance)** → `pool.setPositionManager(PM)` (one-shot
link) → seed 100k mUSD LP. mUSD `0x4Aeda…2dEF` is **reused** (asserted by symbol
check). BTC+ETH markets are seeded in the PM constructor — no market re-seed.

## STEP 2 — Capture + verify new addresses
```bash
GOV=$(jq -r '.transactions[]|select(.contractName=="Governance")|.contractAddress'    broadcast/DeployProdStack.s.sol/4441/run-latest.json)
POOL=$(jq -r '.transactions[]|select(.contractName=="LiquidityPool")|.contractAddress' broadcast/DeployProdStack.s.sol/4441/run-latest.json | head -1)
PM=$(jq -r '.transactions[]|select(.contractName=="PositionManager")|.contractAddress' broadcast/DeployProdStack.s.sol/4441/run-latest.json | head -1)
echo "GOV=$GOV  POOL=$POOL  PM=$PM"
# Wiring asserts (all must match):
cast call "$PM"   "governance()(address)" --rpc-url "$LITVM_RPC_URL"   # == $GOV
cast call "$POOL" "governance()(address)" --rpc-url "$LITVM_RPC_URL"   # == $GOV
cast call "$POOL" "positionManager()(address)" --rpc-url "$LITVM_RPC_URL" # == $PM
cast call "$PM"   "asset()(address)" --rpc-url "$LITVM_RPC_URL"        # == mUSD 0x4Aeda…2dEF
cast call "$GOV"  "owner()(address)" --rpc-url "$LITVM_RPC_URL"        # == deployer
```

## STEP 3 — Re-point every client at the new addresses
Update these keys (mUSD unchanged everywhere; **GOVERNANCE_ADDRESS is new**):

| File | Keys to change |
|---|---|
| `.env` (root) | `LIQUIDITY_POOL_ADDRESS`, `POSITION_MANAGER_ADDRESS`, **add** `GOVERNANCE_ADDRESS` |
| `frontend/.env` | `VITE_LIQUIDITY_POOL_ADDRESS`, `VITE_POSITION_MANAGER_ADDRESS` |
| `frontend/.env.example` | same two (committed defaults — keep in sync) |
| `keeper/.env` | `POSITION_MANAGER_ADDRESS` (keeper doesn't use pool/gov) |
| `keeper/.env.example` | `POSITION_MANAGER_ADDRESS` (committed default) |

No client has a **hardcoded** contract address — `smoke-perps.mjs`,
`create-request.mjs`, `keeper.mjs`, `frontend/src/config.js` all read from env.
`scripts/read-price.mjs` targets the standalone **PriceReader** and is unaffected.
```bash
# root .env
sed -i "s|^LIQUIDITY_POOL_ADDRESS=.*|LIQUIDITY_POOL_ADDRESS=$POOL|"   .env
sed -i "s|^POSITION_MANAGER_ADDRESS=.*|POSITION_MANAGER_ADDRESS=$PM|" .env
grep -q '^GOVERNANCE_ADDRESS=' .env && sed -i "s|^GOVERNANCE_ADDRESS=.*|GOVERNANCE_ADDRESS=$GOV|" .env || echo "GOVERNANCE_ADDRESS=$GOV" >> .env
# frontend/.env
sed -i "s|^VITE_LIQUIDITY_POOL_ADDRESS=.*|VITE_LIQUIDITY_POOL_ADDRESS=$POOL|"   frontend/.env
sed -i "s|^VITE_POSITION_MANAGER_ADDRESS=.*|VITE_POSITION_MANAGER_ADDRESS=$PM|" frontend/.env
# keeper/.env
sed -i "s|^POSITION_MANAGER_ADDRESS=.*|POSITION_MANAGER_ADDRESS=$PM|" keeper/.env
# re-export for the rest of this session
set -a; source .env; set +a
```

## STEP 4 — Re-seed
- **mUSD:** reuse `0x4Aeda…2dEF`. Faucet (`faucet()`, 10k/8h) and public `mint`
  still work — fund the trader for the smoke test.
- **LP liquidity:** auto-seeded (100k) by STEP 1.
- **Markets / RedStone:** BTC+ETH seeded in constructor; RedStone is pull (no
  on-chain signer config). Nothing to do.
- **Old PM positions:** abandoned by design (testnet) — no migration.
```bash
TRADER=$(cast wallet address "${TRADER_PRIVATE_KEY:-$DEPLOYER_PRIVATE_KEY}")
cast send 0x4AedaB95d41A31f891EE12d13CD77102705e2dEF "mint(address,uint256)" "$TRADER" 50000ether \
  --rpc-url "$LITVM_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

## STEP 5 — Arm the circuit-breaker
```bash
bash scripts/arm-breaker.sh                  # dry print — review the cast sends
ARM_BROADCAST=1 bash scripts/arm-breaker.sh  # send them
```
Sets per-market DIA secondary feeds + packed `CB_PARAMS` (BTC band 150 / age 6600,
ETH band 200 / age 6300). `CB_GATE_LIQ` left at 0 → liquidations observe-only.
Verify:
```bash
cast call "$GOV" "getParam(bytes32)(uint256)" \
  "$(cast keccak "$(cast abi-encode 'x(string,bytes32)' 'CB_PARAMS' "$(cast format-bytes32-string BTC)")")" \
  --rpc-url "$LITVM_RPC_URL"   # expect 2245863621678193858858272409049670195609750
```

## STEP 6 — Smoke test
```bash
node scripts/smoke-perps.mjs                 # full-surface on-chain smoke (uses root .env)
# optional: drive the keeper end-to-end
( cd keeper && node scripts/create-request.mjs open BTC )   # then run keeper.mjs to fill
```
Done when the full-surface smoke passes and a breaker `getParam` read returns the
armed packed value. THEN proceed to PR-11 (frontend) / commit the re-pointed env +
docs on a `stack-redeploy` branch.
