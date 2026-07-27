// PostgREST driver for the indexer's writes.
//
// Same shape and same reasoning as frontend/api/_lib/quest/supabaseCursor.js — plain fetch,
// no SDK, injectable transport, AbortController timeout, `init.headers` must win over the
// defaults or `prefer` (which is what makes a write an upsert rather than a duplicate-key
// error) gets spread away. Read that file's header for the full argument.
//
// ONE DIFFERENCE, AND IT IS THE IMPORTANT ONE. Everywhere else in this codebase a failed
// write costs latency and nothing else, so the drivers swallow errors and continue. Here a
// swallowed error is a wrong answer: if `writeDaily` fails and `advance` still runs, the
// watermark claims to cover blocks whose rows were never written, and `daily_active` reads
// that absence as "this wallet did nothing". So:
//
//     EVERY FUNCTION HERE THROWS ON FAILURE. The caller must not catch-and-advance.
//
// The ordering rule that depends on it is in indexer.mjs: rows first, watermark only on
// success, and never advance a range that failed. The reverse ordering leaves a window
// where a verify sees a fresh watermark and no row — the one wrong-false this whole step
// exists to prevent.

const STATE_TABLE = "indexer_state";
const DAILY_TABLE = "quest_daily";
const CURSOR_TABLE = "quest_cursor";
const COMPLETION_TABLE = "quest_completion";
const BACKFILL_TABLE = "quest_backfill";

/**
 * One-time quests have no day bucket. MUST equal ONE_TIME_BUCKET in
 * api/_lib/quest/supabaseCache.js — the read path looks completions up under this exact
 * value, so a mismatch would make every settled completion invisible. Parity-tested.
 */
export const ONE_TIME_BUCKET = "-";

/**
 * Generous compared to the read path's 2.5s. That number is a hot-path budget inside a
 * request with a 30s ceiling; this is a background service with no user waiting, and a
 * bulk write of a busy range is worth waiting for rather than retrying.
 */
export const DEFAULT_TIMEOUT_MS = 8_000;

