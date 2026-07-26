// JOB B — the backward settler.
//
// Measured on prod on 2026-07-26: /api/quest/verify covers ~48,000 blocks per poll, and
// first_trade's floor sits ~10.1M blocks below head. A wallet that never traded therefore
// needs ~200 polls — over two hours of somebody sitting there clicking — before its
// coverage reaches the floor and the answer settles. That is the problem this job exists
// for: the same walk, done in the background, so the answer is ready before anyone asks.
//
// ============================================================================
// WHAT IT WRITES, AND THE TWO THINGS IT CANNOT
// ============================================================================
// It writes exactly two things:
//
//   1. `scanned_to`, extended DOWNWARD — coverage, a fact about which blocks were read.
//   2. a `quest_completion` row, ONLY when a matching log was actually found.
//
// It cannot write a verdict, and that is structural rather than careful:
//
//   * quest_cursor has no `completed` and no `status` column. Coverage is all it can hold.
//   * quest_completion has no such column either — a row's EXISTENCE is the completion, so
//     there is no representation for "this wallet did NOT do it". The only thing
//     writeCompletion() can express is a positive, and it is called only on a hit.
//   * THE DERIVATION LIVES ENTIRELY ON THE READ PATH. coverageProvesAbsence() decides
//     whether accumulated coverage amounts to a proven negative, on every read, in
//     api/_lib/quest/scan.js. Nothing here computes or stores that judgement.
//
// It also never touches `scanned_from`. The top of the interval is the read path's to move,
// because only a request knows the current head. THE COST OF THAT is real and worth stating:
// the settler can walk a wallet's coverage all the way to the floor, but the final step —
// closing the gap between the last poll's head and now — still happens on the next user
// poll. So the experience becomes "one poll settles it" instead of "two hundred polls
// settle it", not "zero polls". That is the deliberate trade for a writer that structurally
// cannot punch a hole in an interval the read path treats as contiguous.
//
// ============================================================================
// IT ONLY RUNS WHEN THE FORWARD INDEX IS HEALTHY
// ============================================================================
// Enforced by the scheduler, not here — see lib/scheduler.mjs. The asymmetry: a forward
// index that falls behind makes daily_active answer indeterminate (and, if the freshness
// guard were ever wrong, could make it lie), whereas a settler that falls behind only means
// deep quests take longer to settle. So Job A gets absolute priority and this job gets
// whatever time is left, and none at all while Job A is unwell.

import { SETTLEABLE_QUESTS } from "./definitions.mjs";
import { SOURCES, sourceAddress, sourceFloor, walletFilter } from "./sources.mjs";
import { CHUNK_BLOCKS, walkDown } from "./walk.mjs";

export { SETTLEABLE_QUESTS };

/** How many cursor rows to consider per run. Bounded, and logged when it truncates. */
export const CANDIDATE_PAGE = 200;

/**
 * Group a page of cursor rows into units of work.
 *
 * THE UNIT IS (wallet, quest), NOT (wallet, quest, source). first_prediction has two cursor
 * rows and settles only when BOTH reach their floors, so working one source of it in
 * isolation could never finish the quest.
 *
 * Rows are dropped here rather than filtered in SQL because the interesting predicates are
 * column-to-column comparisons PostgREST cannot express.
 */
export function planWork(rows, { env = process.env, log = () => {} } = {}) {
  const groups = new Map();
  let staleFloor = 0;
  let settled = 0;
  let unknown = 0;

  for (const row of rows) {
    const quest = SETTLEABLE_QUESTS[row.quest];
    if (!quest) {
      unknown++;
      continue;
    }

    const descriptor = SOURCES.find((s) => {
      try {
        return sourceAddress(s, env) === String(row.sourceKey).toLowerCase();
      } catch {
        return false;
      }
    });
    if (!descriptor || !quest.includes(descriptor.key)) {
      // An address we no longer configure — a retired contract's orphaned rows. Harmless
      // and ignored, exactly as the migration says.
      unknown++;
      continue;
    }

    // FLOOR COUPLING. A row computed against a different floor is void: the read path will
    // discard it via isUsablePrior, so walking it would be pure waste, and writing to it
    // would be writing coverage nobody will read.
    if (row.floorBlock !== sourceFloor(descriptor, env)) {
      staleFloor++;
      continue;
    }

    // Already at the floor for this source; nothing left to walk.
    if (row.scannedTo <= row.floorBlock) {
      settled++;
      continue;
    }

    const key = `${row.wallet}:${row.quest}`;
    if (!groups.has(key)) groups.set(key, { wallet: row.wallet, quest: row.quest, sources: [], remaining: 0 });
    const group = groups.get(key);
    group.sources.push({ row, descriptor });
    group.remaining += row.scannedTo - row.floorBlock;
  }

  if (staleFloor || unknown) log(`[settler] skipped ${staleFloor} stale-floor and ${unknown} unrecognised rows`);

  // LEAST REMAINING FIRST. The work is bounded and terminating — each wallet needs a finite
  // number of passes and then leaves the queue — so round-robin would settle nobody for a
  // very long time and then everybody at once. Finishing the nearly-done first maximises
  // wallets settled per unit of budget. The updated_at tiebreak (inherited from the page's
  // ordering) keeps rows of equal depth rotating, so nothing starves permanently.
  return [...groups.values()].sort((a, b) => a.remaining - b.remaining);
}

