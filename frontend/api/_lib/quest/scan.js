// Budgeted, bounded, backward event scanner — Tier 2's engine.
//
// WHAT IT IS FOR: Tier 1 reads current state, and current state forgets. Positions close,
// stakes are claimed to zero, LP shares are redeemed. The durable record of "this wallet
// did the thing" is the event log, and this walks it.
//
// THREE RULES, IN PRIORITY ORDER:
//
//  1. A POSITIVE IS PROOF AND STOPS THE WALK. One matching log ends the scan immediately —
//     there is nothing more to learn.
//
//  2. A NEGATIVE IS ONLY AN ANSWER IF THE WALK WAS COMPLETE. "Complete" means every source
//     was walked all the way down to its deploy block, no chunk was lost to an error, and
//     every floor was validated. Anything less returns `exhausted`, which the caller must
//     report as INDETERMINATE — never as a proven false.
//
//  3. THE BUDGET IS A CEILING, NOT A TARGET. The function runs under a 30s platform
//     limit; it stops at 12 chunks or ~15s, whichever comes first, and says so.
//
// CHUNK SIZE IS 50,000 BLOCKS — safe, but far slower than the frontend's note implies.
// `src/lib/prediction/participation.js` records 50k ranges returning in ~0.7s. MEASURED
// DIRECTLY on 2026-07-25 against this endpoint, they do not:
//
//     span  filter          time
//     10k   address-only    3.1s / 4.1s
//     50k   address-only    21.1s / 15.8s
//     10k   topic-filtered  3.6s / 3.1s
//     50k   topic-filtered  12.2s / 15.8s
//
// Cost is LINEAR IN SPAN — ~0.3ms/block — and essentially independent of the filter or the
// number of logs returned. So the real throughput is ~3,300 blocks/sec, and the binding
// constraint is TIME_BUDGET_MS, not MAX_CHUNKS: one invocation covers ~50k blocks (~15s),
// i.e. about 4.5 hours of chain history at ~0.32s/block. MAX_CHUNKS is a backstop that
// will not normally be reached.
//
// NOTE ON REACH — READ BEFORE RELYING ON A NEGATIVE. The perps contracts sit ~10M blocks
// below head; a full walk there is ~3,000 seconds of getLogs, two orders of magnitude past
// the 30s function limit. Any wallet whose activity is older than a few hours therefore
// comes back INDETERMINATE, not confirmed-false. That is correct — the cache never hardens
// it and the caller retries — but it means a single invocation CANNOT prove a negative for
// historical activity. Closing that gap needs a resumable cursor across invocations backed
// by durable storage, not a bigger budget.

import { hasCodeAt } from "./chain.js";
import { withRetry } from "../chain/withRetry.js";

/** 50k blocks per eth_getLogs call — measured safe on this RPC. See the note above. */
export const CHUNK_BLOCKS = 50_000;
/** Chunks per verification. 12 × 50k = 600k blocks ≈ 41h of history. */
export const MAX_CHUNKS = 12;
/** Wall-clock ceiling, well under the function's 30s maxDuration. */
export const TIME_BUDGET_MS = 15_000;

/**
 * Walk one or more (contract, filter) sources backward from `head`.
 *
 * Sources are walked in the order given, each descending from head to its own floor, and
 * they SHARE one budget. Order them most-likely-first: if the budget runs out before a
 * later source is reached, the result is `exhausted`, not a false.
 *
 * @param {Array<{contract, filter, floor: number, address?: string, label?: string}>} sources
 * @param {object} opts
 * @param {number} opts.head            block to start from (inclusive)
 * @param {number} [opts.chunkBlocks]
 * @param {number} [opts.maxChunks]
 * @param {number} [opts.timeBudgetMs]
 * @param {() => number} [opts.now]     injectable clock, for deterministic budget tests
 * @param {(source) => Promise<boolean>} [opts.verifyFloor] see FLOOR VALIDATION below
 * @returns {Promise<{found, complete, exhausted, chunksUsed, scannedFrom, scannedDownTo, reason}>}
 */
