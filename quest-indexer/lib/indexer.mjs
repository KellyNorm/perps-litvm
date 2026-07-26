// JOB A — the forward indexer.
//
// Reads each source's participation events from the blocks above its watermark and writes
// one quest_daily row per (wallet, UTC day). That table is what turns `daily_active` from a
// ~104-second backward scan into an O(1) row lookup.
//
// ============================================================================
// THE WRITE ORDER IS THE WHOLE SAFETY STORY. READ THIS BEFORE CHANGING ANYTHING.
// ============================================================================
//
//     ROWS FIRST. WATERMARK ONLY ON SUCCESS. NEVER ADVANCE A RANGE THAT FAILED.
//
// PostgREST gives us two separate statements, so there is always an instant where one has
// landed and the other has not. Which one goes first decides whether that instant is
// harmless or a wrong answer:
//
//   rows → watermark   the visible intermediate state is "rows written, watermark behind".
//                      A verify landing there sees a stale index and answers INDETERMINATE.
//                      Safe, and self-correcting on the next run.
//   watermark → rows   the visible intermediate state is "watermark fresh, rows missing".
//                      A verify landing there sees a CURRENT index with no row for the
//                      wallet and answers `completed: false` — about a wallet that was
//                      active in exactly the range we just claimed to have indexed.
//
// The second ordering is the single most likely way this system could lie, and it is one
// line of sequencing. Everything else here — the range cap, the per-source independence,
// the fail-the-run-on-a-bad-log rule — exists to keep that ordering meaningful.
//
// ============================================================================
// THE RANGE CAP: JOB A MUST NOT BE ABLE TO STARVE ITSELF
// ============================================================================
// Six hours of downtime is ~68,000 blocks at the measured ~0.32s/block. At ~0.3ms/block of
// getLogs that is ~20s per source, ~80s across four — enough that a run attempting the
// whole backlog would take longer than the interval that triggered it, fail or overrun,
// never commit, and leave the watermark exactly where it was. Forever.
//
// So each run indexes at most maxRangeBlocks per source. Catch-up happens across many runs
// at several times realtime, and while it does the index reads stale and `daily_active`
// answers indeterminate — which is correct, and is the difference between "recovering" and
// "quietly broken".
//
// ============================================================================
// PER-SOURCE INDEPENDENCE
// ============================================================================
// A failure on one source must not stop the others: they have their own watermarks and
// their own rows, and the freshness gate already refuses to answer while ANY of them lags.
// So a broken factory degrades `daily_active` to indeterminate (correct) rather than also
// freezing the PositionManager index (needless).

import { allWalletsFilter, sourceAddress, walletFromLog } from "./sources.mjs";
import { createBlockDayResolver } from "./blockDay.mjs";

/** Trailing margin against reorgs. ~20 blocks ≈ 6s on Nitro. */
export const DEFAULT_CONFIRMATIONS = 20;

/**
 * Per-source, per-run ceiling. 5,000 blocks ≈ 1.5s of getLogs, so four sources fit
 * comfortably in one run while still catching up at ~5x realtime.
 */
export const DEFAULT_MAX_RANGE_BLOCKS = 5_000;

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const confirmations = () => positiveInt(process.env.QUEST_INDEXER_CONFIRMATIONS, DEFAULT_CONFIRMATIONS);
export const maxRangeBlocks = () => positiveInt(process.env.QUEST_INDEXER_MAX_RANGE, DEFAULT_MAX_RANGE_BLOCKS);

/**
 * Work out which blocks this run should read for one source.
 *
 * NO WATERMARK YET → START AT THE SAFE HEAD, not at the contract's deploy block. A backfill
 * from deployment is ~10M blocks, and `daily_active` only ever asks about today, so it would
 * be days of work to answer a question about the last 24 hours. The consequence is
 * deliberate and is the reason for the deployment rule: THE INDEX MUST RUN FOR A FULL DAY
 * BEFORE daily_active GOES LIVE. Until then it has not covered a whole day, and the
 * freshness gate cannot tell "covered and empty" from "not covered yet" — only elapsed
 * coverage can.
 *
 * RESUME WITH OVERLAP. From `lastBlock - confirmations + 1`, not `lastBlock + 1`: re-reading
 * a few blocks is free and idempotent (quest_daily is on-conflict-do-nothing), whereas a gap
 * is invisible and permanent. It also re-reads the blocks most likely to have been reorged
 * since the previous run.
 */
export function rangeFor({ lastBlock, head, confirmations: conf, maxRange }) {
  const safeHead = head - conf;
  if (safeHead < 0) return null;

  // Nothing new. Tested against the WATERMARK, not against the overlap start: `from` is
  // deliberately below lastBlock, so comparing it here would manufacture a range whose
  // every block is already indexed — wasted getLogs whose advance() the lte guard then
  // rejects as superseded. It also covers lastBlock > safeHead, which is what a raised
  // confirmation margin or a rewound head looks like.
  if (lastBlock != null && lastBlock >= safeHead) return null;

  const from = lastBlock == null ? safeHead : Math.max(0, lastBlock - conf + 1);
  return { from, to: Math.min(safeHead, from + maxRange - 1) };
}

