// JOB C — the one-time-quest backfill.
//
// ============================================================================
// THE INSIGHT THIS JOB IS BUILT ON
// ============================================================================
// Proving "this wallet never traded" by walking PositionManager for THAT WALLET costs
// ~1,060 chunks and has to be paid again for the next wallet, and the next. The filter is
// the only thing making it per-wallet — and the filter is not load-bearing. Drop it, and
// ONE pass over the same range answers the question for every wallet that has ever existed:
//
//     426 chunks, once, for everybody
//     1,060 chunks, per wallet, forever
//
// So this job sweeps each source from head to its deploy block with `allWalletsFilter` —
// the same unfiltered filter the forward indexer already uses — and writes a
// quest_completion row for every wallet it finds. Job B (the backward settler) becomes
// largely redundant once this finishes, which is why this runs ahead of it.
//
// ============================================================================
// WHAT IT WRITES, AND WHAT IT STRUCTURALLY CANNOT
// ============================================================================
// Two things, and both are facts rather than answers:
//
//   1. quest_completion rows — POSITIVES ONLY. A PositionOpened log IS proof that address
//      traded. The table has no column that could express the negative (0001), so this job
//      has no way to write one even by mistake.
//   2. quest_backfill.covered_to, extended DOWNWARD — coverage, i.e. which blocks were read.
//
// IT DOES NOT DECIDE ANYTHING. "This wallet never traded" is DERIVED on the read path from
// this coverage plus the forward index's, on every request, and is never stored. A pass
// that stopped short, a floor that changed, a row that is missing — each simply fails that
// derivation and the answer degrades to INDETERMINATE. That is the whole safety argument
// and it is the same one quest_cursor makes.
//
// It also does not write quest_daily. Backfilled days are in the past and `daily_active`
// only ever asks about today, so those rows would be work nobody reads.
//
// ============================================================================
// RESUME, AND WHY IT LIVES IN THE SCHEDULER'S LEFTOVER TIME
// ============================================================================
// The sweep is ~1,053 chunks across four sources — ~2.9 hours of getLogs. Running it as the
// scheduler's `fill` rather than as a standalone script buys, for nothing:
//
//   * Job A keeps absolute priority, and the existing priority-inversion guard means this
//     never runs while the forward index is erroring or catching up;
//   * the RPC load is bounded by construction — one request at a time, inside ≤55s of each
//     60s tick, which is ~0.1 req/s against an endpoint two money-path keepers share;
//   * a crash resumes from the last committed chunk, because the frontier is durable per
//     chunk rather than per run.
//
// CONCURRENCY IS 1, deliberately. Chunks completing out of order would break the contiguous
// frontier that sweepDown() gets for free by being strictly serial, and reconstructing
// "longest completed prefix" is real complexity to save hours on a job that runs once.

import { QUESTS_BY_SOURCE } from "./definitions.mjs";
import { allWalletsFilter, sourceAddress, sourceFloor, walletFromLog } from "./sources.mjs";
import { BACKFILL_CHUNK_BLOCKS, sweepDown } from "./walk.mjs";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const backfillChunkBlocks = () => positiveInt(process.env.QUEST_BACKFILL_CHUNK, BACKFILL_CHUNK_BLOCKS);

/**
 * Decide what each source needs, given its stored coverage.
 *
 * Exported because the three outcomes below are the whole correctness surface of this job
 * and each of them needs to be assertable without a network.
 *
 * @returns {Array<{source, address, floor, state, from, remaining}>} ordered LEAST REMAINING
 *   FIRST. Same reasoning as the settler: the work is finite and terminating, so finishing
 *   the nearly-done first settles whole quests sooner. Here it means first_prediction's two
 *   factories (201 chunks between them) complete long before the two 426-chunk sources.
 */
export function planBackfill({ sources, coverage, head, env = process.env }) {
  const plan = [];

  for (const source of sources) {
    const address = sourceAddress(source, env);
    const floor = sourceFloor(source, env);
    const prior = coverage.get(address);

    // FLOOR COUPLING, exactly as quest_cursor and isUsablePrior enforce it. A floor moved
    // DOWN means there is unswept history below what we covered; a floor moved UP means the
    // pass may have been reading a different contract. Either way the coverage is void and
    // the honest move is to start again — which costs hours and can never cost a wrong
    // answer, whereas trusting it could.
    const usable = prior != null && prior.floorBlock === floor && prior.coveredTo >= floor;

    if (!usable) {
      plan.push({
        source,
        address,
        floor,
        state: prior == null ? "fresh" : "floor_changed",
        // A NEW pass is anchored at the CURRENT head. That ceiling is what the read path
        // checks against completion_from, and it must be a block the forward index has
        // already passed — which it is, because the forward index has been running since
        // long before any backfill starts.
        from: head,
        remaining: head - floor,
      });
      continue;
    }

    if (prior.coveredTo === floor) {
      plan.push({ source, address, floor, state: "complete", from: floor, remaining: 0 });
      continue;
    }

    plan.push({
      source,
      address,
      floor,
      state: "resume",
      // Coverage starts AT coveredTo, so the first unswept block is one below.
      from: prior.coveredTo - 1,
      remaining: prior.coveredTo - floor,
    });
  }

  return plan.sort((a, b) => a.remaining - b.remaining);
}

