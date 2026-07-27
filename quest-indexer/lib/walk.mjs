// The settler's backward walk — deliberately a STRICT SUBSET of the read path's scanner.
//
// ============================================================================
// WHY A SECOND WALKER EXISTS AT ALL
// ============================================================================
// api/_lib/quest/scan.js is the real thing: two phases, resumable, budget-aware, with a
// frozen frontier and a verdict derivation. This service cannot import it — it is a
// separate Railway deployable and the isolation test forbids reaching across that boundary.
//
// Rather than PORT it (two copies of coverageProvesAbsence and the phase-A contiguity rules
// is exactly the divergence risk this whole design fights), this walker does strictly less:
//
//   scan.js          walks the top gap AND descends, derives a verdict, freezes a frontier
//   this            descends only, derives NOTHING, and stops dead at the first failure
//
// The settler never needs the rest. It does not answer questions; it only makes the read
// path's next answer cheaper. `coverageProvesAbsence` stays where it is.
//
// ============================================================================
// WHY IT CANNOT CREATE A HOLE
// ============================================================================
// A hole in [scanned_to .. scanned_from] is the one thing a cursor writer can do that makes
// the read path lie: the derivation treats that interval as contiguous, so an unread block
// inside it would be counted as "read and empty". scan.js prevents this with a frozen
// frontier — it keeps walking past a failure but stops recording.
//
// This walker gets the same guarantee more cheaply, by construction:
//
//   * `frontier` is assigned ONLY on the line after a successful, empty chunk.
//   * ANY failure returns immediately. There is no path that continues past an error.
//   * The walk is strictly descending and contiguous — each chunk starts one block below
//     the previous one's floor.
//
// So `frontier` is always the lowest block of an unbroken run downward from the starting
// point. There is no branch in which it could skip one.
//
// It also never touches `scanned_from`, which is the OTHER way to make a hole (advancing
// the top over an unclosed gap). Closing the top gap stays a read-path job — see the note
// in settler.mjs about what that costs.

/**
 * Blocks per eth_getLogs call.
 *
 * MUST EQUAL the read path's CHUNK_BLOCKS in api/_lib/quest/scan.js. Not for performance —
 * because the two write to the SAME quest_cursor rows, and coverage the settler produces
 * has to be coverage the read path will accept and extend. A parity test pins them
 * together. The 10k figure itself is measured; see scan.js's header for the numbers.
 */
export const CHUNK_BLOCKS = 10_000;

/**
 * Walk downward from `from` toward `floor`, stopping on a hit, the floor, the budget, or
 * any error.
 *
 * @param {object} args
 * @param {(lo: number, hi: number) => Promise<Array>} args.getLogsFor
 * @param {number} args.from    highest block to read, inclusive. The caller passes
 *   `scanned_to - 1`: the row's existing coverage starts at scanned_to, so this is the
 *   first block NOT yet covered.
 * @param {number} args.floor   lowest block worth reading — the contract's deploy block.
 * @param {number} args.budgetMs
 * @param {() => number} [args.now]
 * @returns {Promise<{found, hitBlock, frontier, chunks, stopped}>}
 *   `frontier` is the lowest CONTIGUOUSLY covered block, and equals `from + 1` (i.e. no
 *   progress) when nothing succeeded. `stopped` is "found" | "floor" | "budget" | "error".
 */