/**
 * One pass over every source.
 *
 * @param {object} args
 * @param {object} args.writer      lib/supabase.mjs — loadState / writeDaily / advance
 * @param {Array} args.sources      descriptors from lib/sources.mjs
 * @param {number} args.chainId
 * @param {number} args.head
 * @param {(filter) => Promise<Array>} args.getLogs
 * @param {(block) => Promise<{timestamp}>} args.getBlock
 * @param {() => number} [args.now] injectable clock (ms) for the deadline
 * @param {number} [args.deadline]  absolute ms after which no NEW source is started
 * @returns {Promise<{sources: Array, wrote: number, failed: number}>}
 */
export async function runIndexer({
  writer,
  sources,
  chainId,
  head,
  getLogs,
  getBlock,
  env = process.env,
  now = () => Date.now(),
  deadline = Infinity,
  conf = confirmations(),
  maxRange = maxRangeBlocks(),
}) {
  // Addresses resolve first and THROW on misconfiguration — before any state is read, so a
  // bad env var cannot half-index. ConfigError kills the run and, at startup, the process.
  const resolved = sources.map((source) => ({ source, address: sourceAddress(source, env) }));
  const state = await writer.loadState(chainId, resolved.map((r) => r.address));

  // One resolver for the whole run: the four sources scan overlapping ranges, so endpoint
  // timestamps and any boundary bisection are paid for once rather than four times.
  const days = createBlockDayResolver(getBlock);

  const report = [];
  let wrote = 0;
  let failed = 0;

  for (const { source, address } of resolved) {
    if (now() >= deadline) {
      // Not an error: the remaining sources keep their watermarks and catch up next run.
      // Their staleness is what makes the endpoint answer indeterminate meanwhile.
      report.push({ key: source.key, address, skipped: "deadline" });
      continue;
    }

    const prior = state.get(address);
    const range = rangeFor({ lastBlock: prior?.lastBlock ?? null, head, confirmations: conf, maxRange });

    // Nothing new above the watermark. Still touch the row: `advance` guards on
    // last_block=lte, so re-writing the SAME value refreshes updated_at without moving
    // anything. Skipping this would let a healthy indexer on a quiet chain age past the
    // wall-clock freshness threshold and read as dead.
    if (!range) {
      try {
        if (prior) await writer.advance(chainId, address, prior.lastBlock);
        report.push({ key: source.key, address, idle: true, lastBlock: prior?.lastBlock ?? null });
      } catch (err) {
        failed++;
        report.push({ key: source.key, address, error: err?.message });
      }
      continue;
    }

    try {
      const logs = await getLogs(allWalletsFilter(source, { address, fromBlock: range.from, toBlock: range.to }));

      // Both of these THROW on anything they cannot resolve, and that is deliberate: a log
      // skipped while the watermark still advanced would leave its block permanently
      // unindexed underneath a watermark claiming to cover it — which reads downstream as a
      // proven absence. A failed run costs a retry; a skipped log costs a wrong answer that
      // never heals.
      const dayByBlock = await days.resolve(logs, { fromBlock: range.from, toBlock: range.to });

      // Dedupe to one row per (wallet, day). A busy trader emits many logs and needs one row,
      // and a smaller batch is a smaller blast radius if the write is rejected.
      const rows = new Map();
      for (const log of logs) {
        const wallet = walletFromLog(source, log);
        const day = dayByBlock.get(log.blockNumber);
        if (!day) throw new Error(`${source.label}: no day resolved for block ${log.blockNumber}`);

        const key = `${wallet}:${day}`;
        // Keep the FIRST sighting: first_seen_block is debug-only, but "first" is the only
        // reading of it that is stable across replays of an overlapping range.
        if (!rows.has(key)) {
          rows.set(key, {
            chainId,
            wallet,
            day,
            firstSeenBlock: log.blockNumber,
            firstSeenVia: source.eventName,
          });
        }
      }

      // ---- THE ORDER. Rows, then watermark, and only if the rows landed.
      await writer.writeDaily([...rows.values()]);
      await writer.advance(chainId, address, range.to);

      wrote += rows.size;
      report.push({ key: source.key, address, from: range.from, to: range.to, logs: logs.length, rows: rows.size });
    } catch (err) {
      // The watermark is untouched, so this range is re-read next run. Idempotent writes
      // make that free, and the unmoved watermark is what keeps `daily_active` honest in
      // the meantime.
      failed++;
      console.error(`[indexer] ${source.label} ${range.from}-${range.to} failed, watermark held:`, err?.message);
      report.push({ key: source.key, address, from: range.from, to: range.to, error: err?.message });
    }
  }

  return { sources: report, wrote, failed };
}
