# DIA push-oracle cadence — diagnostic & derived settlement params (chain 4441)

**Oracle under test:** DIA custom feed `0x49c39225Dbc64700936bb641d1E81113DbadD2DF`
**Surface:** `getValue(string "SYMBOL/USD") → (uint128 value /*18-dec USD*/, uint128 timestamp /*unix updatedAt*/)`
**Chain:** LitVM LiteForge testnet, chain ID **4441**.

This is the consolidated evidence record for the prediction-market oracle. It supersedes and
absorbs the earlier standalone `dia_poll` diagnostic, and it is the "why" behind the settlement
parameters shipped in commit `620767f`. **Read it as one arc**, not three isolated snapshots.

---

## TL;DR — the arc

1. **2026-07-08 — broken.** The feed was **not to spec**: fastest cadence ~6 min, worst
   no-update gap **~29 min**, RAIN/USD dead (`(0,0)`). A 120s staleness window was ~15–24×
   tighter than the feed's real cadence → prediction markets would have voided constantly.
   **Step 5a deploy was blocked**; the discrepancy was raised with DIA rather than papered
   over with a contract change.
2. **DIA shipped a cadence fix.**
3. **2026-07-17 — verified good.** The same oracle now runs a **~135–140s heartbeat +
   deviation acceleration** (as tight as **24s** when price moves; worst observed gap
   **174s** on SOL). **RAIN/USD is now live.** All six feeds 18-dec-correct; 366/366 reads.
4. **Params derived from the verified cadence** (shipped, `620767f`):
   **`MAX_STALENESS = 300s`** (governance-settable, per-market snapshot, bounded `(0, 1h]`),
   timeframe set **15m / 30m / 1h / 24h** (5m removed, 24h settlement window fixed at 30m).

Sizing rule used throughout: **size the staleness window against the worst *observed* gap
(174s) plus headroom, never the vendor's stated spec** — the 07-08 data is exactly why we
don't trust the stated ~1-min heartbeat at face value.

---

# Part A — Original problem (2026-07-08, pre-fix)

**Author:** deployment diagnostic (Step 5a pre-flight). No code changed, nothing deployed.
**Raw data:** [`dia-cadence-raw-2026-07-08.csv`](./dia-cadence-raw-2026-07-08.csv)
(315 rows, `wall,blockTs,asset,value,feedTs`; poll window `1783482738 → 1783484115`, ~22.9 min).

## A.1 Why we ran it

The parimutuel stack reads every fund-affecting price through
`SafeAggregatorReader.readFreshPrice(feed, MAX_STALENESS)`, applied at three points: strike
capture at creation, every settlement-window `observe()`, and the final TWAP freshness gate in
`settle()`. Pre-flight one-shot reads showed most DIA feeds already **8–26 min stale** — far
outside the (then hardcoded) **120s** window. We needed to distinguish:

- **(a)** spec-compliant heartbeat, we're just slightly tight (a small config bump fixes it); vs
- **(b)** heartbeat not firing (a DIA-side gap, not something a contract change should mask).

Stated DIA spec being checked: **0.01% deviation trigger + ~1-minute heartbeat floor.**

## A.2 Method

Polled `getValue()` for **BTC/ETH/XRP/LTC/RAIN /USD** every ~15s for ~23 min. The feed's
`updatedAt` is DIA's own update time, so the real cadence is the set of **distinct** `updatedAt`
values (independent of poll rate); the gap between consecutive distinct values is a true
inter-update interval, and the **max gap = the heartbeat floor** that tests the ~1-min claim.

## A.3 Results — update intervals (distinct `updatedAt` gaps)

| Asset    | Distinct updates | Min gap | Typical (median) | **Max gap (heartbeat floor)** |
|----------|:----------------:|:-------:|:----------------:|:-----------------------------:|
| BTC/USD  | 4 | 361s (~6.0m) | 540s (~9.0m) | **1648s (~27.5m)** |
| ETH/USD  | 5 | 359s (~6.0m) | 362s (~6.0m) | **1279s (~21.3m)** |
| XRP/USD  | 5 | 359s (~6.0m) | 362s (~6.0m) | **1742s (~29.0m)** |
| LTC/USD  | 4 | 358s (~6.0m) | 449s (~7.5m) | 453s (~7.5m) |
| RAIN/USD | 0 | — | — | **DEAD — `(0,0)` entire window** |

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

