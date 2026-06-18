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

## PR-2 — Liquidity pool (LP vault)  **[CURRENT]**
LPs deposit collateral, mint an LP token, withdraw. The pool is the trader counterparty.
- ERC20 LP token; deposit / withdraw; pool accounting; reentrancy-guarded.

**Acceptance:** deposit/withdraw tested incl. edge cases; pool-share math verified.

## PR-3 — Position management
Open/close long & short with leverage; collateral + size accounting; P&L vs the oracle mark price (via PR-1 oracle).

**Acceptance:** open/close tested for long & short, profit & loss, and leverage bounds.

## PR-4 — Fees & funding rate
Borrow/position fees; periodic funding to balance long/short open interest.

**Acceptance:** funding accrual + fee math tested across simulated time.

## PR-5 — Liquidations
Permissionless, bounty-incentivized liquidation of underwater positions, with a tight oracle freshness check.

**Acceptance:** liquidation triggers at correct thresholds; bounty paid; stale-price liquidation rejected.

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