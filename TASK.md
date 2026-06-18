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

## PR-1 — Oracle smoke test  **[DONE]**
Goal: prove the RedStone pull flow works on LitVM before any perps logic exists.
- Scaffold the Foundry project + finalize remappings for RedStone + OpenZeppelin.
- A minimal contract extending `MainDemoConsumerBase` exposing `getPrice(bytes32 feedId)` returning the verified value from tx calldata.
- A Foundry test using RedStone's mock wrapper proving the read works for "BTC" and "ETH".
- A deploy script targeting chain 4441.
- A small JS script using `DataServiceWrapper` (`redstone-main-demo`) that calls the deployed contract and prints a live price.

**Acceptance:** test passes; contract deployed to testnet; JS script prints a live BTC price read from the deployed contract.

## PR-2 — Liquidity pool (LP vault)  **[DONE]**
LPs deposit collateral, mint an LP token, withdraw. The pool is the trader counterparty.
- ERC20 LP token; deposit / withdraw; pool accounting; reentrancy-guarded.

**Acceptance:** deposit/withdraw tested incl. edge cases; pool-share math verified.

## PR-3 — Position management  **[DONE]**
Open/close long & short with leverage; collateral + size accounting; P&L vs the oracle mark price (via PR-1 oracle).

**Acceptance:** open/close tested for long & short, profit & loss, and leverage bounds.

## PR: payload-aware LP pricing
Close the LP share-price fairness gap left by PR-3. Today `LiquidityPool.totalAssets()` reads a cached aggregate trader mark (`cachedU`) that is refreshed only on position open/close, so an LP depositing/withdrawing mid-move transacts against a slightly stale share price. Add payload-aware LP entry/exit (e.g. `depositWithPrice`/`withdrawWithPrice`) that verify a fresh RedStone price and refresh the mark before pricing shares. This is a fairness fix only — PR-3's reserved-liquidity accounting already guarantees solvency independently of the cache.

**Acceptance:** LP deposit/withdraw price shares against a fresh oracle mark; tested that mid-move LP entry/exit is not mispriced against the cached mark.

## PR-4a — Borrow fee  **[CURRENT]**
Time-based borrow fee that leveraged positions pay the pool for the LP capital they
reserve. Accrued O(1) via a single shared cumulative index per market (each position
stores the index value at open); continuous per-second accrual via the lazily-updated
index — no keeper ticks. Deducted from the trader's payout at close (trader -> pool).
No change to the deployed `LiquidityPool` ABI; settles via the existing `payProfit` /
`receiveLoss` entry points. Conservative flat rate on notional (see plan §6).

Settlement: profit -> payout = collateral + profit - fee (fee to pool); loss -> payout =
collateral - lossCapped - fee, floored at 0, pool inflow = lossCapped + fee. If the fee
alone exceeds collateral, payout floors at 0 and the uncollected remainder is left for
PR-5 (bad-debt seam) with NO revert/underflow. Pure accrual (time passing, no close)
must not change `totalUnrealizedProfit` or `totalReserved`; pool balance and LP NAV rise
by exactly the collected fee, only on close.

**Acceptance:** borrow-fee accrual + deduction-at-close math tested across simulated time;
payout floored at 0 when fee exceeds collateral; accounting invariants hold; existing PR-3
tests still pass.

## PR-5 — Liquidations
Permissionless, bounty-incentivized liquidation of underwater positions, with a tight oracle freshness check.

**Acceptance:** liquidation triggers at correct thresholds; bounty paid; stale-price liquidation rejected.

## PR-4b — Funding rate  **[AFTER PR-5]**
True peer-to-peer (B1) funding between longs and shorts driven by open-interest imbalance:
the heavy side pays the light side, routed through the pool as clearing buffer, accrued
O(1) via signed per-side cumulative indices. Sequenced AFTER PR-5 because a funding payer
who cannot cover its accrued funding from collateral produces bad debt that only the
liquidation machinery (PR-5) can bound. The interim "funding-to-pool" (B2) variant is
explicitly NOT built.

**Acceptance:** funding direction correct under long-heavy and short-heavy books;
per-step conservation (Σ paid ≈ Σ received, pool residual ≥ 0); rate clamped at the
configured max; one-sided book accrues no funding; deduction/credit at close tested
across simulated time.

## PR-6 — Two-step deferred execution + relayer
Request/execute split; price relayed on-chain at execution (RedStone X-model pattern); permissionless relay.

**Acceptance:** front-running test (execution price unknown at request time) passes; relayer script works on testnet.

## PR-7 — Frontend
Next.js + shadcn on Cloudflare Pages; wallet connect; open/close UI; `DataServiceWrapper` payload injection.

**Acceptance:** an end-to-end trade completed from the UI on testnet.

---

## Backlog (post-MVP, deliberate PRs later)
- Multi-asset markets (additional feeds).
- Keeper hardening / monitoring / alerting.
- Mainnet readiness: audit prep (target builder-program audit credits), production RedStone data service, parameter review, liquidity bootstrapping plan.