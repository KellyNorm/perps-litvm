// Durable verification cache — the Supabase driver behind the cache.js interface.
//
// WHY THIS IS A NEW FILE AND NOT A REWRITE: cache.js defines `{get(key), set(key, value)}`
// and puts the write policy in createCache() ABOVE the driver. So durability is a storage
// swap and nothing else — the rule that only proven completions are ever persisted is not
// this file's to relax, and it is re-asserted here anyway (see `set`) because a policy
// worth having is worth having twice.
//
// NO SDK, ON PURPOSE. This talks to PostgREST over plain fetch. Two reasons: the frontend
// package is a Vite app and adding @supabase/supabase-js to it costs install weight for
// code that only ever runs server-side; and an injectable `fetch` makes every path here
// — hit, miss, HTTP error, network throw, timeout — testable without a network or a
// live project. The wire format is two URLs and a header pair; the SDK would earn nothing.
//
// SERVER-ONLY KEY. SUPABASE_SERVICE_ROLE_KEY bypasses RLS. It must never be given a VITE_
// prefix, or Vite inlines it into the browser bundle and hands every visitor full table
// access. It is read from process.env here, in api/, which Vite never bundles.

import { STATUS } from "./quests.js";
import { isCacheable } from "./cache.js";

/** One-time quests have no day bucket. Stored as '-' rather than '' so the PostgREST
 *  filter `bucket=eq.` — whose empty-string semantics are easy to get wrong — never
 *  arises. The value is opaque; it only has to be stable and non-empty. */
export const ONE_TIME_BUCKET = "-";

const TABLE = "quest_completion";

/**
 * Hot-path timeout. The cache is consulted BEFORE the Tier 1/Tier 2 work, inside a
 * function with a 30s ceiling that a full scan can already spend ~25s of. A hanging
 * Supabase must therefore cost a couple of seconds and then get out of the way — never
 * the request. On timeout we return a miss and verify from chain, which is correct, just
 * slower.
 */
export const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * Split a cacheKey back into columns.
 *
 * cacheKey() builds `chainId:quest:address[:bucket]`, and every component is
 * colon-free by construction — quest ids are snake_case registry keys, addresses are hex,
 * buckets are YYYY-MM-DD. A key that does not parse is NOT an error to raise: it is
 * treated as a miss (and dropped on write), because a malformed key must never take down
 * a verification.
 *
 * @returns {{chainId, quest, wallet, bucket} | null}
 */
export function parseCacheKey(key) {
  if (typeof key !== "string") return null;

  const parts = key.split(":");
  if (parts.length !== 3 && parts.length !== 4) return null;

  const [rawChain, quest, wallet, bucket] = parts;

  const chainId = Number.parseInt(rawChain, 10);
  if (!Number.isFinite(chainId) || String(chainId) !== rawChain) return null;
  if (!quest) return null;
  // cacheKey() lower-cases the address, so anything else did not come from cacheKey().
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return null;
  if (parts.length === 4 && !bucket) return null;

  return { chainId, quest, wallet, bucket: parts.length === 4 ? bucket : ONE_TIME_BUCKET };
}

/**
 * Build the driver, or return null if it is not configured.
 *
 * NULL RATHER THAN THROW: this is constructed lazily inside the request path, so throwing
 * would surface a missing env var as a 503 on every verification — an outage caused by a
 * cache, which is precisely backwards. The caller falls back to the in-memory driver and
 * logs; the endpoint stays correct and merely loses durability.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]        defaults to SUPABASE_URL
 * @param {string} [opts.serviceKey] defaults to SUPABASE_SERVICE_ROLE_KEY
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 */
export function supabaseCacheDriver(opts = {}) {
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

  /** Abort-on-timeout wrapper. Returns null on ANY failure — see the interface contract. */
  async function request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // init.headers must win over the defaults, or `prefer` (which is what makes the
      // write an upsert rather than a duplicate-key error) would be spread away.
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
     * A row means one thing: this wallet proved this quest. The verdict is reconstructed
     * from that fact rather than read out of columns, because the columns that would
     * carry a verdict do not exist — see the migration.
     */
    async get(key) {
      const k = parseCacheKey(key);
      if (!k) return null;

      try {
        const query =
          `${TABLE}?select=checked_through_block` +
          `&chain_id=eq.${k.chainId}` +
          `&wallet=eq.${encodeURIComponent(k.wallet)}` +
          `&quest=eq.${encodeURIComponent(k.quest)}` +
          `&bucket=eq.${encodeURIComponent(k.bucket)}` +
          `&limit=1`;

        const res = await request(query, { method: "GET" });
        if (!res?.ok) {
          console.error(`[quest] supabase cache read HTTP ${res?.status}, treating as miss`);
          return null;
        }

        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;

        return {
          completed: true,
          status: STATUS.CONFIRMED,
          // resolveQuest() overwrites `source` with "cache"; the block is the useful part.
          checkedThroughBlock: rows[0].checked_through_block ?? null,
        };
      } catch (err) {
        console.error("[quest] supabase cache read failed, treating as miss:", err?.message);
        return null;
      }
    },

    /**
     * Upsert the completion. Idempotent by primary key, so a re-verification of an
     * already-proven wallet is a no-op write rather than a duplicate.
     *
     * The isCacheable() guard is redundant behind createCache() and is here anyway: this
     * driver is the thing holding the durable, cross-instance, cross-deploy record, so it
     * is the last place that should trust a caller to have filtered correctly.
     */
    async set(key, value) {
      if (!isCacheable(value)) return;

      const k = parseCacheKey(key);
      if (!k) {
        console.error("[quest] supabase cache write skipped: unparseable key");
        return;
      }

      try {
        const res = await request(`${TABLE}?on_conflict=chain_id,wallet,quest,bucket`, {
          method: "POST",
          headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            chain_id: k.chainId,
            wallet: k.wallet,
            quest: k.quest,
            bucket: k.bucket,
            checked_through_block: value.checkedThroughBlock ?? null,
            source: value.source ?? null,
          }),
        });

        if (!res?.ok) {
          console.error(`[quest] supabase cache write HTTP ${res?.status}, continuing`);
        }
      } catch (err) {
        console.error("[quest] supabase cache write failed, continuing:", err?.message);
      }
    },
  };
}
