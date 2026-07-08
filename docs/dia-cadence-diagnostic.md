# DIA Oracle Cadence Diagnostic — LitVM LiteForge (chain 4441)

**Date:** 2026-07-08
**Branch:** `feat/prediction-market`
**Author:** deployment diagnostic (Step 5a pre-flight)
**Oracle under test:** DIA custom feed `0x49c39225Dbc64700936bb641d1E81113DbadD2DF`
**Surface:** `getValue(string "SYMBOL/USD") returns (uint128 value /*18-dec USD*/, uint128 timestamp /*unix updatedAt*/)`

---

## 1. Why we ran this

The parimutuel prediction stack reads every fund-affecting price through
`SafeAggregatorReader.readFreshPrice(feed, MAX_STALENESS)`. `MAX_STALENESS` is a
compile-time constant of **120 seconds** (`OracleResolvedMarket.sol:68`), applied at three
points: strike capture at market creation, every settlement-window `observe()`, and the
final TWAP freshness gate in `settle()`.

During Step 5a deploy pre-flight, a one-shot read showed most DIA feeds were already
8–26 minutes stale — far outside the 120s window. Before deploying (or widening any
safety parameter), we needed to distinguish two possibilities:

- **(a) Spec-compliant heartbeat, we're just slightly tight.** The feed updates at least
  every ~60–90s regardless of price movement (the stated ~1-minute heartbeat is working),
  and our 120s window is merely a touch too tight → a small config bump would fix it.
- **(b) Heartbeat not firing.** The feed goes many minutes with no update even as time
  passes → it does not match the stated spec → a DIA-side issue to raise, not something a
  contract change should paper over.

The stated DIA spec we are checking against: **0.01% deviation trigger + ~1-minute
heartbeat floor.**

---

## 2. Methodology

- Polled `getValue()` for **BTC/USD, ETH/USD, XRP/USD, LTC/USD, RAIN/USD** every ~15
  seconds for **~23 minutes** (315 samples/asset window; 4–5 distinct updates each).
- Recorded per sample: our wall-clock time, the chain block timestamp, and the feed's
  `(value, updatedAt)`.
- The feed's `updatedAt` is DIA's own reported update time, so the **real** update cadence
  is the set of *distinct* `updatedAt` values, independent of how often we polled. The gap
  between consecutive distinct `updatedAt` values is a true inter-update interval.
- **Max gap = the true heartbeat floor.** A deviation feed can legitimately have long gaps
  during calm markets *only if* a heartbeat still fires as a floor — so the largest observed
  no-update gap is the number that tests the ~1-minute heartbeat claim.

Raw data: [`dia_poll.csv`](./dia_poll.csv) (committed alongside this doc; 315 rows,
`wall,blockTs,asset,value,feedTs`). Poll window `1783482738 → 1783484115` (~22.9 min).

---

## 3. Results — per-asset update intervals

Gaps are measured between consecutive **distinct** on-chain `updatedAt` timestamps.

| Asset    | Distinct updates | Min gap | Typical (median) | **Max gap (heartbeat floor)** |
|----------|:----------------:|:-------:|:----------------:|:-----------------------------:|
| BTC/USD  | 4                | 361s (~6.0m) | 540s (~9.0m) | **1648s (~27.5m)** |
| ETH/USD  | 5                | 359s (~6.0m) | 362s (~6.0m) | **1279s (~21.3m)** |
| XRP/USD  | 5                | 359s (~6.0m) | 362s (~6.0m) | **1742s (~29.0m)** |
| LTC/USD  | 4                | 358s (~6.0m) | 449s (~7.5m) | 453s (~7.5m) |
| RAIN/USD | 0                | — | — | **DEAD — `(0,0)` entire window** |

Two structural observations across all live assets:

1. **Fastest observed cadence ≈ 6 minutes.** The *minimum* gap sits at a strikingly
   consistent **358–362s (~6.0 min)** on every live asset — even while the price was
   actively drifting (e.g. BTC fell ~$65 monotonically across the window). We never once
   observed an update faster than ~6 minutes.
2. **Max no-update gap ≈ 27–29 minutes.** BTC, ETH and XRP each sat **21–29 minutes** with
   no update at all while wall-clock time advanced. The long gaps look like skipped
   multiples of the ~6-min base tick.

### Distinct-update series (evidence)

