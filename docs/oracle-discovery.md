# Oracle feed cadence + circuit-breaker pair — discovery findings

**Status:** discovery only (no code). Produced after keeper-smoothness STEP 3.
**Chain:** LitVM LiteForge testnet, chain ID **4441** (Arbitrum Nitro, EVM-equivalent).
**Date of on-chain measurements:** 2026-06-23. All addresses, decimals, and
staleness below were verified on-chain via `cast` against
`https://liteforge.rpc.caldera.xyz/infra-partner-http`.

---

## Tracked follow-up (NON-BLOCKING, external/commercial) — RedStone X / Perpetuals

> **The only path to ~1–2s execution freshness on chain 4441 is RedStone X /
> Perpetuals — a custom, contact-RedStone (commercial) integration.** It uses the
> same deferred-execution signed-calldata pattern we already built (request → execute
> with a fresh signed price), so it would drop into the existing machinery. No free
> public RedStone data-service ID, and no free on-chain push feed on 4441, delivers
> sub-10s freshness today.
>
> **Action (does NOT gate the roadmap):** open a RedStone Discord conversation to
> scope RedStone X for a Caldera/LitVM Nitro testnet — confirm availability, cadence,
> and cost. Treat as an external dependency tracked here; the engine, the
> circuit-breaker, and the keeper all proceed without it. If/when it lands it is a
> latency upgrade to the *primary* execution feed, not a prerequisite for anything.

---

## Why this matters

Our two-step deferred execution gates fills on an **anti-front-run freshness rule**:
the signed price must be stamped at/after `requestTimestamp + MIN_EXECUTION_DELAY`
(`MIN_EXECUTION_DELAY = 3s`; enforced in `PositionManager.executeRequest` via
`_minExecutionTimestamp`, `PositionManager.sol:1870-1874`). Measured in STEP 3, the
keeper's `open→payload` segment (~8–13s, the dominant cost in seen→confirm) is the
keeper *correctly* waiting for RedStone to publish a package whose timestamp crosses
that floor. RedStone `primary-prod` publishes on a **fixed 10s heartbeat** (no
deviation acceleration), so a freshly fetched package lags wall-clock 5–12s. That ~10s
cadence — not the keeper loop — is the real latency floor. This doc surveys whether a
faster feed exists on 4441, and locks the oracle pair for the queued circuit-breaker.

## Headline

There is **no free, drop-in ~1–2s oracle for BTC/ETH on chain 4441 today.**
Counter-intuitively, the RedStone **pull** feed we already use (10s, fetched fresh per
tx) is the **freshest** option on this chain — both on-chain **push** alternatives are
*slower*: DIA runs a 1-hour heartbeat, and LitOracle (~90s when alive) has been
**frozen ~59 days**. So `open→payload` cannot be reduced by swapping to a free push
feed; the only fast-execution lever is RedStone X (above).

## Provider matrix (verified on-chain, 4441)

| | **RedStone primary-prod** (current) | **DIA** | **LitOracle** |
|---|---|---|---|
| Model | **Pull** (signed calldata per tx) | **Push** (on-chain value) | **Push** (on-chain value) |
| Cadence | **10s** fixed heartbeat; **no** deviation accel | **1h** heartbeat + deviation | ~**90s**/round when live |
| Live freshness (measured 2026-06-23) | 5–12s lag, fresh per tx | BTC ~12.7 min / ETH ~22.8 min stale | **frozen ~59 days** (roundId stuck at 6878) |
| Decimals | **1e8** | **1e18** ⚠️ (not 8 — `setDecimals(18)`) | **1e8** |
| Read interface | `getOracleNumericValueFromTxMsg(bytes32)` (calldata) | AggregatorV3 `latestRoundData()` **and** `getValue(string)` | AggregatorV3 `latestRoundData()` (note: `latestAnswer()` reverts) |
| BTC addr (4441) | n/a — id `"BTC"` | adapter `0x7d0445782E383223c7B4B660bb96b87213e9b605` | `0x25B9aEC897909b8da13c3B00b0c7f41B76152589` |
| ETH addr (4441) | n/a — id `"ETH"` | adapter `0xc760B46beF9eD3F9A3d2b825164324D6703F0185` | `0xEc873ccFdb5579b7006EeD61CC7bE42cDC8c2d0b` |
| Other addrs | gateways `oracle-gateway-{1,2}.a.redstone.finance` | push oracle `0xe7f65d4badcfabc4ea57b8f66bba044363d89eec` | aggregator `0x5CD9Ad2C19Ff296316dD3422006883A09535d087` |
| Status | ✅ live, money-path-reviewed | ✅ live but slow | ❌ dead since 2026-04-24 |
| Free on testnet? | Yes | Yes (read) | Yes (read), but stale |