/**
 * One backfill slice.
 *
 * @param {object} args
 * @param {object} args.writer     lib/supabase.mjs
 * @param {Array} args.sources     descriptors from lib/sources.mjs
 * @param {number} args.chainId
 * @param {number} args.head       current chain head, the ceiling for any NEW pass
 * @param {number} args.budgetMs   time this slice may use, from the scheduler's leftover
 * @param {(filter) => Promise<Array>} args.getLogs
 * @returns {Promise<{complete, swept, chunks, completions, sources, reason}>}
 *   `complete` is the thing the caller acts on: true only when EVERY source has reached its
 *   floor, which is the precondition for the read path being allowed to derive a negative.
 */
export async function runBackfill({
  writer,
  sources,
  chainId,
  head,
  budgetMs,
  getLogs,
  env = process.env,
  now = () => Date.now(),
  log = (m) => console.log(m),
  chunkBlocks = backfillChunkBlocks(),
}) {
  const deadline = now() + budgetMs;

  // Addresses resolve first and THROW on misconfiguration, before any state is read — the
  // same rule Job A follows, so a bad env var cannot half-sweep.
  const addresses = sources.map((s) => sourceAddress(s, env));
  const coverage = await writer.loadBackfill(chainId, addresses);
  const plan = planBackfill({ sources, coverage, head, env });

  if (plan.every((p) => p.state === "complete")) {
    return { complete: true, swept: 0, chunks: 0, completions: 0, sources: [], reason: "already_complete" };
  }

  const report = [];
  let chunks = 0;
  let completions = 0;

  for (const item of plan) {
    if (item.state === "complete") continue;
    if (now() >= deadline) break;

    // Opening the pass fixes the ceiling. Done before the first chunk so a crash mid-slice
    // resumes against a row that already exists, rather than re-anchoring at a NEW head and
    // silently abandoning the blocks between the two ceilings.
    if (item.state !== "resume") {
      await writer.startBackfill({
        chainId,
        sourceKey: item.address,
        floorBlock: item.floor,
        coveredFrom: item.from,
      });
      if (item.state === "floor_changed") {
        log(`[backfill] ${item.source.label} floor changed — previous coverage discarded, restarting from ${item.from}`);
      }
    }

    const result = await sweepDown({
      getLogsFor: (lo, hi) =>
        getLogs(allWalletsFilter(item.source, { address: item.address, fromBlock: lo, toBlock: hi })),

      // THE ORDER, again: completions land before the frontier that would claim them. Both
      // throw on failure, and sweepDown stops rather than advancing past either.
      onChunk: async (logs, lo) => {
        if (logs.length > 0) {
          const rows = completionsFrom(item.source, logs, chainId);
          await writer.writeCompletions(rows);
          completions += rows.length;
        }
        await writer.extendBackfillDown({
          chainId,
          sourceKey: item.address,
          floorBlock: item.floor,
          coveredTo: lo,
        });
      },

      from: item.from,
      floor: item.floor,
      budgetMs: Math.max(0, deadline - now()),
      now,
      chunkBlocks,
    });

    chunks += result.chunks;
    report.push({
      key: item.source.key,
      from: item.from,
      frontier: result.frontier,
      chunks: result.chunks,
      logs: result.logs,
      stopped: result.stopped,
    });

    const remaining = result.frontier - item.floor;
    log(
      `[backfill] ${item.source.label} ${item.from} → ${result.frontier} ` +
        `(${result.chunks} chunks, ${result.logs} logs, ${remaining === 0 ? "AT FLOOR" : `${remaining} to go`}, ${result.stopped})`,
    );

    if (result.stopped === "error") {
      // The frontier is whatever was contiguously swept AND recorded before the failure, so
      // it is already durable and safe. There is no point continuing this slice under an RPC
      // or a database that is refusing us.
      log(`[backfill] ${item.source.label} — chunk failed, kept ${result.chunks} chunks of progress`);
      return { complete: false, swept: report.length, chunks, completions, sources: report, reason: "chunk_error" };
    }

    if (result.stopped === "budget") {
      return { complete: false, swept: report.length, chunks, completions, sources: report, reason: "budget" };
    }
  }

  // Only true when every source in the plan reached its floor THIS slice or was already
  // there. Anything else — a source we ran out of time before starting, a source still
  // descending — leaves it false, and the read path keeps answering indeterminate.
  const complete = plan.every((p) => p.state === "complete" || report.some((r) => r.key === p.source.key && r.stopped === "floor"));

  return {
    complete,
    swept: report.length,
    chunks,
    completions,
    sources: report,
    reason: complete ? "complete" : "partial",
  };
}

/**
 * Turn one chunk's logs into completion rows.
 *
 * Deduped per (wallet, quest): a chunk of 25,000 blocks can hold hundreds of logs from a
 * handful of busy wallets, and the write is an upsert either way — but a smaller batch is a
 * smaller blast radius if PostgREST rejects it.
 *
 * walletFromLog THROWS on a log it cannot resolve, and that propagates deliberately. A
 * skipped log here would be a trader missing from a range the frontier then claims to have
 * covered — which reads downstream as a proven negative about someone who did trade.
 */
function completionsFrom(source, logs, chainId) {
  const quests = QUESTS_BY_SOURCE[source.key] ?? [];
  if (quests.length === 0) return [];

  const rows = new Map();
  for (const log of logs) {
    const wallet = walletFromLog(source, log);
    for (const quest of quests) {
      const key = `${wallet}:${quest}`;
      if (!rows.has(key)) {
        rows.set(key, { chainId, wallet, quest, checkedThroughBlock: log.blockNumber, source: "backfill" });
      }
    }
  }
  return [...rows.values()];
}
