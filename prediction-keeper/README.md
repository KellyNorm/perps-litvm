# prediction-keeper

Standalone, **isolated** keeper for the parimutuel prediction market on LitVM
LiteForge (chain 4441). It is a **separate service** from the perp keeper
(`keeper/`): its own file, its own key, its own Railway service, its own nonce
space. It imports nothing from `keeper/` and touches no contract. A crash, gas
exhaustion, or nonce stall here cannot affect the perp keeper.

Unlike the perp keeper, the prediction stack reads DIA prices **on-chain** through
per-asset adapters, so this keeper injects **no oracle payload** — it just sends
plain, permissionless calls.

## What it does

Every ~10s it polls the factory (`PREDICTION_FACTORY_ADDRESS`) over HTTP and drives
the three permissionless entrypoints:

| call | when | gas |
|------|------|-----|
| `replenish()` | **gated:** only when `active < 7` **or** `open == 0` | explicit **20,000,000** |
| `observe(id)` | market is in its settlement window `[tLock, tExpiry)`, ≥10s since its last sample | explicit 500,000 |
| `settle(id)`  | market is past `tExpiry` and not yet resolved | explicit 3,000,000 |

Before every send it **static-probes** the call and only sends if it would land, so
the routine benign reverts (feed briefly stale, `ObservationTooSoon`, `AwaitGrace`)
cost a read, not a failed tx and a burned nonce.

Market discovery is a local live-set: on start it scans `marketCount()` once, then
each tick ingests only the new tail and drops markets it sees reach `Settled`/`Void`;
a full re-scan every `PREDICTION_RECONCILE_MS` self-heals. HTTP polling (not
WebSocket) is deliberate — prediction windows are minutes long, so latency doesn't
matter and polling survives a flaky socket.

## The gas gotcha — why explicit limits, never estimation

`eth_estimateGas` / `getFeeData` return **502/504 routinely** on this RPC, and
`replenish()` has **variable cost** (it reaps expired markets *and* fills the board
in one call). A keeper that leans on estimation will intermittently get a bad/low
estimate, **OOG, and silently fail to maintain the board** — no markets opened, no
obvious error unless you check the receipt `status`.

So **every** send uses an explicit `gasLimit` **and** an explicit `gasPrice` (one
deliberate `getGasPrice()` at startup with a hardcoded fallback; never per-tx
`getFeeData`), and we always check `receipt.status === 1`. A cold `replenish()` that
opened 7 markets from empty used **~1.2–1.28M gas**; the 20,000,000 limit gives
~16× headroom to absorb reap-heavy calls. Over-providing is free on LitVM (you pay
only `gasUsed`). See `docs/prediction-deploy.md` for the observed numbers.

## `addAsset` needs no feed — config can't be bricked by a quiet feed

`addAsset` reads only `decimals()`, never a price, so wiring an asset can't be
blocked by a slow/stale feed. Freshness gating lives only in market **creation**
(`replenish` → `SafeAggregatorReader`): a quiet feed just gets skipped for new
markets and resumes automatically when fresh — it never reverts `replenish` or
bricks the registry.

## Void expectation under the CURRENT DIA cadence (~140s)

> The old ~6–29 min cadence has been **fixed**. Verified cadence is now a
> **~135–140s heartbeat floor**, **174s worst observed**, deviation-accelerating to
> **~24s** when the price moves.

A market settles (rather than VOIDs) when `settle()` can build a valid TWAP:
**≥ 3 samples** (`MIN_SAMPLES`) spanning **≥ 60%** of the settlement window
(`MIN_COVERAGE_BPS = 6000`), each sample fresh within **`maxStaleness = 300s`**.

**Freshness is now a non-issue.** Every DIA publish lands within ≤174s < 300s, so
observations are essentially always healthy — the keeper can place a sample almost
any time in the window. The binding constraint is therefore **coverage**, not
staleness (the reverse of the old regime).

**Re-derivation (D = 0, quiescent price → cadence at the heartbeat floor P ≈ 140s).**
Worst case, the first *fresh* sample can arrive up to one heartbeat `P` after
`tLock`, and the last up to one heartbeat `P` before `tExpiry`, so the usable sample
span is `≥ W − 2P` over a window `W`. Coverage clears when

```
W − 2P ≥ 0.60 · W   ⇒   0.40 · W ≥ 2P   ⇒   W_min = 5·P
```

With `P ≈ 140s`, **`W_min ≈ 700s`** (≈ 870s at the 174s worst case). Against the
factory's settlement windows:

| timeframe | settle window `W` | vs `W_min≈700s` (P=140) | verdict |
|-----------|-------------------|--------------------------|---------|
| 15m | 300s  | below | tight — void-prone only while the price is fully quiet |
| 30m | 600s  | ~at   | marginal quiescent; clears with any movement |
| 1h  | 1200s | above | **clears comfortably** |
| 24h | 1800s | above | **clears comfortably** |

And `D = 0` is the worst case: any price movement trips DIA's deviation trigger,
collapsing `P` toward ~24s and `W_min` toward ~120s — at which point **every**
timeframe, 15m included, clears easily. So under the fixed cadence, routine VOIDs
are confined to fully-quiescent 15m markets; 1h/24h settle reliably. This is a
night-and-day improvement over the old regime, where `W_min = 5·(360…1740s) =
1800…8700s` exceeded *every* window and forced near-universal VOID.

The keeper's job is to observe as often as spacing allows to maximise coverage; it
cannot manufacture ticks, so a quiescent-15m VOID is **correct contract behavior**,
not a keeper failure.

## Economics — this keeper is a net spender

`replenish`/`observe`/`settle` carry **no bounty** and `feeBps = 0`, so this keeper
**earns nothing** — it only spends zkLTC on gas. Keep its account funded; it logs a
`WARN low balance` below `PREDICTION_MIN_BALANCE` (default 0.002 zkLTC). This is why
`replenish` is gated rather than called every tick.

## Run

```bash
cd prediction-keeper
cp .env.example .env
# generate a DEDICATED key, fund the printed address with zkLTC, paste the key:
cast wallet new
# edit .env -> PREDICTION_KEEPER_PRIVATE_KEY
node prediction-keeper.mjs --once   # read-only smoke: prints the board + planned actions, NO sends
node prediction-keeper.mjs          # run the loop
```

`--once` works even before the key is set (it uses an ephemeral read-only
from-address and never sends), so you can smoke-test the wiring before funding.

## Railway

Create a **new, separate** Railway service pointed at `prediction-keeper/` (do not
reuse the perp keeper's service). `railway.json` is included. Set the env vars from
`.env.example` in the dashboard: `LITVM_RPC_URL`, `PREDICTION_KEEPER_PRIVATE_KEY`,
`PREDICTION_FACTORY_ADDRESS`.

## Isolation checklist (non-negotiable)

- [x] New file / dir — not sharing the perp keeper's code path
- [x] Own key var `PREDICTION_KEEPER_PRIVATE_KEY` (never `KEEPER_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY`)
- [x] Own `.env` (gitignored), own `package.json`, own `railway.json`
- [x] Own Railway service → independent process, independent nonce space
- [x] No contract changes