/**
 * Blocks per eth_getLogs call for the BACKFILL, and deliberately NOT `CHUNK_BLOCKS`.
 *
 * ============================================================================
 * WHY THIS IS ALLOWED TO DIFFER, WHEN CHUNK_BLOCKS IS NOT
 * ============================================================================
 * CHUNK_BLOCKS is pinned to the read path's value by a parity test, for a real reason: the
 * settler and the read path write the SAME quest_cursor rows, so coverage one produces has
 * to be coverage the other will accept and extend.
 *
 * The backfill writes `quest_backfill`, which nothing else writes. Its chunk size is
 * therefore a pure throughput parameter with no agreement to keep, and pinning it to 10k
 * would be cargo-culting a constraint that does not apply.
 *
 * 25,000 IS MEASURED, on this RPC, on 2026-07-27:
 *
 *     span   median   errors   blocks/sec
 *     10k     5.6s      0/5      1,788
 *     25k     9.9s      0/5      2,530
 *     50k    29.8s      2/5      1,676
 *
 * The ceiling is not a block-range cap — 61k and 90k spans both succeed — it is a ~30s
 * SERVER-SIDE REQUEST TIMEOUT. 50k sits on top of it and fails ~40% of the time; 25k is the
 * throughput optimum with no observed failures. Re-measure before changing this, because
 * the shape of the curve, not the number, is the reason for it.
 */
export const BACKFILL_CHUNK_BLOCKS = 25_000;

/**
 * The floor the adaptive halving stops at. Below this, a chunk that still times out is a
 * problem no amount of shrinking will fix, and pretending otherwise turns a visible failure
 * into an invisible crawl.
 */
export const BACKFILL_MIN_CHUNK_BLOCKS = 2_500;

/**
 * The UNFILTERED downward sweep — the backfill's engine.
 *
 * ============================================================================
 * HOW IT DIFFERS FROM walkDown(), AND WHY THAT IS SAFE
 * ============================================================================
 * walkDown() asks "did THIS wallet ever act", so a single log is proof and ends the walk.
 * This asks "which wallets EVER acted", so a log is data and the sweep must continue to the
 * floor regardless of what it finds. One pass answers for every wallet at once, which is
 * the entire reason the backfill is cheaper than the per-wallet walk it replaces.
 *
 * The contiguity guarantee is IDENTICAL and is what matters:
 *
 *   * `frontier` moves only on the line after a chunk that both READ successfully and was
 *     RECORDED successfully;
 *   * any failure returns immediately — there is no path that continues past one;
 *   * the sweep is strictly descending, each chunk starting one block below the last.
 *
 * So `frontier` is always the bottom of an unbroken run downward from the start, and a
 * caller that persists only `frontier` cannot record a hole.
 *
 * ============================================================================
 * ADAPTIVE HALVING — THE ANTI-STALL, NOT A CONGESTION CONTROLLER
 * ============================================================================
 * Failures on this RPC are timeout-driven and random rather than span-bounded. A chunk that
 * times out at 25k will usually succeed on retry, but a dense region could in principle
 * time out at 25k every time — and since the sweep cannot advance past it, that would stall
 * the backfill at one block forever. So a failed READ halves the span and retries the same
 * `hi`, down to BACKFILL_MIN_CHUNK_BLOCKS.
 *
 * THE SPAN DOES NOT RECOVER within a slice. Restoring it after a success would oscillate —
 * fail, halve, succeed, restore, fail — paying a wasted request each cycle. A slice is one
 * scheduler tick; the next one starts fresh at the configured size, which is recovery
 * enough and cannot oscillate.
 *
 * A RECORDING failure (`onChunk` throwing) does NOT halve and does not retry: a smaller
 * block range is no answer to a database that rejected the write, and retrying would
 * re-issue the same write. It stops the sweep, and the durable frontier is whatever was
 * committed before it.
 *
 * @param {object} args
 * @param {(lo: number, hi: number) => Promise<Array>} args.getLogsFor
 * @param {(logs: Array, lo: number, hi: number) => Promise<void>} args.onChunk  records the
 *   chunk durably — completions first, then the frontier. MUST throw rather than swallow:
 *   a swallowed write failure would let `frontier` advance over blocks nothing recorded.
 * @param {number} args.from   highest block to read, inclusive.
 * @param {number} args.floor  lowest block worth reading — the contract's deploy block.
 * @param {number} args.budgetMs
 * @returns {Promise<{frontier, chunks, logs, stopped, error?}>}
 *   `frontier` is the lowest CONTIGUOUSLY covered-and-recorded block, and equals `from + 1`
 *   when nothing succeeded. `stopped` is "floor" | "budget" | "error".
 */