## A.4 Verdict — case (b): heartbeat not to spec

A single **29-min** no-update gap (XRP) is categorically incompatible with a ~1-min — or even
120s — heartbeat floor; 3 of 4 live assets showed **21–29 min** gaps. The **fastest** cadence was
~6 min even while prices drifted continuously, so there was no ~1-min deviation response either.
Empirically the feed behaved like a **~6-min publish tick with skips → ~30-min effective staleness
floor.** **RAIN/USD** was unpopulated (`(0,0)`), not merely stale.

**Impact then:** at `MAX_STALENESS = 120s`, `readFreshPrice` returned `(false,0)` most of the time
→ `_createMarket` reverts (`FeedUnhealthyAtCreation`), `observe()` reverts (`UnhealthySample`),
settlement windows rarely reach `MIN_SAMPLES = 3` → mass VOID after grace. Short frames (5m/15m)
were **structurally impossible** against a 6–30 min cadence.

**Action taken:** raised the discrepancy with DIA; did **not** widen the money-path staleness to
paper over an oracle-side defect; blocked the Step 5a deploy.

---

# Part B — DIA's fix, verified (2026-07-17, post-fix)

**Status:** read-only measurement, no code changed.
**Measured:** 2026-07-17 23:32–23:47 UTC (61 rounds @ 15s ≈ 15 min).
**Raw data:** [`dia-cadence-raw-2026-07-17.csv`](./dia-cadence-raw-2026-07-17.csv)
(366 reads, `poll_iso,poll_unix,round,block,asset,ok,value_raw,dia_ts,price_1e18`).

## B.1 Headline

**The cadence fix landed.** The same oracle now runs a **~135–140s heartbeat + deviation
acceleration** — updates land as tight as **24s** when price moves, and re-stamp on the heartbeat
even when price is flat. Worst no-update gap across all six assets in 15 min: **174s (SOL)**. This
is **heartbeat + deviation, not a fixed interval** — proven by the same feed producing both 24s
and 174s gaps. **RAIN/USD is now LIVE** (timestamp advanced 10×, price moved).

## B.2 Method

Same distinct-timestamp principle as Part A (and `keeper/scripts/dia-history.mjs`). The Caldera
RPC was degraded (502/504); every read retried with backoff, a hard failure logged as a MISS
(never a carried/fabricated value) so a transient failure can't corrupt the series. **Result:
366/366 reads, 0 misses.**

## B.3 Per-asset summary

| Asset | MAX no-update gap (heartbeat floor) | min | median | distinct | price @1e18 | sane? |
|---|---|---|---|---|---|---|
| BTC/USD | **137s** | 109s | 133s | 8 | $63,901.83 | ✅ |
| ETH/USD | **136s** | 65s | 68s | 10 | $1,838.52 | ✅ |
| LTC/USD | **136s** | 45s | 67s | 10 | $45.11 | ✅ |
| SOL/USD | **174s** | 24s | 68s | 10 | $74.94 | ✅ |
| ZEC/USD | **136s** | 111s | 135s | 7 | $542.39 | ✅ |
| RAIN/USD | **160s** | 67s | 131s | 10 | $0.01411 | ✅ |

- **Heartbeat floor ≈ 135–140s**; **SOL's 174s is the single widest gap.** All prices correct at
  18 decimals (÷1e18 → clean USD magnitudes, no 10^x offset).
- **Caveat:** MAX is the max *observed* in 15 min; a longer flat-market fallback heartbeat can't be
  fully excluded — but BTC and ZEC held flat prices the whole window and never exceeded ~137s,
  bounding the pure heartbeat tightly. **Size params against 174s + margin.**

