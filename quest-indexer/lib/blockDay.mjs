// Which UTC day did this log happen on?
//
// WHY NOT WALL CLOCK. The obvious implementation stamps rows with `new Date()` at index
// time. That is wrong twice over: a catch-up run replaying six hours of backlog would file
// every one of those blocks under today, and a run crossing midnight would file the last
// few minutes of yesterday under today. Both produce rows under the wrong day, which reads
// downstream as "not active" on the day the wallet actually was. The day has to come from
// the BLOCK's own timestamp.
//
// WHY THAT IS NOT SIMPLY "getBlock EVERY LOG". A per-log getBlock is one RPC round trip per
// log, unbounded in the busy case, and almost entirely wasted: on a quiet testnet most runs
// see zero logs, and a run that does see logs almost always sees them all on the same day.
//
// THE STRATEGY, cheapest path first:
//
//   0. NOTHING. No logs in the range → no calls at all. This is the common case and it is
//      why resolution is lazy: nothing here runs until a range actually yields a log.
//   1. RANGE SHORTCUT (2 calls). Fetch the timestamps of the range's first and last block.
//      If they fall on the same UTC day then — given monotonic timestamps — every block
//      between them does too, so every log in the range gets that day and we stop.
//   2. DISTINCT LOG BLOCKS (n calls). Only blocks that actually produced a log need a day,
//      and there are usually a handful. Deduped.
//   3. BOUNDARY BISECTION (~log2(span) calls). If step 2 would cost more than the bisection
//      would, binary-search the exact block where the day flips and attribute by comparison.
//      Bounded by the range span, not by the log count.
//
// MONOTONICITY IS THE ASSUMPTION under steps 1 and 3. Arbitrum Nitro clamps L2 block
// timestamps so they never decrease, so it holds here. It is CHECKED rather than trusted:
// if the endpoints come back out of order we fall through to step 2, which needs no such
// assumption. Being wrong about this would silently misfile a day, so it is not a comment.
//
// UNRESOLVABLE MEANS FAIL THE RUN. A null block from a pruned or inconsistent node must
// never degrade to "skip this log" — that leaves a permanent hole under a watermark that
// claims to cover it. Every function here throws rather than guessing.

/** YYYY-MM-DD in UTC, from a unix-seconds block timestamp. Matches utcDay() in cache.js. */
export function dayFromTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`block timestamp is not a unix time: ${JSON.stringify(seconds)}`);
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Build a resolver for one indexing run.
 *
 * @param {(block: number) => Promise<{timestamp: number} | null>} getBlock
 * @param {object} [opts]
 * @param {number} [opts.maxPerBlockLookups] force the step-2/step-3 choice instead of
 *   estimating it. Mainly a test seam; see bisectionCost() for why estimating beats a
 *   constant.
 */
export function createBlockDayResolver(getBlock, { maxPerBlockLookups = null } = {}) {
  // Memoised across sources: four sources scan the SAME block range in a run, so the
  // endpoint timestamps and any bisection are fetched once, not four times.
  const timestamps = new Map();
  let calls = 0;

  async function timestampOf(block) {
    if (timestamps.has(block)) return timestamps.get(block);

    calls++;
    const header = await getBlock(block);
    // Null is what a pruned or lagging node returns for a block it cannot serve. Treating
    // it as "unknown day, skip the log" is exactly the silent hole this module refuses.
    if (!header || typeof header.timestamp !== "number") {
      throw new Error(`getBlock(${block}) returned no timestamp — cannot date this range`);
    }

    timestamps.set(block, header.timestamp);
    return header.timestamp;
  }

  return {
    /** Diagnostics: how many getBlock calls this run actually paid for. */
    calls: () => calls,

    /**
     * Map every log in [fromBlock, toBlock] to its UTC day.
     *
     * @returns {Promise<Map<number, string>>} blockNumber → YYYY-MM-DD, covering exactly
     *   the distinct block numbers present in `logs`. Empty for empty input — and, crucially,
     *   costing zero RPC calls in that case.
     */
    async resolve(logs, { fromBlock, toBlock }) {
      const days = new Map();
      if (!logs || logs.length === 0) return days;

      const blocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => a - b);
      for (const b of blocks) {
        if (!Number.isInteger(b) || b < 0) {
          throw new Error(`log has no usable blockNumber: ${JSON.stringify(b)}`);
        }
      }

      // --- Step 1: the range shortcut. Two calls settle the overwhelming majority of runs.
      const loTs = await timestampOf(fromBlock);
      const hiTs = await timestampOf(toBlock);

      const monotonic = hiTs >= loTs;
      if (monotonic) {
        const loDay = dayFromTimestamp(loTs);
        const hiDay = dayFromTimestamp(hiTs);
        if (loDay === hiDay) {
          // Endpoints share a day and timestamps do not decrease, so the interior cannot
          // escape it. No further calls, however many logs there are.
          for (const b of blocks) days.set(b, loDay);
          return days;
        }

        // --- Step 3: the range straddles midnight. Take whichever of the two is cheaper —
        // estimated, not assumed. A fixed threshold is wrong at both ends: over a narrow
        // range bisection can cost MORE than naming every log-bearing block, and over a
        // wide one it wins long before any round number.
        const threshold = maxPerBlockLookups ?? bisectionCost(fromBlock, toBlock);
        if (blocks.length > threshold) {
          const boundary = await firstBlockOnOrAfterDay(timestampOf, fromBlock, toBlock, hiDay);
          for (const b of blocks) days.set(b, b >= boundary ? hiDay : loDay);
          return days;
        }
      }

      // --- Step 2: name each distinct log-bearing block. Needs no monotonicity assumption,
      // which is also why it is the fallback when the endpoints come back out of order.
      for (const b of blocks) days.set(b, dayFromTimestamp(await timestampOf(b)));
      return days;
    },
  };
}

/** Lookups a bisection over this span will cost: it halves each step, so log2(span). */
export function bisectionCost(fromBlock, toBlock) {
  return Math.ceil(Math.log2(Math.max(toBlock - fromBlock, 2)));
}

/**
 * Lowest block in (lo, hi] whose UTC day is `targetDay`.
 *
 * Correct only under monotonic timestamps, which the caller has already checked. Costs
 * ~log2(hi - lo) lookups regardless of how many logs the range contains — which is the
 * whole reason this exists rather than dating each log.
 */
async function firstBlockOnOrAfterDay(timestampOf, lo, hi, targetDay) {
  let low = lo;
  let high = hi;

  // Invariant: day(low) < targetDay, day(high) === targetDay. Narrow until adjacent.
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (dayFromTimestamp(await timestampOf(mid)) >= targetDay) high = mid;
    else low = mid;
  }

  return high;
}