**Concrete staleness hazard (verified):** LitOracle BTC currently returns
**$77,598** — its 59-day-old frozen price — versus RedStone's live ~$64,000. A **21%**
gap from staleness alone. This is the failure mode the circuit-breaker must tolerate
without false-tripping.

## Per-provider notes

### RedStone (pull) — PRIMARY execution feed
- 10s heartbeat is `interval:10000`, hardcoded server-side in the data-service
  manifest; not consumer-configurable. Pull model has **no** deviation-accelerated
  publishing (the manifest `deviationCheck` is an outlier-reject/staleness filter, not
  an early-publish trigger).
- Package timestamp = signing time, on a rounded 10s grid. This is what the
  `requestTs + 3s` rule compares against.
- Numeric values are **8-decimal** (`DEFAULT_NUM_VALUE_DECIMALS = 8`) — our existing
  `price1e8` scaling is correct.
- Sub-2s RedStone exists only as **Bolt** (2.4ms, push, **MegaETH-testnet only** — not
  on 4441) or **RedStone X/Perpetuals** (commercial; see tracked follow-up).

### DIA (push) — SECONDARY (circuit-breaker bound)
- Deployed on 4441 as a `DIAOracleV2` push oracle (`getValue(string)`) fronted by
  per-asset **AggregatorV3** adapters.
- **18 decimals** on this deployment (verified — the adapter source defaults 8 but was
  `setDecimals(18)`; the underlying `getValue` is also 18-dec). **Do not hardcode 8.**
- 1-hour heartbeat + deviation. Verified live-but-slow: BTC ~12.7 min, ETH ~22.8 min
  stale at sample time. Fine as a slow sanity bound; unusable as an execution price.
- No on-chain staleness revert in the asset adapter — the caller must check `updatedAt`.

### LitOracle (push) — preferred SECONDARY *if/when revived*
- Chainlink **AggregatorV3-compatible** (`latestRoundData()`, `decimals()`,
  `description()`; `latestAnswer()` reverts), **8 decimals** (cleaner than DIA — no
  rescale vs RedStone).
- ~90s/round when live, but the entire operator fleet has been **frozen since
  2026-04-24 (~59 days)**; roundId stuck at 6878. No on-chain staleness guard.
- Advertised perp/IV feeds were **not found** on-chain — only spot `PriceFeed`
  contracts are deployed. Do not confuse with the unrelated single-admin
  `ManualPriceFeed` at `0x63352A1eFd3b47DbE7eF4FE91bc5C63908f6E8Bc`.
- **Swap-in candidate:** if operators revive it with a tight heartbeat, it becomes the
  preferred secondary (8-dec AggregatorV3, faster than DIA, independent of RedStone).

---

## Decision — LOCKED for the circuit-breaker (decoupled from feed speed)

The circuit-breaker design does **not** depend on finding a fast feed; it pairs the
fresh execution feed with an independent sanity bound.

- **PRIMARY (execution mark):** **RedStone pull — unchanged.** Freshest on 4441,
  already wired and money-path-reviewed. (Fast-feed upgrade = RedStone X, tracked above,
  non-blocking.)
- **SECONDARY (independent bound):** **DIA push**, read via its AggregatorV3 adapters,
  **normalized ÷1e10 (1e18 → 1e8)**. Used as a **WIDE divergence bound only (~5–10%)**.
  **NEVER** used as an execution or liquidation price.