```
BTC/USD   updatedAt=1783481206  $62,960.353618
          updatedAt=1783482854  $62,955.156743   Δ=1648s (~27.5m)
          updatedAt=1783483215  $62,931.497003   Δ= 361s (~6.0m)
          updatedAt=1783483755  $62,895.367132   Δ= 540s (~9.0m)

ETH/USD   updatedAt=1783481576  $1,759.115299
          updatedAt=1783482855  $1,758.822300    Δ=1279s (~21.3m)
          updatedAt=1783483216  $1,758.189194    Δ= 361s (~6.0m)
          updatedAt=1783483575  $1,756.823934    Δ= 359s (~6.0m)
          updatedAt=1783483937  $1,755.546572    Δ= 362s (~6.0m)

XRP/USD   updatedAt=1783481118  $1.100154
          updatedAt=1783482860  $1.100574        Δ=1742s (~29.0m)
          updatedAt=1783483220  $1.098980        Δ= 360s (~6.0m)
          updatedAt=1783483579  $1.098056        Δ= 359s (~6.0m)
          updatedAt=1783483941  $1.097597        Δ= 362s (~6.0m)

LTC/USD   updatedAt=1783482585  $43.623225
          updatedAt=1783483034  $43.599461       Δ= 449s (~7.5m)
          updatedAt=1783483392  $43.568172       Δ= 358s (~6.0m)
          updatedAt=1783483845  $43.528651       Δ= 453s (~7.5m)

RAIN/USD  updatedAt=0  value=0   (never populated)
```

---

## 4. Verdict

**This is case (b): the heartbeat is not firing anywhere near the stated ~1 minute.**

- A single observed **29-minute** no-update gap (XRP) is categorically incompatible with a
  ~1-minute — or even our 120-second — heartbeat floor. Three of four live assets showed
  gaps of 21–29 minutes.
- The long gaps are **not** "normal calm-market gaps under a working heartbeat," because
  there is no ~1-minute floor holding them up — the floor we observed is ~27–29 minutes.
- The fastest cadence is **~6 minutes**, so there is no ~1-minute deviation response
  either: the price drifted continuously yet never triggered a sub-6-minute update.

Against the stated **0.01% deviation + ~1-min heartbeat** spec, the live feed matches
neither the deviation responsiveness nor the heartbeat floor. Empirically it behaves like a
**~6-minute publish tick with skips**, giving an effective staleness floor of ~30 minutes.

**RAIN/USD is not live at all** — `value=0, timestamp=0` for the entire window, despite
being listed among the finalized symbols. It is not merely stale; it is unpopulated.

---

## 5. Impact on the prediction market

- With `MAX_STALENESS = 120s`, `readFreshPrice` returns `(false, 0)` for essentially every
  asset most of the time. Consequences on-chain:
  - `_createMarket` reverts `FeedUnhealthyAtCreation` → `replenish()` creates 0–1 markets
    instead of a full board across assets.
  - `observe()` reverts `UnhealthySample` on most ticks → the settlement window rarely
    reaches `MIN_SAMPLES = 3` → markets VOID after the 1-hour grace instead of settling.
- Short-timeframe markets (5m / 15m) are **structurally impossible** against a ~6-min-to-
  ~30-min cadence: a 100s (5m) or 300s (15m) settlement window cannot collect 3 healthy,
  min-spaced samples spanning ≥60% coverage when the feed updates at best every ~6 minutes.
  Only the 1h timeframe has any chance, and only with a much wider staleness window.
- `MAX_STALENESS = 120s` is not "slightly tight" — it is ~15× tighter than the feed's
  fastest cadence and ~24× tighter than the observed floor.

## 6. Recommendation

1. **Raise the heartbeat discrepancy with DIA** (see the outreach draft) and get the feed
   fixed to spec, or get the real intended cadence documented. **Preferred** — this is an
   oracle-side gap; do not mask it with a contract change.
2. **Raise RAIN separately** — it is not returning a live value.
3. **Do not deploy Step 5a against this feed as-is.** No contract change was made and
   nothing was deployed as part of this diagnostic.
4. If, after DIA's response, we consciously choose to proceed on a slow feed, widening
   `MAX_STALENESS` (currently a hardcoded constant) is a **money-path change** requiring
   reasoning-first + tests + review, and the timeframe menu would need to drop 5m/15m. That
   is a separate, explicit decision — out of scope for this diagnostic.

---

## Appendix — reproduce

```bash
# from repo root, with .env providing LITVM_RPC_URL
DIA=0x49c39225Dbc64700936bb641d1E81113DbadD2DF
cast call $DIA "getValue(string)(uint128,uint128)" "BTC/USD" --rpc-url "$LITVM_RPC_URL"
# poll loop used for this report: scratchpad poll_dia.sh (15s interval, ~23 min),
# output committed as docs/dia_poll.csv
```