export async function sweepDown({
  getLogsFor,
  onChunk,
  from,
  floor,
  budgetMs,
  now = () => Date.now(),
  chunkBlocks = BACKFILL_CHUNK_BLOCKS,
  minChunkBlocks = BACKFILL_MIN_CHUNK_BLOCKS,
}) {
  let frontier = from + 1;
  let chunks = 0;
  let seen = 0;
  let hi = from;
  let span = chunkBlocks;

  const deadline = now() + budgetMs;

  while (hi >= floor) {
    // Checked BEFORE starting a chunk, never mid-flight: an abandoned chunk is wasted work
    // and would tempt a caller into recording coverage it did not finish reading.
    if (now() >= deadline) return { frontier, chunks, logs: seen, stopped: "budget" };

    const lo = Math.max(floor, hi - span + 1);

    let logs;
    try {
      logs = await getLogsFor(lo, hi);
    } catch (err) {
      // Halve and retry the SAME hi. `continue` deliberately does not touch `frontier` or
      // `hi`, so a shrinking retry re-reads the identical top of the range.
      if (span > minChunkBlocks) {
        span = Math.max(minChunkBlocks, Math.floor(span / 2));
        continue;
      }
      return { frontier, chunks, logs: seen, stopped: "error", error: err };
    }

    // Record BEFORE advancing. If this throws, the frontier stays where it was and the next
    // slice re-reads this chunk — idempotent, because completions are on-conflict-do-nothing
    // and the frontier write is guarded to move only downward.
    try {
      await onChunk(logs, lo, hi);
    } catch (err) {
      return { frontier, chunks, logs: seen, stopped: "error", error: err };
    }

    chunks++;
    seen += logs.length;

    // The only place frontier moves, and only after a chunk that was both read and recorded.
    frontier = lo;
    hi = lo - 1;
  }

  return { frontier, chunks, logs: seen, stopped: "floor" };
}

export async function walkDown({ getLogsFor, from, floor, budgetMs, now = () => Date.now(), chunkBlocks = CHUNK_BLOCKS }) {
  // Start at "nothing new walked". Every early return below reports this unless a chunk has
  // actually succeeded, so a walk that achieves nothing writes nothing.
  let frontier = from + 1;
  let chunks = 0;
  let hi = from;

  const deadline = now() + budgetMs;

  while (hi >= floor) {
    // Checked BEFORE starting a chunk, never mid-flight: an abandoned chunk is wasted work
    // and, worse, would tempt a caller into recording coverage it did not finish reading.
    if (now() >= deadline) return { found: false, hitBlock: null, frontier, chunks, stopped: "budget" };

    const lo = Math.max(floor, hi - chunkBlocks + 1);

    let logs;
    try {
      logs = await getLogsFor(lo, hi);
    } catch (err) {
      // RETURN, do not continue. Everything below this chunk is unreachable for coverage
      // purposes, so reading it would produce blocks we are not allowed to record —
      // and recording them anyway is precisely the hole this walker cannot create.
      return { found: false, hitBlock: null, frontier, chunks, stopped: "error", error: err };
    }

    chunks++;

    // A positive is proof and ends everything. Note this returns the UNADVANCED frontier:
    // the completion is what gets written, and the partial coverage walked on the way is
    // irrelevant once the quest is settled.
    if (logs.length > 0) {
      return { found: true, hitBlock: logs[0].blockNumber ?? lo, frontier, chunks, stopped: "found" };
    }

    // The only place frontier moves, and only after a chunk that succeeded and was empty.
    frontier = lo;
    hi = lo - 1;
  }

  return { found: false, hitBlock: null, frontier, chunks, stopped: "floor" };
}