export async function scanForEvent(sources, opts) {
  const {
    head,
    chunkBlocks = CHUNK_BLOCKS,
    maxChunks = MAX_CHUNKS,
    timeBudgetMs = TIME_BUDGET_MS,
    now = () => Date.now(),
    verifyFloor = defaultVerifyFloor,
  } = opts;

  const startedAt = now();
  let chunksUsed = 0;
  let scannedDownTo = head + 1; // nothing scanned yet
  let hadChunkError = false;
  let ranOutOfBudget = false;

  const budgetSpent = () => chunksUsed >= maxChunks || now() - startedAt >= timeBudgetMs;

  for (const source of sources) {
    let hi = head;

    while (hi >= source.floor) {
      if (budgetSpent()) {
        ranOutOfBudget = true;
        break;
      }

      const lo = Math.max(source.floor, hi - chunkBlocks + 1);
      chunksUsed++;

      try {
        const logs = await withRetry(() => source.contract.queryFilter(source.filter, lo, hi));
        scannedDownTo = Math.min(scannedDownTo, lo);

        // RULE 1: proof. Stop everything.
        if (logs.length > 0) {
          return result({
            found: true,
            complete: true,
            exhausted: false,
            chunksUsed,
            scannedFrom: head,
            scannedDownTo: lo,
            reason: null,
          });
        }
      } catch (err) {
        // withRetry already absorbed the transient case, so this chunk is genuinely lost.
        // A lost chunk is a hole in the coverage: whatever else happens, this scan can no
        // longer prove a negative.
        hadChunkError = true;
        console.error(`[quest] scan chunk ${lo}-${hi} failed${label(source)}:`, err?.message);
      }

      hi = lo - 1;
    }

    if (ranOutOfBudget) break;
  }

  if (ranOutOfBudget || hadChunkError) {
    return result({
      found: false,
      complete: false,
      exhausted: true,
      chunksUsed,
      scannedFrom: head,
      scannedDownTo: Math.min(scannedDownTo, head + 1),
      reason: ranOutOfBudget ? "budget_exhausted" : "chunk_error",
    });
  }

  // FLOOR VALIDATION. Reaching the floor is what turns "found nothing" into "there is
  // nothing" — but only if the floor is really the contract's first block. A floor set too
  // HIGH (stale env after a redeploy, say) would end the walk above the events and
  // manufacture a confident false. One eth_getCode per source, on the negative path only,
  // closes that: if the contract already existed below the floor, the floor is wrong and
  // the answer degrades to indeterminate.
  for (const source of sources) {
    let floorOk;
    try {
      floorOk = await verifyFloor(source);
    } catch (err) {
      console.error(`[quest] floor check failed${label(source)}:`, err?.message);
      floorOk = false; // cannot validate → cannot claim a proven negative
    }

    if (!floorOk) {
      console.error(
        `[quest] floor ${source.floor}${label(source)} is not the contract's first block — ` +
          "refusing to report a proven negative. Check the *_DEPLOY_BLOCK env for this address.",
      );
      return result({
        found: false,
        complete: false,
        exhausted: true,
        chunksUsed,
        scannedFrom: head,
        scannedDownTo,
        reason: "floor_unverified",
      });
    }
  }

  // RULE 2 satisfied: every source walked to a validated floor, no holes. A real negative.
  return result({
    found: false,
    complete: true,
    exhausted: false,
    chunksUsed,
    scannedFrom: head,
    scannedDownTo,
    reason: null,
  });
}

/** Default floor check: the contract must NOT have code in the block before its floor. */
async function defaultVerifyFloor(source) {
  const address = source.address ?? source.contract?.address;
  if (!address) return false;
  if (source.floor <= 0) return true; // genesis floor; nothing can exist below it
  return !(await hasCodeAt(address, source.floor - 1));
}

function label(source) {
  return source.label ? ` (${source.label})` : "";
}

function result(r) {
  // scannedDownTo stays null rather than a nonsense value when no chunk ever landed.
  return { ...r, scannedDownTo: r.scannedDownTo > r.scannedFrom ? null : r.scannedDownTo };
}
