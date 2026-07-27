// PostgREST reader for the indexer's two tables — the read half of what quest-indexer/ writes.
//
// Same shape and reasoning as supabaseCursor.js: plain fetch, injectable transport,
// AbortController timeout, `init.headers` must win over the defaults. Read that header for
// the full argument about why there is no SDK here.
//
// ============================================================================
// THIS DRIVER THROWS. THE ONE PLACE IN THE READ PATH THAT DOES.
// ============================================================================
// supabaseCache.js and supabaseCursor.js swallow every failure and return a miss, because
// there a failed read costs a re-verification and nothing else. Here it is the opposite: a
// failed `load()` reported as "no rows" would be indistinguishable from "the indexer has
// never run", and both of those must make the answer stale rather than absent.
//
// So `load()` propagates, and createIndexerState() catches it as fail-closed condition 3.
// Putting the catch in the POLICY rather than the driver is deliberate — a driver that
// swallowed its own errors could never be made to fail closed by the layer above it.
//
// `hasDailyRow()` also throws, for the same reason: an unreadable quest_daily must not be
// reported as an absent row.

const STATE_TABLE = "indexer_state";
const DAILY_TABLE = "quest_daily";

/**
 * Hot-path timeout, matching the other read-path drivers. This read happens BEFORE the
 * tail scan inside a function with a 30s ceiling, so a hanging Supabase must cost a couple
 * of seconds and then get out of the way — as a stale answer, which is the safe direction.
 */
export const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * Build the driver, or return null if it is not configured — never throw at construction.
 * Same reasoning as supabaseCursor.js: this is built lazily in the request path, so a throw
 * would turn a missing env var into a 503 on every verification. A null driver makes
 * `daily_active` permanently stale, which is honest and is exactly what an unconfigured
 * index deserves.
 */
export function supabaseIndexerStateDriver(opts = {}) {
  const url = (opts.url ?? process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const serviceKey = (opts.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!url || !serviceKey || typeof doFetch !== "function") return null;

  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };

  async function request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${url}/rest/v1/${path}`, { method: "GET", headers, signal: controller.signal });
      if (!res?.ok) throw new Error(`${path} → HTTP ${res?.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Watermarks for the given sources, in one request.
     *
     * Returns only the rows that exist — the policy compares the result against the REQUIRED
     * list and treats any gap as stale. Filtering here rather than fetching the whole table
     * keeps the response bounded, but the correctness check is deliberately not this
     * driver's job.
     */
    async load(chainId, sourceKeys) {
      const list = sourceKeys.map((k) => `"${String(k).toLowerCase()}"`).join(",");
      const res = await request(
        `${STATE_TABLE}?select=source_key,last_block,updated_at,completion_from` +
          `&chain_id=eq.${chainId}&source_key=in.(${list})`,
      );

      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("indexer_state read returned a non-array");

      // bigint may serialize as a number or a string; the policy parses and validates.
      return rows.map((r) => ({
        sourceKey: r.source_key,
        lastBlock: Number(r.last_block),
        updatedAt: r.updated_at,
        // NULL STAYS NULL. It means "the indexer has not yet told us from where completions
        // have been written", and coercing it to a number here would manufacture the
        // coverage claim 0005_quest_backfill.sql exists to refuse. The freshness policy does
        // not read it at all; indexProof.js fails closed on it.
        completionFrom: r.completion_from == null ? null : Number(r.completion_from),
      }));
    },

    /**
     * Is there a participation row for this wallet on this UTC day?
     *
     * ROW EXISTENCE IS THE FACT — there is no `active` boolean to read, by design, so
     * "indexed and inactive" and "not indexed" cannot be conflated in storage. The only
     * thing that can tell those apart is indexer_state, which is why the freshness gate runs
     * before this ever does.
     */
    async hasDailyRow({ chainId, wallet, day }) {
      const res = await request(
        `${DAILY_TABLE}?select=wallet&chain_id=eq.${chainId}` +
          `&wallet=eq.${encodeURIComponent(String(wallet).toLowerCase())}` +
          `&day=eq.${encodeURIComponent(day)}&limit=1`,
      );

      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("quest_daily read returned a non-array");
      return rows.length > 0;
    },
  };
}