### Heartbeat vs. deviation (why the fix is real)
- **Heartbeat (flat feeds):** BTC's price was identical across updates #1–#7 yet re-stamped every
  ~130–137s; ZEC re-stamped ~131–136s near-flat. That steady no-price-change re-stamp **is** the
  heartbeat (~135s).
- **Deviation acceleration:** when price moved, intervals collapsed — SOL **24s**, LTC **45s**,
  ETH **65s**. A fixed cadence cannot produce both 24s and 174s on one feed. Post-fix the deviation
  response works and the heartbeat floor sits ~135–140s (still above the *stated* ~60s, but ~13×
  tighter than the 07-08 floor — and we size to the measured number, not the spec).

## B.4 Raw data — distinct timestamp changes per asset

`dia_ts` = DIA-reported update time (unix s); `Δprev` = gap to previous distinct update (s).

```
BTC/USD   #  dia_ts       dia_utc     price(1e18)          Δprev
          0  1784331105   23:31:45    63901.65230570357    -
          1  1784331238   23:33:58    63901.83295547010    133
          2  1784331368   23:36:08    63901.83295547010    130
          3  1784331477   23:37:57    63901.83295547010    109
          4  1784331611   23:40:11    63901.83295547010    134
          5  1784331747   23:42:27    63901.83295547010    136
          6  1784331884   23:44:44    63901.83295547010    137
          7  1784332017   23:46:57    63901.83295547010    133   [flat price, pure heartbeat]

ETH/USD   0  1784331078   23:31:18    1837.2250624180      -
          1  1784331211   23:33:31    1837.3804327500      133
          2  1784331278   23:34:38    1837.5016397957      67
          3  1784331343   23:35:43    1837.6039221942      65
          4  1784331411   23:36:51    1837.7095556422      68
          5  1784331478   23:37:58    1837.9918832500      67
          6  1784331613   23:40:13    1838.1994351813      135
          7  1784331681   23:41:21    1838.2577396355      68
          8  1784331816   23:43:36    1838.3941716732      135
          9  1784331952   23:45:52    1838.5190841732      136

LTC/USD   0  1784331137   23:32:17    45.0529896000        -
          1  1784331204   23:33:24    45.0629825000        67
          2  1784331271   23:34:31    45.0684300000        67
          3  1784331336   23:35:36    45.0779719000        65
          4  1784331403   23:36:43    45.0829511899        67
          5  1784331494   23:38:14    45.0944601750        91
          6  1784331539   23:38:59    45.0979577000        45
          7  1784331674   23:41:14    45.1068355277        135
          8  1784331808   23:43:28    45.1068355277        134
          9  1784331944   23:45:44    45.1067393743        136

SOL/USD   0  1784331146   23:32:26    74.9130217157        -
          1  1784331212   23:33:32    74.9217075156        66
          2  1784331305   23:35:05    74.9317229050        93
          3  1784331479   23:37:59    74.9375070000        174   <- widest gap observed
          4  1784331503   23:38:23    74.9385523596        24    <- tightest gap observed
          5  1784331547   23:39:07    74.9401170261        44
          6  1784331614   23:40:14    74.9415937657        67
          7  1784331682   23:41:22    74.9415937657        68
          8  1784331817   23:43:37    74.9426705172        135
          9  1784331954   23:45:54    74.9426705172        137

ZEC/USD   0  1784331168   23:32:48    542.3728550056       -
          1  1784331299   23:34:59    542.3728550056       131
          2  1784331430   23:37:10    542.3728550056       131
          3  1784331541   23:39:01    542.3893179095       111
          4  1784331676   23:41:16    542.3893179095       135
          5  1784331811   23:43:31    542.3893179095       135
          6  1784331947   23:45:47    542.3893179095       136

RAIN/USD  0  1784331036   23:30:36    0.0141006227         -
          1  1784331169   23:32:49    0.0141011223         133
          2  1784331300   23:35:00    0.0141011223         131
          3  1784331431   23:37:11    0.0141011223         131
          4  1784331542   23:39:02    0.0141036206         111
          5  1784331678   23:41:18    0.0141050666         136
          6  1784331838   23:43:58    0.0141056192         160
          7  1784331905   23:45:05    0.0141072741         67
          8  1784331973   23:46:13    0.0141081677         68
          9  1784332040   23:47:20    0.0141111826         67
```

