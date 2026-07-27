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
// CHUNK SIZE IS 10,000 BLOCKS, chosen on measurement rather than on the frontend's note.
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
// number of logs returned. Throughput is therefore ~3,300 blocks/sec whatever the chunk
// size, which is exactly why 10k beats 50k here: it buys the SAME coverage in ~3.5s steps
// instead of ~15s ones, so the budget cutoff wastes a third of a chunk rather than most of
// one, and a lost chunk costs a tenth as much coverage.
//
// TIME_BUDGET_MS binds long before MAX_CHUNKS: one invocation covers ~50k blocks (~15s),
// about 4.5 hours of chain history at ~0.32s/block. MAX_CHUNKS is a backstop.
//
// NOTE ON REACH. The perps contracts sit ~10M blocks below head; a full walk there is
// ~3,000 seconds of getLogs, two orders of magnitude past the 30s function limit. ONE
// invocation therefore cannot prove a negative for historical activity — which is why this
// scanner is RESUMABLE. `priorCoverage` carries in the block ranges earlier polls already
// walked; each poll extends them; the verdict is derived from the accumulated total. A deep
// wallet converges indeterminate → confirmed over several polls instead of never.
//
// ============================================================================
// COVERAGE IS THE STATE. THE VERDICT IS DERIVED, NEVER CARRIED.
// ============================================================================
// Nothing in or out of this module stores an answer. `priorCoverage` is a set of intervals
// meaning "these blocks were read and held no matching event" — a fact about work done —
// and `complete` is recomputed from those intervals on EVERY call by
// coverageProvesAbsence(). A missing, malformed, stale-floored or short-of-floor interval
// simply fails that test and the answer degrades to indeterminate. There is no
// representation for "this wallet did nothing", so no bug can persist one.
//
// TWO ENDS ADVANCE PER POLL, in this order and under ONE shared budget:
//
//   PHASE A — close the top gap. head moved since the last poll, so [scanned_from+1 .. head]
//             is unread. Closing it first keeps the coverage a contiguous interval anchored
//             at the CURRENT head, which is what makes a derived false honest as of `head`.
//             All sources close their (small) gaps before any source descends, so a deep
//             source cannot starve a shallow one's gap forever.
//   PHASE B — descend from scanned_to-1 toward the floor, spending whatever budget is left.
//
// CONTIGUITY IS THE WRITER'S JOB (see 0002_quest_cursor.sql). Two rules enforce it here:
//   * a gap that does not fully close does NOT advance scanned_from — the partial work is
//     discarded rather than recorded over a hole;
//   * a lost chunk during descent FREEZES that source's frontier — the walk continues (a
//     positive below a hole is still proof) but nothing below the hole is ever recorded.

import { hasCodeAt } from "./chain.js";
import { withRetry } from "../chain/withRetry.js";

/** 10k blocks per eth_getLogs call — ~3.5s each on this RPC. See the note above. */
export const CHUNK_BLOCKS = 10_000;
/** Backstop only; the time budget is what actually stops a scan. */
export const MAX_CHUNKS = 12;
/**
 * Wall-clock ceiling. THE REAL RUNTIME OVERRUNS THIS by up to one chunk: the budget is
 * checked before a chunk starts, and a chunk already in flight is never abandoned (an
 * abandoned chunk is wasted work AND lost coverage). So the worst case is roughly
 * budget + one slow chunk + retry backoff.
 *
 * Measured at a 15s budget, real scans finished at 16-19s — fine on its own, but the
 * function's ceiling is 30s and a chunk can take ~15s when the RPC is slow, so 15s left
 * no margin against a platform kill (which surfaces as a raw 504, strictly worse than an
 * honest indeterminate). 10s keeps the worst case near ~25s.
 */
export const TIME_BUDGET_MS = 10_000;

/**
 * Stable identity for a source's coverage row. It is the CONTRACT ADDRESS, which is what
 * makes a redeploy self-invalidating: the new address finds no row and starts a fresh walk
 * instead of inheriting coverage of a different contract (0002_quest_cursor.sql).
 */