- **Secondary-staleness = "no opinion":** when DIA is outside its own update window,
  **emit an event and DO NOT halt.** A sleepy feed gets no liveness veto over the money
  path — staleness flags, it does not stop trading.
- **LitOracle = preferred secondary swap-in** if/when its operators revive it (currently
  ~59d stale). 8-dec AggregatorV3, no rescale, independent of RedStone.

**Decimal normalization** (internal convention = `price1e8`):
- RedStone → already 1e8 (no change)
- LitOracle → 1e8 (no change; direct compare)
- DIA → 1e18, **÷ 1e10** to reach 1e8

**Why wide + staleness-tolerant:** a slow secondary makes a tight breaker dangerous
(the LitOracle $77.6k-vs-$64k example diverges 21% from staleness alone). Trip only on
**large** divergence (~5–10%+) when the secondary is **within** its own staleness
window; otherwise hold and flag. This honors "never settle on a stale or single-source
price" without handing a dead feed a halt switch over the money path.

> **Next track:** circuit-breaker build (separate branch/PR). This doc fixes the oracle
> pair so we choose it once.

---

## LOCKED circuit-breaker arming values (durable copy)

These are the breaker arming parameters to set via governance at deploy. Sized from
**28h of reconstructed DIA history**; revisit if a fast secondary (Pyth) lands.

| Asset | `CB_DEV_BPS` (divergence trip) | `CB_SEC_MAXAGE` (secondary staleness window) |
|---|---|---|
| **BTC** | **150** (1.50%) | **6600s** |
| **ETH** | **200** (2.00%) | **6300s** |

---

## LIVE DEPLOYMENT — chain 4441 (2026-06-26)

Full stack redeployed so Governance + exposure caps + request consolidation +
circuit-breaker are live (the prior PM `0xd83a…f5d7` predated all four). Breaker
armed with the locked values above; `CB_GATE_LIQ = 0` (liquidations observe-only);
`MAX_OI` caps dormant (capability shipped, values to be sized/armed later). Smoke:
`scripts/smoke-perps.mjs` full-surface PASS; BTC 7bps / ETH 55bps vs DIA (both fresh,
within band → no trip). Arming reproducible via `scripts/arm-breaker.sh`; runbook in
`docs/stack-redeploy-runbook.md`.

| Contract | Address | Notes |
|---|---|---|
| **Governance** | `0x90365332B2642DCCd3ebC9a976702bA79824970A` | owner = deployer; pause + param store |
| **PositionManager** | `0x9396D36F713302FF39E0bA5b38012656f8E4eACF` | breaker armed; secondary feeds wired |
| **LiquidityPool** | `0x4716a0c9c504F83918002A3086590f1ed192560B` | seeded 100k mUSD; linked one-shot to PM |
| **mUSD (MockERC20)** | `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF` | REUSED (not redeployed) |

Secondary (DIA) feeds wired on the PM: BTC `0x7d0445782E383223c7B4B660bb96b87213e9b605`,
ETH `0xc760B46beF9eD3F9A3d2b825164324D6703F0185` (both 18-dec, normalized ÷1e10).

---

## Sources
- RedStone Pull / Perpetuals / Push docs: https://docs.redstone.finance/docs/dapps/redstone-pull/ , /redstone-perpetuals/ , /redstone-push/
- RedStone Bolt (2.4ms, push, MegaETH-only): https://blog.redstone.finance/2025/04/08/introducing-redstone-bolt-the-fastest-blockchain-oracle-to-date/
- RedStone primary manifest (`interval:10000`) + protocol decimals (`DEFAULT_NUM_VALUE_DECIMALS = 8`): https://github.com/redstone-finance/redstone-oracles-monorepo
- DIA × LitVM: https://www.diadata.org/blog/post/dia-litvm-oracle-integration/
- DIA getValue interface: https://docs.astar.network/docs/build/integrations/oracles/dia/
- LitOracle: https://litoracle.space/ ; LitVM docs: https://docs.litvm.com/
- LiteForge explorer (contract verification): https://liteforge.explorer.caldera.xyz/
- RPC (all on-chain verification): https://liteforge.rpc.caldera.xyz/infra-partner-http (chain 4441)