---

# Part C — Params derived from the verified cadence (shipped `620767f`)

The 07-17 cadence is what these values are sized against. Full reasoning lived in the
settlement sample-coverage analysis; this is the durable record of the decisions.

## C.1 `MAX_STALENESS = 300s`

- **Was:** a hardcoded `120s` constant — *below* the feed's own heartbeat floor (135–174s), which
  guaranteed a stale "dead-zone" every heartbeat cycle where `observe()` reverts.
- **Now:** **300s**, delivered as a **constructor param + `onlyOwner setMaxStaleness`**, bounded to
  `(0, 1 hours]` in `_setMaxStaleness` (a 0 rejects every price; the 1-hour cap stops a
  fat-fingered value from making a very stale price look "fresh").
- **Why 300:** 300 > 174 ⇒ the dead-zone collapses to **0** (the feed is always fresh between
  updates), so every timeframe clears the 60%-coverage gate with the same margin. 300 gives ~1.7×
  headroom over the noisiest single observed gap (174s) — deliberately not sized to the 180s edge,
  because the 07-08 data warns a brief window can under-sample the true floor. Still ~21× tighter
  than the old circuit-breaker `CB_SEC_MAXAGE` (6300–6600s). Governance can tighten toward ~200s
  once days (not minutes) of data exist.
- **Per-market snapshot:** each market snapshots `maxStaleness` at creation (`Market.maxStaleness`,
  like `feed`/`strike`/`feeBps`); `observe()`/`settle()` read the snapshot. A later tighten can
  therefore **never retroactively invalidate a live market's already-valid sample set and void it**
  — it only governs new markets.

## C.2 Timeframe set → 15m / 30m / 1h / 24h (5m removed)

| Timeframe | betWindow (lock) | settlement window | total life |
|---|---|---|---|
| 15m | 600s | 300s | 15m |
| 30m | 1200s | 600s | 30m |
| 1h | 2400s | 1200s | 1h |
| 24h | 84600s | **1800s (fixed 30m)** | 24h |

- **5m removed** at all four factory sites (constant, `_windows`, `_select` modulus, force-short
  fallback). Even at 300s staleness, a 100s settlement window is too thin to reliably clear 3
  samples spanning ≥60% coverage. `_windows` now reverts `BadTimeframe` on any out-of-set index —
  no silent fallthrough to a default.
- **24h settlement window is fixed at 1800s (30m)**, decoupled from the ⅔/⅓ ratio (which would be
  an **8h** window). An 8h window would store thousands of observations that `settle()` loops over
  (gas/DoS risk → an unsettleable market) and would demand 8h of continuous keeper sampling on a
  502/504-prone RPC. 1800s clears coverage ~12× while cutting keeper/gas exposure ~16×.

## C.3 Related follow-ups
- `docs/oracle-discovery.md` measured a **different, older** DIA push oracle (`0xe7f6…9eec`) at a
  **1-hour** heartbeat, and locked `CB_SEC_MAXAGE` (BTC 6600s / ETH 6300s) against it. Those
  circuit-breaker floors are now far too loose for the `0x49c3…D2DF` feed (minutes, not hours) and
  should be re-sized against 174s + margin before arming.
- **RAIN/USD** was dead on 07-08 and live on 07-17 — any asset list that still treats RAIN as dead
  needs correcting.

---

## Appendix — reproduce

```bash
# from repo root, with .env providing LITVM_RPC_URL
DIA=0x49c39225Dbc64700936bb641d1E81113DbadD2DF
cast call $DIA "getValue(string)(uint128,uint128)" "BTC/USD" --rpc-url "$LITVM_RPC_URL"
# 07-08: 15s poll loop, ~23 min  -> docs/dia-cadence-raw-2026-07-08.csv
# 07-17: 15s poll loop, ~15 min, per-asset distinct-timestamp analysis + retries
#        -> docs/dia-cadence-raw-2026-07-17.csv
```
