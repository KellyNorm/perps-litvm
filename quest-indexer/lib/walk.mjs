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
