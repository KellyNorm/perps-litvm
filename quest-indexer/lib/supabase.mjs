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
        `${STATE_TABLE}?select=source_key,last_block,updated_at&chain_id=eq.${chainId}&source_key=in.(${list})`,
      );
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("indexer_state read returned a non-array");

      return new Map(rows.map((r) => [r.source_key, { lastBlock: Number(r.last_block), updatedAt: r.updated_at }]));
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
  };
}
