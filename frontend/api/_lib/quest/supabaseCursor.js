// Durable coverage cursor — the Supabase driver behind the cursor.js interface.
//
// Same shape, same reasoning and the same plain-fetch/PostgREST approach as
// supabaseCache.js (read the header there for why no SDK and why the service-role key must
// never carry a VITE_ prefix). Two differences worth stating, both consequences of this
// table holding COVERAGE rather than verdicts:
//
//   1. WRITES ARE BULK. A multi-source quest advances several intervals in one poll, and
//      they must land together: PostgREST upserts an array in one round trip, so
//      first_prediction's two factories cost one request, not two.
//
//   2. A FAILURE HERE IS CHEAPER THAN A FAILURE THERE. Losing a cache write loses a proven
//      completion and forces a full re-verification. Losing a cursor write loses only the
//      blocks this poll walked — the next poll re-walks them. So every path below returns
//      empty/void on error rather than propagating, and the scan is never told.

const TABLE = "quest_cursor";

/**
 * Hot-path timeout, matching supabaseCache.js. The load happens BEFORE the scan inside a
 * function with a 30s ceiling that the scan can already spend ~25s of, so a hanging
 * Supabase must cost a couple of seconds and get out of the way. On timeout the walk simply
 * restarts from head.
 */
export const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * Build the driver, or return null if it is not configured — never throw. Constructed
 * lazily in the request path, so a throw would turn a missing env var into a 503 on every
 * verification: an outage caused by an optimisation, which is backwards.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]        defaults to SUPABASE_URL
 * @param {string} [opts.serviceKey] defaults to SUPABASE_SERVICE_ROLE_KEY
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 */
export function supabaseCursorDriver(opts = {}) {
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

  async function request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // init.headers must win, or `prefer` — which is what makes the write an upsert rather
      // than a duplicate-key error — would be spread away.
      return await doFetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Every source's coverage for one (chain, wallet, quest), in one request. The floor is
     * selected alongside the interval because the caller cannot judge the interval without
     * it: coverage computed against a since-changed floor is void (see isUsablePrior).
     *
     * Returns [] on any failure, which reads downstream as "no coverage yet" — a slower
     * poll, never a wrong one.
     */
    async load(id) {
      try {
        const query =
          `${TABLE}?select=source_key,floor_block,scanned_from,scanned_to` +
          `&chain_id=eq.${id.chainId}` +
          `&wallet=eq.${encodeURIComponent(id.wallet)}` +
          `&quest=eq.${encodeURIComponent(id.quest)}`;

        const res = await request(query, { method: "GET" });
        if (!res?.ok) {
          console.error(`[quest] cursor read HTTP ${res?.status}, restarting the walk from head`);
          return [];
        }

        const rows = await res.json();
        if (!Array.isArray(rows)) return [];

        // bigint columns may serialize as JSON numbers or strings depending on PostgREST
        // settings; block heights are far below 2^53 either way. normalizeCoverageRow()
        // parses and validates — this only renames.
        return rows.map((r) => ({
          sourceKey: r.source_key,
          floorBlock: r.floor_block,
          scannedFrom: r.scanned_from,
          scannedTo: r.scanned_to,
        }));
      } catch (err) {
        console.error("[quest] cursor read failed, restarting the walk from head:", err?.message);
        return [];
      }
    },

    /**
     * Bulk upsert, idempotent by primary key. `updated_at` is left to the column default so
     * the row's timestamp is the database's, not a lambda's clock.
     */
    async save(id, rows) {
      try {
        const res = await request(`${TABLE}?on_conflict=chain_id,wallet,quest,source_key`, {
          method: "POST",
          headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(
            rows.map((row) => ({
              chain_id: id.chainId,
              wallet: id.wallet,
              quest: id.quest,
              source_key: row.sourceKey,
              floor_block: row.floorBlock,
              scanned_from: row.scannedFrom,
              scanned_to: row.scannedTo,
            })),
          ),
        });

        if (!res?.ok) {
          console.error(`[quest] cursor write HTTP ${res?.status}, continuing`);
        }
      } catch (err) {
        console.error("[quest] cursor write failed, continuing:", err?.message);
      }
    },
  };
}
