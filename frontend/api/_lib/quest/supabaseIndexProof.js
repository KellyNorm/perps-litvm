// PostgREST reader for the two tables the zero-chunk negative is derived from:
// quest_backfill (the sweep's coverage) and quest_completion (the positives it found).
//
// Same shape and reasoning as the other read-path drivers — plain fetch, injectable
// transport, AbortController timeout, `init.headers` must win over the defaults. Read
// supabaseCursor.js's header for the full argument about why there is no SDK here.
//
// ============================================================================
// BOTH METHODS THROW. THAT IS THE POINT OF THIS FILE EXISTING.
// ============================================================================
// quest_completion is ALREADY readable through supabaseCache.js — and that driver returns
// null on an HTTP error, a timeout and a genuine miss alike, because there a failed read
// costs a re-verification and nothing else.
//
// This driver's caller turns "no row" into a CONFIRMED FALSE. Under that caller, a
// swallowed error is a wrong answer about a real trader. So the failure is propagated and
// indexProof.js degrades it to `unproven`, which falls back to the ordinary scan.
//
// Putting the throw in the driver and the catch in the policy is the same division
// supabaseIndexerState.js makes, and for the same reason: a driver that swallowed its own
// errors could never be made to fail closed by the layer above it.

const BACKFILL_TABLE = "quest_backfill";
const COMPLETION_TABLE = "quest_completion";

/**
 * One-time quests have no day bucket. MUST equal ONE_TIME_BUCKET in supabaseCache.js and in
 * quest-indexer/lib/supabase.mjs — all three address the same rows, and a mismatch would
 * make every backfilled completion invisible, which reads as a proven false for every
 * wallet the sweep found. Parity-tested.
 */
export const ONE_TIME_BUCKET = "-";

/**
 * Hot-path timeout, matching the other read-path drivers. These reads happen INSTEAD of a
 * ~10s scan, inside a function with a 30s ceiling; a hanging Supabase must cost a couple of
 * seconds and then get out of the way — as `unproven`, which is the safe direction.
 */
export const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * Build the driver, or return null if it is not configured — never throw at construction.
 * Same reasoning as every other read-path driver: this is built lazily in the request path,
 * so a throw would turn a missing env var into a 503 on every verification. A null driver
 * disables the fast path, and the endpoint falls back to the scan it used before.
 */
export function supabaseIndexProofDriver(opts = {}) {
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
     * The sweep's coverage for the given sources, in one request.
     *
     * Returns only the rows that exist. The policy compares the result against the REQUIRED
     * list and treats any gap as unproven — checking only what came back is exactly how a
     * dropped source becomes a wrong false, so that check is deliberately not this driver's
     * job.
     *
     * @returns {Promise<Map<string, {floorBlock, coveredFrom, coveredTo}>>}
     */
    async loadBackfill(chainId, sourceKeys) {
      const list = sourceKeys.map((k) => `"${String(k).toLowerCase()}"`).join(",");
      const res = await request(
        `${BACKFILL_TABLE}?select=source_key,floor_block,covered_from,covered_to` +
          `&chain_id=eq.${chainId}&source_key=in.(${list})`,
      );

      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("quest_backfill read returned a non-array");

      // bigint may serialize as a number or a string; the policy re-validates every field
      // before it is allowed to count toward a proven negative.
      return new Map(
        rows.map((r) => [
          String(r.source_key ?? "").toLowerCase(),
          {
            floorBlock: Number(r.floor_block),
            coveredFrom: Number(r.covered_from),
            coveredTo: Number(r.covered_to),
          },
        ]),
      );
    },

    /**
     * Is there a completion row for this (chain, wallet, quest)?
     *
     * ROW EXISTENCE IS THE FACT — quest_completion has no `completed` column by design
     * (0001), so "proven completion" and "no record" cannot be conflated in storage. The
     * only thing that can tell "no record" from "we could not look" is whether this threw.
     *
     * @returns {Promise<{found: boolean, checkedThroughBlock: number|null}>}
     */
    async readCompletion({ chainId, wallet, quest }) {
      const res = await request(
        `${COMPLETION_TABLE}?select=checked_through_block&chain_id=eq.${chainId}` +
          `&wallet=eq.${encodeURIComponent(String(wallet).toLowerCase())}` +
          `&quest=eq.${encodeURIComponent(quest)}` +
          `&bucket=eq.${encodeURIComponent(ONE_TIME_BUCKET)}&limit=1`,
      );

      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("quest_completion read returned a non-array");
      if (rows.length === 0) return { found: false, checkedThroughBlock: null };

      // The column is nullable, and `Number(null)` is 0 — which would report a completion as
      // proven through the genesis block. Null in, null out.
      const raw = rows[0].checked_through_block;
      const block = raw == null ? NaN : Number(raw);
      return { found: true, checkedThroughBlock: Number.isInteger(block) ? block : null };
    },
  };
}