export function sourceKeyOf(source) {
  const raw = source?.sourceKey ?? source?.address ?? source?.contract?.address ?? "";
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * Is this stored interval usable as coverage for this source?
 *
 * FLOOR COUPLING lives here. A floor is bound to an address (chain.js), and coverage
 * computed against a different floor cannot be trusted: a floor moved DOWN means there is
 * unwalked history below what we covered; a floor moved UP means the walk may have been
 * reading a different contract. Either way the honest move is to discard and re-walk —
 * which costs a few polls of latency and can never cost a wrong answer.
 *
 * Shape is re-checked too, even though the table CHECKs it. This is the last gate before
 * an interval is allowed to count toward a proven negative, and it is cheap.
 */
export function isUsablePrior(prior, source) {
  if (!prior) return false;
  if (prior.floorBlock !== source.floor) return false; // floor moved → coverage is void
  if (!Number.isInteger(prior.scannedFrom) || !Number.isInteger(prior.scannedTo)) return false;
  if (prior.scannedTo < prior.floorBlock) return false; // below the floor is not coverage
  if (prior.scannedTo > prior.scannedFrom) return false; // not an interval
  return true;
}

/**
 * THE DERIVATION. Coverage in, verdict out — the only place a `false` is ever produced.
 *
 * Absence is proven only when EVERY source is covered from its floor up to the CURRENT
 * head, with no source missing and none short:
 *
 *   scannedTo === floor   equality, not <=. scanForEvent clamps every chunk with
 *                         max(floor, …) so a walk cannot go below its floor, and the table
 *                         CHECK refuses to store an interval that claims it did. "Reached
 *                         the floor" is therefore exactly equality; `<=` would let a
 *                         corrupt row buy a proven negative it did not earn.
 *   scannedFrom >= head   the top of the interval must reach the block this answer is
 *                         reported `checkedThroughBlock`. Coverage that stops below head
 *                         says nothing about the blocks in between — where the event could
 *                         well be — so it derives to indeterminate, and the next poll's
 *                         Phase A closes the gap.
 *
 * No sources means nothing was proven, not "proven vacuously".
 */
export function coverageProvesAbsence(sources, coverage, head) {
  if (!Array.isArray(sources) || sources.length === 0) return false;

  return sources.every((source) => {
    const cov = coverage?.[sourceKeyOf(source)];
    if (!cov) return false;
    if (!Number.isInteger(cov.scannedFrom) || !Number.isInteger(cov.scannedTo)) return false;
    return cov.scannedTo === source.floor && cov.scannedFrom >= head;
  });
}

/**
 * Walk one or more (contract, filter) sources backward from `head`, resuming from whatever
 * earlier polls already covered.
 *
 * Sources SHARE one budget. Order them most-likely-first: if the budget runs out before a
 * later source is reached, the result is `exhausted`, not a false. Progress made by ANY
 * source is still returned in `coverage`, so a starved source is only slower, never lost.
 *
 * @param {Array<{contract, filter, floor: number, address?: string, label?: string}>} sources
 * @param {object} opts
 * @param {number} opts.head            block to start from (inclusive)
 * @param {Record<string, {floorBlock, scannedFrom, scannedTo}>} [opts.priorCoverage]
 *        coverage from earlier polls, keyed by sourceKeyOf(). Absent/stale entries are
 *        simply ignored — the walk restarts from head, which is slow, never wrong.
 * @param {number} [opts.chunkBlocks]
 * @param {number} [opts.maxChunks]
 * @param {number} [opts.timeBudgetMs]
 * @param {() => number} [opts.now]     injectable clock, for deterministic budget tests
 * @param {(source) => Promise<boolean>} [opts.verifyFloor] see FLOOR VALIDATION below
 * @returns {Promise<{found, complete, exhausted, chunksUsed, scannedFrom, scannedDownTo,
 *                    coverage: Array<{sourceKey, floorBlock, scannedFrom, scannedTo, dirty}>,
 *                    reason}>}
 */
export async function scanForEvent(sources, opts) {
  const {
    head,
    chunkBlocks = CHUNK_BLOCKS,
    maxChunks = MAX_CHUNKS,
    timeBudgetMs = TIME_BUDGET_MS,
    now = () => Date.now(),
    verifyFloor = verifySourceFloor,
    priorCoverage = null,
  } = opts;

  const startedAt = now();
  let chunksUsed = 0;
  let scannedDownTo = head + 1; // nothing scanned yet
  let hadChunkError = false;
  let ranOutOfBudget = false;

  const budgetSpent = () => chunksUsed >= maxChunks || now() - startedAt >= timeBudgetMs;

  // Working coverage, seeded from the durable rows. `from`/`to` null means "no usable
  // coverage for this source" — the state a fresh wallet, a redeployed address and a
  // failed cursor read all share, and all three correctly walk from head.
  const states = sources.map((source) => {
    const key = sourceKeyOf(source);
    const prior = priorCoverage?.[key];
    const usable = isUsablePrior(prior, source);
    return {
      source,
      key,
      from: usable ? prior.scannedFrom : null,
      to: usable ? prior.scannedTo : null,
      // Set by a lost chunk: the frontier must never advance past a hole.
      frozen: false,
      // Did this poll change anything worth persisting?
      dirty: false,
    };
  });

  /**
   * Walk [floorOfWalk .. hi] descending in chunks, reporting each outcome to `onChunk`.
   * Returns "found" | "done" | "error" | "budget".
   */
  async function walkDown(source, hi, floorOfWalk, onChunk) {
    let cursor = hi;
    let outcome = "done";

    while (cursor >= floorOfWalk) {
      if (budgetSpent()) return "budget";

      const lo = Math.max(floorOfWalk, cursor - chunkBlocks + 1);
      chunksUsed++;

      try {
        const logs = await withRetry(() => source.contract.queryFilter(source.filter, lo, cursor));
        scannedDownTo = Math.min(scannedDownTo, lo);

        // RULE 1: proof. Stop everything.
        if (logs.length > 0) return "found";
        onChunk(lo);
      } catch (err) {
        // withRetry already absorbed the transient case, so this chunk is genuinely lost.
        // A lost chunk is a hole: this scan can no longer prove a negative, and nothing
        // below the hole may be recorded as coverage.
        hadChunkError = true;
        outcome = "error";
        console.error(`[quest] scan chunk ${lo}-${cursor} failed${label(source)}:`, err?.message);
        onChunk(null);
      }

      cursor = lo - 1;
    }

    return outcome;
  }

  const foundResult = () =>
    result({
      found: true,
      complete: true,
      exhausted: false,
      chunksUsed,
      scannedFrom: head,
      scannedDownTo,
      // Deliberately empty. A proven completion is recorded in quest_completion and the
      // cursor for this wallet/quest is never consulted again — persisting the partial
      // interval that happened to be walked on the way would be write traffic for a row
      // nothing will ever read.
      coverage: [],
      reason: null,
    });

  // PHASE A — close the top gap on every source before any source descends.
  for (const st of states) {
    if (st.from === null) continue; // no prior coverage; Phase B starts at head anyway
    if (st.from >= head) continue; // already current

    const out = await walkDown(st.source, head, st.from + 1, () => {});
    if (out === "found") return foundResult();
    if (out === "budget") {
      ranOutOfBudget = true;
      break;
    }
    // Only a FULLY closed gap advances the top. A partial close is discarded: recording it
    // would put a hole inside an interval that later reads count as contiguous.
    if (out === "done") {
      st.from = head;
      st.dirty = true;
    }
  }

  // PHASE B — descend toward the floor with what is left of the budget.
  if (!ranOutOfBudget) {
    for (const st of states) {
      const start = st.to === null ? head : st.to - 1;
      if (start < st.source.floor) continue; // already at the floor; nothing left to walk

      const out = await walkDown(st.source, start, st.source.floor, (lo) => {
        if (lo === null) {
          st.frozen = true;
          return;
        }
        if (st.frozen) return; // below a hole — read, but not contiguous, so not coverage
        // First coverage for this source: the interval is anchored at this poll's head.
        if (st.from === null) st.from = head;
        st.to = lo;
        st.dirty = true;
      });

      if (out === "found") return foundResult();
      if (out === "budget") {
        ranOutOfBudget = true;
        break;
      }
    }
  }

  const coverage = states
    .filter((st) => st.key && st.from !== null && st.to !== null)
    .map((st) => ({
      sourceKey: st.key,
      floorBlock: st.source.floor,
      scannedFrom: st.from,
      scannedTo: st.to,
      dirty: st.dirty,
    }));

  const byKey = Object.fromEntries(coverage.map((c) => [c.sourceKey, c]));
  const proves = coverageProvesAbsence(sources, byKey, head);

  // hadChunkError vetoes even coverage that looks complete. The frozen frontier already
  // makes that combination unreachable; the veto stays because "a hole existed somewhere
  // in this poll" is exactly the condition under which we would rather be slow than wrong.
  if (!proves || hadChunkError) {
    return result({
      found: false,
      complete: false,
      exhausted: true,
      chunksUsed,
      scannedFrom: head,
      scannedDownTo: Math.min(scannedDownTo, head + 1),
      coverage,
      // A lost chunk outranks a spent budget when both happened. Running out of budget is
      // the normal, expected outcome of a deep walk and says nothing is wrong; a lost chunk
      // is a real fault, and it is the one worth surfacing to whoever reads the reason.
      reason: hadChunkError ? "chunk_error" : ranOutOfBudget ? "budget_exhausted" : "coverage_incomplete",
    });
  }

  // FLOOR VALIDATION. Reaching the floor is what turns "found nothing" into "there is
  // nothing" — but only if the floor is really the contract's first block. A floor set too
  // HIGH (stale env after a redeploy, say) would end the walk above the events and
  // manufacture a confident false. One eth_getCode per source, on the negative path only,
  // closes that: if the contract already existed below the floor, the floor is wrong and
  // the answer degrades to indeterminate.
  //
  // THIS RUNS ON EVERY DERIVATION, not only on the poll that reaches the floor. A poll that
  // walks no chunks at all because prior coverage already spans floor→head still pays for
  // it — the coverage is durable and long-lived, and the floor it was computed against must
  // be re-proved each time it is cashed in for a negative.
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
        coverage,
        reason: "floor_unverified",
      });
    }
  }

  // RULE 2 satisfied: every source covered from a validated floor up to head, no holes.
  return result({
    found: false,
    complete: true,
    exhausted: false,
    chunksUsed,
    scannedFrom: head,
    scannedDownTo,
    coverage,
    reason: null,
  });
}

/**
 * The floor check: the contract must NOT have code in the block before its floor.
 *
 * EXPORTED so indexProof.js can pay for the same one, rather than growing a second opinion
 * about what makes a floor trustworthy. Both paths turn "found nothing" into "there is
 * nothing", so both are vulnerable to a floor set too HIGH — and a second implementation of
 * this check is a second thing that can drift into accepting one.
 */
export async function verifySourceFloor(source) {
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
