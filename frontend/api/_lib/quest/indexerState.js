// THE STALENESS GUARD. The single most safety-critical function in the quest API.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
// Every other table in this schema is safe by construction: a missing row yields
// indeterminate, never a false. quest_daily is the exception and it is not a small one —
// answering `daily_active` means reading "no row for (wallet, today)" as "this wallet did
// nothing today". If the indexer dies, EVERY wallet silently becomes `completed: false`.
// That is precisely the failure the whole endpoint was built to prevent, arriving from a
// new direction: not a scan that gave up, but a background job that stopped.
//
// So absence is only an answer when the index is PROVABLY CURRENT, and proving that is this
// file's only job. It is read BEFORE quest_daily, every time. If it says stale, the caller
// must not look at quest_daily at all.
//
// ============================================================================
// IT FAILS CLOSED. SIX WAYS.
// ============================================================================
// Anything short of a positive proof of currency is stale. Enumerated, because "it checks
// freshness" is not a specification and each of these is a real, distinct failure:
//
//   1. A REQUIRED SOURCE HAS NO ROW      never indexed — or the contract address changed,
//                                        which self-invalidates exactly as quest_cursor
//                                        does, because the address IS the key.
//   2. FEWER ROWS THAN SOURCES REQUIRED  a silently dropped source is how a wrong false is
//                                        born. Count them; do not just use what came back.
//   3. THE READ FAILED                   threw, timed out, returned nonsense. We cannot
//                                        prove currency, so we cannot use absence.
//   4. WALL-CLOCK AGE                    `now - updated_at` past the threshold: the job is
//                                        not running.
//   5. BLOCK LAG                         `head - last_block` past the threshold: the job is
//                                        running but losing ground.
//   6. HEAD BELOW THE WATERMARK          `head < last_block`. A chain reset or re-genesis
//                                        leaves the watermark above the new head. Block lag
//                                        goes NEGATIVE and reads as zero lag, so a naive
//                                        check reports a permanently "fresh", permanently
//                                        empty index and hands out confident falses forever.
//                                        One comparison closes it, and without it this is
//                                        the nastiest failure in the system.
//
// FRESHNESS IS THE MINIMUM ACROSS SOURCES, never an average and never any single row. The
// four streams advance independently, and one lagging source must make the whole answer
// stale: a wallet whose only activity today was a bet must not be reported inactive because
// the factory indexer alone fell behind.
//
// ============================================================================
// ONE THRESHOLD, NOT TWO
// ============================================================================
// maxLagBlocks is DERIVED from maxLagMs and the block time rather than configured
// separately. Two numbers that are supposed to mean the same duration are two numbers that
// can disagree, and the direction they disagree in decides whether this guard is doing
// anything at all.

/** 15 minutes ≈ 3 cron periods at a 5-minute cadence, so one missed run does not trip it. */
export const DEFAULT_MAX_LAG_MS = 15 * 60 * 1000;

/** LitVM/Nitro block cadence, measured ~0.32s. Only used to convert the threshold. */
export const DEFAULT_BLOCK_TIME_MS = 320;

/** The single public reason code. The `detail` says which of the six it was. */
export const INDEXER_STALE = "indexer_stale";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxLagMs() {
  return positiveInt(process.env.QUEST_INDEXER_MAX_LAG_MS, DEFAULT_MAX_LAG_MS);
}

export function blockTimeMs() {
  return positiveInt(process.env.QUEST_BLOCK_TIME_MS, DEFAULT_BLOCK_TIME_MS);
}

/** The block-lag threshold, derived from the time one. Never configured independently. */
export function maxLagBlocks({ lagMs = maxLagMs(), blockMs = blockTimeMs() } = {}) {
  return Math.max(1, Math.ceil(lagMs / blockMs));
}

const stale = (detail) => ({ fresh: false, reason: INDEXER_STALE, detail, indexedThrough: null });

/**
 * Wrap a driver with the freshness policy and with failure isolation.
 *
 * DRIVER INTERFACE — `{ load(chainId, sourceKeys) }`, async, returning an array of
 * `{sourceKey, lastBlock, updatedAt}`. It MAY throw; that is condition 3 and is handled
 * here rather than in the driver, so a driver can never accidentally report a failure as
 * an empty-but-fine result.
 */
export function createIndexerState(driver) {
  return {
    /**
     * Is the index provably current enough to read absence from?
     *
     * @param {object} args
     * @param {number} args.chainId
     * @param {string[]} args.sourceKeys  every source `daily_active` requires. Lower-cased
     *   contract addresses — the same set the indexer writes, kept in step by a parity test.
     * @param {number} args.head          current chain head.
     * @param {() => number} [args.now]   injectable clock (ms), for deterministic tests.
     * @returns {Promise<{fresh, reason, detail, indexedThrough}>} `indexedThrough` is the
     *   MINIMUM watermark and is what an index-derived answer must report as
     *   `checkedThroughBlock` — never `head`, which the index has not reached.
     */
    async readFreshness({ chainId, sourceKeys, head, now = () => Date.now() }) {
      if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) {
        // No required sources means nothing was proven, not "proven vacuously" — the same
        // rule coverageProvesAbsence() applies in scan.js.
        return stale("no_required_sources");
      }
      if (!Number.isInteger(head) || head < 0) return stale("no_head");

      // --- 3. THE READ FAILED.
      let rows;
      try {
        rows = await driver.load(chainId, sourceKeys);
      } catch (err) {
        console.error("[quest] indexer_state read failed, treating as stale:", err?.message);
        return stale("read_failed");
      }
      if (!Array.isArray(rows)) return stale("read_failed");

      const byKey = new Map();
      for (const row of rows) {
        const key = typeof row?.sourceKey === "string" ? row.sourceKey.trim().toLowerCase() : "";
        const lastBlock = Number(row?.lastBlock);
        const updatedAt = Date.parse(row?.updatedAt ?? "");
        // A row we cannot read is worse than a row that is absent: absence is honest.
        if (!key || !Number.isInteger(lastBlock) || lastBlock < 0 || !Number.isFinite(updatedAt)) continue;
        byKey.set(key, { lastBlock, updatedAt });
      }

      // --- 1 & 2. A REQUIRED SOURCE IS MISSING, OR THE COUNT IS SHORT.
      // Checking only the rows that came back is exactly how a dropped source becomes a
      // wrong false, so the required list drives the loop — not the result set.
      const present = [];
      for (const raw of sourceKeys) {
        const key = String(raw).trim().toLowerCase();
        const row = byKey.get(key);
        if (!row) return stale(`missing_source:${key}`);
        present.push(row);
      }
      if (present.length !== sourceKeys.length) return stale("source_count_mismatch");

      // MIN across sources: the least-advanced stream decides, in both dimensions.
      const indexedThrough = Math.min(...present.map((r) => r.lastBlock));
      const oldestUpdate = Math.min(...present.map((r) => r.updatedAt));
      const lagMs = maxLagMs();

      // --- 6. HEAD BELOW THE WATERMARK. Must precede the lag check, whose subtraction
      // would otherwise go negative and read as perfect freshness.
      if (head < indexedThrough) return stale("head_behind_watermark");

      // --- 4. THE JOB IS NOT RUNNING.
      const age = now() - oldestUpdate;
      if (age > lagMs) return stale("updated_at_stale");

      // --- 5. THE JOB IS RUNNING BUT LOSING GROUND.
      if (head - indexedThrough > maxLagBlocks({ lagMs })) return stale("block_lag");

      return { fresh: true, reason: null, detail: null, indexedThrough };
    },
  };
}
