# DIA push-oracle cadence — diagnostic (heartbeat fix CONFIRMED)

**Status:** measurement only (no code changed). Read-only poll of the live oracle.
**Chain:** LitVM LiteForge testnet, chain ID **4441**.
**Oracle (push, `getValue`):** `0x49c39225Dbc64700936bb641d1E81113DbadD2DF`
**Interface:** `getValue(string) → (uint128 value /*1e18*/, uint128 timestamp /*unix sec*/)`
**Measured:** 2026-07-17 23:32–23:47 UTC (61 rounds @ 15s ≈ 15 min).
**Supersedes:** the cadence findings in `docs/oracle-discovery.md` (which measured the
*older* DIA push oracle `0xe7f6…9eec` at a **1-hour** heartbeat). This is a **different,
much faster** DIA deployment.

---

## Headline

**DIA's cadence fix is CONFIRMED.** The feed is no longer a 1-hour heartbeat. It now runs
a **~135–140s heartbeat with deviation acceleration** — updates land far faster when price
moves (as tight as **24s**), and re-stamp on the heartbeat even when price is flat. The
worst no-update gap observed across all six assets in 15 min was **174s** (SOL).

This is **heartbeat + deviation**, *not* a fixed interval — proven by the same feed
producing both 24s and 174s gaps, and by flat-price feeds (BTC/ZEC) still re-stamping on a
steady ~133–135s cadence.

Also corrected: **RAIN/USD is LIVE, not dead** — its timestamp advanced 10× over the
window and its price moved. (The asset list should treat RAIN as a live feed.)

---

## Methodology

Same principle as `keeper/scripts/dia-history.mjs` (update-gap = time between distinct
on-chain update stamps), adapted to this oracle's `getValue(string)` push interface:

- Poll `getValue` for each asset every ~15s for ~15 min; record the DIA-reported
  `timestamp` field, the raw `value`, and the block.
- The DIA-reported `timestamp` **is** the exact last-update time, so **distinct
  consecutive timestamps are the true update series** — precise and independent of the
  15s poll grid. Gaps between distinct timestamps = cadence; **MAX gap = heartbeat floor.**
- Caldera RPC is degraded (502/504). Every read was retried with exponential backoff; a
  read that still failed would be logged as a MISS (never a carried/fabricated value) so a
  transient failure can't corrupt the series. **Result: 366/366 reads succeeded, 0 misses.**
- Raw sample artifact: `dia-cadence-raw.csv` (all 366 reads; per-asset distinct-timestamp
  tables reproduced below).

---

## Per-asset summary

| Asset | MAX no-update gap (heartbeat floor) | min gap | typical (median) | distinct updates | price @1e18 | sane? |
|---|---|---|---|---|---|---|
| BTC/USD | **137s** | 109s | 133s | 8 | $63,901.83 | ✅ |
| ETH/USD | **136s** | 65s | 68s | 10 | $1,838.52 | ✅ |
| LTC/USD | **136s** | 45s | 67s | 10 | $45.11 | ✅ |
| SOL/USD | **174s** | 24s | 68s | 10 | $74.94 | ✅ |
| ZEC/USD | **136s** | 111s | 135s | 7 | $542.39 | ✅ |
| RAIN/USD | **160s** | 67s | 131s | 10 | $0.01411 | ✅ |

- **Heartbeat floor ≈ 135–140s** across all feeds; **SOL's 174s is the single widest gap**
  observed. All prices are correctly **18-decimal** (÷1e18 gives clean USD magnitudes; no
  10^x offset). Prices sit on the same basis as the prior discovery epoch (BTC ~$64k).
- **Caveat:** the MAX is the max *observed* in a 15-min window. A longer flat-market
  fallback heartbeat cannot be fully excluded — but BTC and ZEC held essentially flat
  prices the whole window and still never exceeded ~137s, bounding the pure heartbeat
  tightly. Size any staleness parameter against the worst observed (174s) **plus margin**.

## Heartbeat vs. deviation (why the fix is real)

- **Heartbeat, visible on flat feeds:** BTC's price was identical across updates #1–#7 yet
  it re-stamped every ~130–137s. ZEC re-stamped every ~131–136s with a near-flat price.
  That steady re-stamp with no price change **is** the heartbeat (~135s).
- **Deviation acceleration:** when price moved, intervals collapsed well below the
  heartbeat — SOL **24s**, LTC **45s**, ETH **65s**. A fixed cadence cannot produce both
  24s and 174s gaps on the same feed. → **heartbeat + deviation**, confirmed.
- **Liveness:** every feed's timestamp advanced over the window (all "advanced: YES"),
  including RAIN. No frozen feeds.

---

## Raw data — distinct timestamp changes per asset

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

## Conclusion

- **The cadence fix landed.** The DIA push oracle on 4441 now runs a **~135–140s
  heartbeat + deviation acceleration** (worst observed 174s), a ~25× improvement over the
  1-hour heartbeat documented for the older oracle in `docs/oracle-discovery.md`.
- **All six feeds are live and 18-dec-correct.** RAIN/USD is **live** — correct the asset
  list that treated it as dead.
- **Read reliability on the degraded RPC:** 366/366 reads, 0 misses (with retries).

### Implications (do NOT set params on this doc alone)

- The `CB_SEC_MAXAGE` staleness floors locked in `docs/oracle-discovery.md`
  (BTC 6600s / ETH 6300s) were sized against the **old 1-hour** oracle and are now far too
  loose — this feed permits **minutes, not hours**. Re-size against the worst observed
  (174s) plus margin before arming.
- **Prediction-market settlement caveat:** the settlement collector requires the feed to be
  *fresh within `MAX_STALENESS = 120s`* per sample — but this feed's heartbeat floor is
  **135–174s, i.e. *above* 120s**. That guarantees a stale dead-zone every heartbeat cycle
  where `observe()` reverts, which interacts with the 60%-coverage gate on short settlement
  windows. See the settlement sample-coverage analysis (separate report) before setting
  timeframe windows or `MAX_STALENESS`.