export function createSupabaseWriter({ url, serviceKey, fetch: doFetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = (url ?? process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  // THROWS rather than returning null, unlike the read-path drivers. There, a missing env
  // var costs durability and the endpoint stays correct; here it means the service has
  // nothing to do, and it should die loudly on startup rather than run forever writing
  // nothing while the watermark it never advances reads as permanently stale.
  if (!base || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required");
  }
  if (typeof doFetch !== "function") throw new Error("no fetch implementation available");

  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/rest/v1/${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!res?.ok) {
        const body = await res?.text?.().catch(() => "") ?? "";
        throw new Error(`supabase ${init.method ?? "GET"} ${path} → HTTP ${res?.status} ${body.slice(0, 200)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Current watermarks for the given sources. Missing sources are simply absent from the
     * result — the caller treats that as "never indexed" and starts from the source's floor.
     */
    async loadState(chainId, sourceKeys) {
      const list = sourceKeys.map((k) => `"${k}"`).join(",");
      const res = await request(
        `${STATE_TABLE}?select=source_key,last_block,updated_at,completion_from&chain_id=eq.${chainId}&source_key=in.(${list})`,
      );
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("indexer_state read returned a non-array");

      return new Map(
        rows.map((r) => [
          r.source_key,
          {
            lastBlock: Number(r.last_block),
            updatedAt: r.updated_at,
            // NULL stays null, deliberately — it means "not yet proven", and coercing it to
            // a number here would manufacture the coverage claim 0005 refuses to invent.
            completionFrom: r.completion_from == null ? null : Number(r.completion_from),
          },
        ]),
      );
    },

    /**
     * Insert participation rows. Idempotent by primary key, because the cron is at-least-once:
     * a restart overlap or a retried range must be a no-op, not a duplicate-key error. That
     * idempotence is what makes the overlap-on-resume strategy safe.
     *
     * Empty input is a no-op that still counts as success — a range with no activity is the
     * common case and must not block the watermark.
     */
    async writeDaily(rows) {
      if (rows.length === 0) return 0;

      await request(`${DAILY_TABLE}?on_conflict=chain_id,wallet,day`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(
          rows.map((r) => ({
            chain_id: r.chainId,
            wallet: r.wallet,
            // Bare YYYY-MM-DD. A full ISO timestamp into a `date` column casts using the
            // SESSION timezone, which is UTC on Supabase — until one day it is not.
            day: r.day,
            first_seen_block: r.firstSeenBlock ?? null,
            first_seen_via: r.firstSeenVia ?? null,
          })),
        ),
      });

      return rows.length;
    },

    /**
     * Record proven completions in bulk. The forward indexer's and the backfill's ONLY
     * positive write.
     *
     * There is nothing to get wrong about the direction here, and that is structural rather
     * than careful: quest_completion has no `completed` and no `status` column, so a row's
     * EXISTENCE is the completion (0001) and "this wallet did NOT do it" has no
     * representation. The only thing this function can do is assert positives, and it is
     * called only with wallets that appeared in a log.
     *
     * IGNORE-DUPLICATES, not merge. A completion may already exist from a user poll or the
     * settler, recorded against a block those knew more about than we do; the row's
     * existence is the fact, so overwriting its `checked_through_block` with ours would be
     * churn that can only lose information. An empty batch is a successful no-op — a range
     * with no activity is the common case and must never block the watermark.
     */
    async writeCompletions(rows) {
      if (rows.length === 0) return 0;

      await request(`${COMPLETION_TABLE}?on_conflict=chain_id,wallet,quest,bucket`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(
          rows.map((r) => ({
            chain_id: r.chainId,
            wallet: r.wallet,
            quest: r.quest,
            bucket: ONE_TIME_BUCKET,
            checked_through_block: r.checkedThroughBlock ?? null,
            source: r.source ?? "indexer",
          })),
        ),
      });

      return rows.length;
    },

    /**
     * Claim `completion_from` for a source — the first block from which completions have
     * been written. THE HANDOFF WATERMARK; see 0005_quest_backfill.sql for why it exists.
     *
     * SET ONCE, NEVER MOVED, and the `completion_from=is.null` filter is what enforces it.
     * That guard is the whole function:
     *
     *   * A later run finds the column already set, matches no row, and is a silent no-op —
     *     so the recorded value stays the FIRST one, which is the only one that describes
     *     contiguous coverage.
     *   * Two racing runs both see null; whichever lands second matches nothing. Either
     *     value is safe, because both are ranges whose completions actually landed.
     *
     * If the row does not exist yet (a brand-new source, first ever run) this matches
     * nothing and `advance` creates the row with a null column; the NEXT run claims it, one
     * range higher. HIGHER IS THE SAFE DIRECTION — the read path checks
     * `covered_from >= completion_from - 1`, so a higher value demands MORE of the backfill,
     * never less. That is why this may be lossy but can never be wrong.
     */
    async claimCompletionFrom(chainId, sourceKey, block) {
      const res = await request(
        `${STATE_TABLE}?chain_id=eq.${chainId}&source_key=eq.${encodeURIComponent(sourceKey)}&completion_from=is.null`,
        {
          method: "PATCH",
          headers: { ...headers, prefer: "return=representation" },
          // last_block is deliberately ABSENT: this must not be able to move the watermark.
          body: JSON.stringify({ completion_from: block }),
        },
      );

      const updated = await res.json();
      return Array.isArray(updated) && updated.length > 0 ? "claimed" : "already_set";
    },

    /**
     * Advance a source's watermark to `lastBlock` — but never backward.
     *
     * THE GUARD (`last_block=lte.N`) is what makes concurrent or overlapping runs safe. Two
     * runs racing after a restart both read the same watermark, scan overlapping ranges, and
     * both try to write; without the guard the slower one lands last and drags the watermark
     * back, re-opening a window it had already closed. With it, a stale write matches no row
     * and does nothing.
     *
     * `lte`, NOT `lt`: an EQUAL value must still refresh `updated_at`. On a quiet chain a run
     * can legitimately find no new blocks, and if that left the timestamp untouched the
     * wall-clock freshness check would eventually declare a perfectly healthy indexer dead.
     *
     * `updated_at` is set from this process's clock because a PATCH does not fire the column
     * default. That introduces clock skew between this service and the Vercel reader — which
     * is why the freshness check treats BLOCK lag as primary (both sides read block numbers,
     * so it is clock-free) and wall-clock age only as the "is it running at all" signal.
     */
    async advance(chainId, sourceKey, lastBlock, { now = () => new Date() } = {}) {
      const patch = await request(
        `${STATE_TABLE}?chain_id=eq.${chainId}&source_key=eq.${encodeURIComponent(sourceKey)}&last_block=lte.${lastBlock}`,
        {
          method: "PATCH",
          headers: { ...headers, prefer: "return=representation" },
          body: JSON.stringify({ last_block: lastBlock, updated_at: now().toISOString() }),
        },
      );

      const updated = await patch.json();
      if (Array.isArray(updated) && updated.length > 0) return "advanced";

      // Zero rows matched: either this source has no row yet, or a newer run already moved
      // the watermark past us. Try to create; `ignore-duplicates` makes the second case a
      // silent no-op rather than a 409.
      const insert = await request(`${STATE_TABLE}?on_conflict=chain_id,source_key`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ chain_id: chainId, source_key: sourceKey, last_block: lastBlock }),
      });

      const created = await insert.json();
      return Array.isArray(created) && created.length > 0 ? "created" : "superseded";
    },

    // ========================================================================
    // THE BACKFILL'S READS AND WRITES
    // ========================================================================

    /**
     * Current backfill coverage for the given sources. Missing sources are simply absent —
     * the caller treats that as "never swept" and starts a fresh pass from the head.
     */
    async loadBackfill(chainId, sourceKeys) {
      const list = sourceKeys.map((k) => `"${k}"`).join(",");
      const res = await request(
        `${BACKFILL_TABLE}?select=source_key,floor_block,covered_from,covered_to,updated_at` +
          `&chain_id=eq.${chainId}&source_key=in.(${list})`,
      );
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("quest_backfill read returned a non-array");

      return new Map(
        rows.map((r) => [
          r.source_key,
          {
            floorBlock: Number(r.floor_block),
            coveredFrom: Number(r.covered_from),
            coveredTo: Number(r.covered_to),
            updatedAt: r.updated_at,
          },
        ]),
      );
    },

    /**
     * Open a pass: fix the ceiling and start the coverage empty at it.
     *
     * MERGE-DUPLICATES, and called ONLY when the caller has decided there is no usable row —
     * absent, or computed against a floor that no longer matches. In the second case the old
     * coverage is void and must be discarded wholesale, which is exactly what merging a
     * fresh `covered_to = covered_from` does. Calling this on a resumable row would silently
     * throw away a completed sweep, so the decision lives in the planner and not here.
     *
     * `covered_from` is set once, here, and never moves again — it is the handoff point the
     * read path checks against `completion_from`, and moving it later would claim coverage
     * of blocks that nothing swept.
     */
    async startBackfill({ chainId, sourceKey, floorBlock, coveredFrom }, { now = () => new Date() } = {}) {
      await request(`${BACKFILL_TABLE}?on_conflict=chain_id,source_key`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          chain_id: chainId,
          source_key: sourceKey,
          floor_block: floorBlock,
          covered_from: coveredFrom,
          // Empty coverage: the interval is a single block until the first chunk lands.
          covered_to: coveredFrom,
          updated_at: now().toISOString(),
        }),
      });
    },

    /**
     * Extend a pass's coverage DOWNWARD. The backfill's only coverage write.
     *
     * THREE GUARDS, the same shape as extendCursorDown and for the same reasons:
     *
     *   1. `covered_to=gte.N` means this can only ever move coverage DOWN. A replayed or
     *      concurrent slice holding a staler frontier matches no row and is a no-op, rather
     *      than dragging the frontier back up and discarding swept blocks.
     *   2. `floor_block=eq.N` pins the row to the floor the caller PLANNED against. If the
     *      configured floor changed underneath a running slice, the write fails to match
     *      instead of extending coverage that was computed against a different contract.
     *   3. There is no `covered_from` in the body. The ceiling belongs to startBackfill and
     *      is set once; a writer that could raise it could claim unswept blocks.
     *
     * No verdict here and no column that could hold one — quest_backfill stores which blocks
     * were read, and nothing else.
     */
    async extendBackfillDown({ chainId, sourceKey, floorBlock, coveredTo }, { now = () => new Date() } = {}) {
      const res = await request(
        `${BACKFILL_TABLE}?chain_id=eq.${chainId}&source_key=eq.${encodeURIComponent(sourceKey)}` +
          `&covered_to=gte.${coveredTo}&floor_block=eq.${floorBlock}`,
        {
          method: "PATCH",
          headers: { ...headers, prefer: "return=representation" },
          body: JSON.stringify({ covered_to: coveredTo, updated_at: now().toISOString() }),
        },
      );

      const updated = await res.json();
      return Array.isArray(updated) && updated.length > 0 ? "extended" : "superseded";
    },

    // ========================================================================
    // THE SETTLER'S READS AND WRITES
    // ========================================================================

    /**
     * A bounded page of cursor rows to consider settling.
     *
     * Ordered by `updated_at` ascending so the page ROTATES — the least recently worked
     * rows surface first, and no row can be permanently invisible behind a full page of
     * others. The final choice among them is made in memory (see settler.mjs), because the
     * useful ordering is by REMAINING work, which is `scanned_to - floor_block` and cannot
     * be expressed as a PostgREST column filter.
     *
     * The page bound is real and is logged when it truncates: a silent cap would read as
     * "considered everything" when it did not.
     */
    async pickCursorCandidates(chainId, limit) {
      const res = await request(
        `${CURSOR_TABLE}?select=wallet,quest,source_key,floor_block,scanned_from,scanned_to,updated_at` +
          `&chain_id=eq.${chainId}&order=updated_at.asc&limit=${limit}`,
      );
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("quest_cursor read returned a non-array");

      return rows.map((r) => ({
        wallet: r.wallet,
        quest: r.quest,
        sourceKey: r.source_key,
        floorBlock: Number(r.floor_block),
        scannedFrom: Number(r.scanned_from),
        scannedTo: Number(r.scanned_to),
        updatedAt: r.updated_at,
      }));
    },

    /** Is this (wallet, quest) already proven complete? Then there is nothing to settle. */
    async hasCompletion(chainId, wallet, quest) {
      const res = await request(
        `${COMPLETION_TABLE}?select=wallet&chain_id=eq.${chainId}` +
          `&wallet=eq.${encodeURIComponent(wallet)}&quest=eq.${encodeURIComponent(quest)}` +
          `&bucket=eq.${encodeURIComponent(ONE_TIME_BUCKET)}&limit=1`,
      );
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0;
    },

    /**
     * Extend one source's coverage DOWNWARD. The settler's only cursor write.
     *
     * THREE GUARANTEES, and they are the reason this is its own function rather than a
     * general update:
     *
     *   1. THE BODY CONTAINS NO `scanned_from`. The top of the interval is the read path's
     *      to move, because only it knows the current head. Advancing the top over an
     *      unclosed gap is one of the two ways to punch a hole in coverage, and this writer
     *      cannot express it.
     *   2. `scanned_to=gte.N` MEANS THIS CAN ONLY EVER MOVE COVERAGE DOWN. If a concurrent
     *      verify already walked deeper, its (lower) value does not match and this is a
     *      no-op — rather than dragging the frontier back up and silently discarding
     *      coverage the read path is relying on.
     *   3. `floor_block=lte.N` keeps the table's `scanned_to >= floor_block` CHECK
     *      satisfied, so a floor/address mix-up fails the write instead of writing an
     *      interval that claims to have read below the contract's first block.
     *
     * There is no verdict here and no column that could hold one — quest_cursor has neither
     * by design. This writes COVERAGE, which is a fact about work done.
     */
    async extendCursorDown({ chainId, wallet, quest, sourceKey, scannedTo }, { now = () => new Date() } = {}) {
      const res = await request(
        `${CURSOR_TABLE}?chain_id=eq.${chainId}` +
          `&wallet=eq.${encodeURIComponent(wallet)}&quest=eq.${encodeURIComponent(quest)}` +
          `&source_key=eq.${encodeURIComponent(sourceKey)}` +
          `&scanned_to=gte.${scannedTo}&floor_block=lte.${scannedTo}`,
        {
          method: "PATCH",
          headers: { ...headers, prefer: "return=representation" },
          // scanned_from is deliberately ABSENT. See guarantee 1.
          body: JSON.stringify({ scanned_to: scannedTo, updated_at: now().toISOString() }),
        },
      );

      const updated = await res.json();
      return Array.isArray(updated) && updated.length > 0 ? "extended" : "superseded";
    },

    /**
     * Record a proven completion. Called ONLY when a matching log was actually found.
     *
     * The table has no `completed` and no `status` column — a row's EXISTENCE is the
     * completion (0001_quest_completion.sql). So there is no way to express a stored false
     * here even by mistake: the only thing this function can do is assert a positive, and
     * the settler only calls it on a hit.
     */
    async writeCompletion({ chainId, wallet, quest, checkedThroughBlock }) {
      await request(`${COMPLETION_TABLE}?on_conflict=chain_id,wallet,quest,bucket`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          chain_id: chainId,
          wallet,
          quest,
          bucket: ONE_TIME_BUCKET,
          checked_through_block: checkedThroughBlock ?? null,
          source: "settler",
        }),
      });
    },
  };
}