/**
 * One settler slice.
 *
 * @param {object} args
 * @param {object} args.writer     lib/supabase.mjs
 * @param {number} args.chainId
 * @param {number} args.budgetMs   time this slice may use, from the scheduler's leftover
 * @param {(filter) => Promise<Array>} args.getLogs
 * @returns {Promise<{worked, found, extended, skipped, reason}>}
 */
export async function runSettler({
  writer,
  chainId,
  budgetMs,
  getLogs,
  env = process.env,
  now = () => Date.now(),
  log = (m) => console.log(m),
  page = CANDIDATE_PAGE,
}) {
  const deadline = now() + budgetMs;

  const rows = await writer.pickCursorCandidates(chainId, page);
  if (rows.length === page) {
    // No silent caps: a full page means there may be deeper-remaining work this run never
    // saw. The updated_at ordering means the page rotates, so it is not invisible forever.
    log(`[settler] candidate page full at ${page} rows — deeper work may be waiting`);
  }

  const work = planWork(rows, { env, log });
  if (work.length === 0) return { worked: 0, found: 0, extended: 0, skipped: 0, reason: "nothing_to_settle" };

  let skipped = 0;
  for (const group of work) {
    if (now() >= deadline) return { worked: 0, found: 0, extended: 0, skipped, reason: "budget" };

    // Already proven by a user poll or an earlier run. Its cursor rows are dead weight.
    if (await writer.hasCompletion(chainId, group.wallet, group.quest)) {
      skipped++;
      continue;
    }

    return settleOne({ group, writer, chainId, deadline, getLogs, env, now, log, skipped });
  }

  return { worked: 0, found: 0, extended: 0, skipped, reason: "all_completed" };
}

/**
 * Work every source of one (wallet, quest) within what is left of the slice.
 *
 * ONE GROUP PER SLICE, deliberately. Splitting a slice across wallets makes everybody
 * converge slower and settles nobody sooner — the same reasoning as least-remaining-first.
 */
async function settleOne({ group, writer, chainId, deadline, getLogs, env, now, log, skipped }) {
  let extended = 0;

  for (const { row, descriptor } of group.sources) {
    if (now() >= deadline) break;

    const address = sourceAddress(descriptor, env);
    const floor = sourceFloor(descriptor, env);

    const walk = await walkDown({
      getLogsFor: (lo, hi) =>
        getLogs(walletFilter(descriptor, { address, wallet: group.wallet, fromBlock: lo, toBlock: hi })),
      // The row's coverage starts AT scanned_to, so the first uncovered block is one below.
      from: row.scannedTo - 1,
      floor,
      budgetMs: Math.max(0, deadline - now()),
      now,
      chunkBlocks: CHUNK_BLOCKS,
    });

    if (walk.found) {
      // Proof. The completion is the answer; the partial coverage walked on the way is
      // irrelevant now and is deliberately not written — nothing will read that row again.
      await writer.writeCompletion({
        chainId,
        wallet: group.wallet,
        quest: group.quest,
        checkedThroughBlock: row.scannedFrom,
      });
      log(`[settler] ${group.quest} ${group.wallet} — FOUND at block ${walk.hitBlock}, completion written`);
      return { worked: 1, found: 1, extended, skipped, reason: "found" };
    }

    if (walk.stopped === "error") {
      // The frontier is whatever was contiguously covered BEFORE the failure, so recording
      // it is still safe — but there is no point continuing this group under a flaky RPC.
      if (walk.frontier < row.scannedTo) {
        await writer.extendCursorDown({ chainId, wallet: group.wallet, quest: group.quest, sourceKey: row.sourceKey, scannedTo: walk.frontier });
        extended++;
      }
      log(`[settler] ${group.quest} ${group.wallet} ${descriptor.key} — chunk failed, kept ${walk.chunks} chunks of progress`);
      return { worked: 1, found: 0, extended, skipped, reason: "chunk_error" };
    }

    // No progress (budget gone before the first chunk landed) means nothing to write.
    if (walk.frontier >= row.scannedTo) continue;

    await writer.extendCursorDown({
      chainId,
      wallet: group.wallet,
      quest: group.quest,
      sourceKey: row.sourceKey,
      scannedTo: walk.frontier,
    });
    extended++;
    log(
      `[settler] ${group.quest} ${group.wallet} ${descriptor.key} — ${row.scannedTo} → ${walk.frontier} ` +
        `(${row.scannedTo - walk.frontier} blocks, ${walk.frontier === floor ? "AT FLOOR" : `${walk.frontier - floor} to go`})`,
    );
  }

  return { worked: 1, found: 0, extended, skipped, reason: "extended" };
}
