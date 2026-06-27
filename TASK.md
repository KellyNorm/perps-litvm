# TASK.md — Build Roadmap

## How to use this file
Claude Code: read `CLAUDE.md`, then this file. Work **ONLY** on the task marked **CURRENT**. When done, verify the acceptance criteria, then stop for review and merge. Do not start the next task on your own.

## Definition of Done (every PR)
- Scope limited to the single task.
- `forge test` passes; new tests cover the new behavior.
- `forge fmt` clean.
- Deployed to LitVM testnet (chain 4441) and smoke-validated.
- Squash-merged to `main`; feature branch deleted.

## Setup / prerequisites (one-time — see the ABC)
- Foundry installed (forge, cast, anvil).
- Repo scaffolded with `forge init`.
- Solidity deps: OpenZeppelin contracts, RedStone monorepo (remappings finalized in PR-1).
- JS deps: `@redstone-finance/evm-connector`, `@redstone-finance/sdk`.
- `.env`: `LITVM_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (testnet only), `REDSTONE_DATA_SERVICE=redstone-main-demo`.
- Wallet on chain 4441 funded from the Caldera faucet.

---

## Status — stack redeployed + breaker armed (2026-06-26)
Phase 1 + Phase 2 engine **FEATURE-COMPLETE** — **306 tests passing, 0 failures**, money
path reviewed PR by PR. **Stack REDEPLOYED live on chain 4441 (2026-06-26)** so Governance
+ exposure caps + request consolidation + circuit-breaker are on-chain (the prior PM
`0xd83a…f5d7` predated all four). Full-surface smoke (`scripts/smoke-perps.mjs`) **PASSED**;
all clients re-pointed. Live addresses + runbook in `docs/oracle-discovery.md` (LIVE
DEPLOYMENT section) and `docs/stack-redeploy-runbook.md`:
- Governance `0x90365332B2642DCCd3ebC9a976702bA79824970A`
- PositionManager `0x9396D36F713302FF39E0bA5b38012656f8E4eACF`
- LiquidityPool `0x4716a0c9c504F83918002A3086590f1ed192560B`
- mUSD (reused) `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF`

Breaker armed: BTC 150bps/6600s, ETH 200bps/6300s; `CB_GATE_LIQ`=0 (liquidations
observe-only); MAX_OI caps **dormant** (capability live, values unsized — see
`scripts/arm-breaker.sh` `ARM_MAX_OI`).

**Keeper hosting track CLOSED (2026-06-27):** standalone keeper hosted 24/7 on Railway
with a **dedicated key** `0xCCd1…5748` (no longer the deployer), proven end-to-end —
unattended fills, +0.5 mUSD fee earning, and restart auto-recovery. Details +
launch-gate checklist in `docs/TESTNET_LAUNCH.md`. Next step: **the frontend (PR-11)** —
public Vercel deploy (custom domain + faucet button) and a public-path smoke run as a
non-deployer account.

---

## PHASE 1 — engine core  **(all DONE)**

### PR-1 — PriceReader (oracle smoke test)  **[DONE]**
RedStone pull oracle on `MainDemoConsumerBase`; `getPrice(bytes32 feedId)` returns the
verified value from tx calldata. Foundry test via the mock wrapper for "BTC"/"ETH";
deploy script for chain 4441; JS `DataServiceWrapper` script prints a live price.

### PR-2 — LiquidityPool (LP vault)  **[DONE]**
GLP-style ERC-4626 vault; LPs deposit collateral, mint LP shares, withdraw; pool is the
trader counterparty; reentrancy-guarded; pool-share math verified.

### PR-3 — PositionManager (position management)  **[DONE]**
Open/close long & short with leverage; collateral + size accounting; P&L vs the oracle
mark; O(1) per-market aggregates; reserved-liquidity solvency independent of the cache.

### PR-4a — Borrow fee  **[DONE]**
Time-based borrow fee positions pay the pool for reserved LP capital. Accrued O(1) via a
single shared cumulative index per market (position stores the index at open); continuous
per-second accrual, no keeper ticks. Deducted from payout at close; settles via the
existing `payProfit` / `receiveLoss` entry points (no LP ABI change). Payout floors at 0
when the fee exceeds collateral; the uncollected remainder is left for the bad-debt seam.

### PR-5 — Liquidations  **[DONE]**
Permissionless, bounty-incentivized liquidation of underwater positions, with a tight
oracle freshness check and bad-debt accounting. Stale-price liquidation rejected.

### PR-4b — Funding rate  **[DONE]**
True peer-to-peer funding between longs and shorts driven by open-interest imbalance: the
heavy side pays the light side, routed through the pool as clearing buffer, accrued O(1)
via signed per-side cumulative indices. Rate clamped at the configured max; one-sided book
accrues no funding. Sequenced after PR-5 so the liquidation machinery can bound a payer
who cannot cover accrued funding. The interim "funding-to-pool" variant was NOT built.

### PR-6 — Two-step deferred execution  **[DONE]**  (shipped as 6a / 6b / 6c)
Request/execute split with the price relayed on-chain at execution (RedStone X-model);
permissionless relay; payload-freshness guard closes the front-run exploit.
- **PR-6a** — price-parameterized open/close cores.
- **PR-6b** — two-step deferred execution layer (`requestOpen`/`requestClose` ->
  `executeRequest` -> `cancelRequest`).
- **PR-6c** — removed the direct path; two-step is the only trader entry.

---

## PHASE 2 — trader features  **(all DONE)**

### PR-7 — mUSD faucet  **[DONE]**
Cooldown faucet on the mUSD `MockERC20` collateral token.

### PR-8 — Market registry  **[DONE]**
Owner-extendable market registry (`Ownable`; `addMarket` / `removeMarket`). Admin power
scoped to market listing only.

### PR-9a — Partial close (decrease)  **[DONE]**
Proportional realize on a two-step decrease; the remainder keeps its entry price and
fee/funding indices.

### PR-9b — Increase (add size / collateral)  **[DONE]**
Size-weighted blended entry price + blended fee/funding indices; no mid-life realization.

### PR-10a — Trigger exits (take-profit / stop-loss)  **[DONE]**
Resting Close/Decrease requests behind a price gate; kind-agnostic gate keyed off
`triggers[id]`; `cancelRequest` refunds collateral+fee for Open/Increase.

### PR-10b — Trigger entries (limit / stop open & increase)  **[DONE]**
Additive `requestTriggerOpen` / `requestTriggerIncrease`; reuse the existing fill cores
and the PR-10a gate unchanged — no execution-machinery changes, only the two request
functions + events.

---

## NEXT

### PR-11 — Frontend  **[CURRENT]**  (previously mislabeled "PR-7 Frontend", renumbered)
React/Vite wired to the full contract surface; the browser plays keeper (poll for a fresh
payload -> `executeRequest`); `DataServiceWrapper` payload injection. **Comes AFTER** the
batched redeploy + full-surface on-chain smoke.

**Acceptance:** an end-to-end trade completed from the UI on testnet.

---

## Known gaps / deferred refinements
- **Payload-aware LP pricing — NOT shipped.** `LiquidityPool.totalAssets()` still reads
  the cached aggregate mark (`cachedU`), refreshed only on position open/close, so an LP
  depositing/withdrawing mid-move transacts against a slightly stale share price. The fix
  is payload-aware LP entry/exit (`depositWithPrice` / `withdrawWithPrice`) that verify a
  fresh RedStone price and refresh the mark before pricing shares. Fairness only —
  reserved-liquidity accounting already guarantees solvency independently of the cache.
- **Liquidator bonus** is drawn only from the collateral buffer — full at the maintenance
  threshold, decaying to 0 below ~5% equity and 0 in the bad-debt case. For mainnet
  consider a protocol-funded liquidation incentive or a reserved slice of the buffer so
  late liquidations stay profitable.

## PHASE 3 — mainnet hardening  (deferred, not started)
Governance + pause (params are currently immutable; `Ownable` is scoped to markets only),
per-market exposure caps, oracle fallback / circuit-breaker, production RedStone feed
(replace the free demo data service), insurance fund for bad debt, LP withdrawal cooldown,
auto-deleverage, protocol trading fee, keeper bot, event indexing / subgraph, multi-asset
markets (additional feeds), invariant + fuzz tests, external audit (target builder-program
audit credits), mainnet deploy + TGE.