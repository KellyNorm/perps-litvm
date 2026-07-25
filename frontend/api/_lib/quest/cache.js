// Verification cache: driver interface + the write policy.
//
// THE POLICY IS ENFORCED HERE, NOT AT THE CALL SITES. `set()` silently drops anything
// that is not a confirmed completion, so no future caller — however careless — can
// persist a negative. That is deliberate: the one bug that would matter on this endpoint
// is a wallet being told "not completed" forever because a scan timed out once, and a
// policy that lives in the storage layer cannot be forgotten by the code above it.
//
// Cacheable:      completed === true && status === confirmed  (proof; never expires)
// NOT cacheable:  every false, every indeterminate, every unavailable
//
// A false is not cached even when confirmed, because it is only true until the moment the
// user does the thing — which, this being a quest board, is what they are about to do.
//
// DRIVER INTERFACE — { get(key), set(key, value) }, both async:
//   get → the stored value, or null on a miss. Must never throw; a broken cache degrades
//         to a live check, it does not fail the request.
//   set → persist. Must never throw for the same reason.
// Stage 1 ships nullCacheDriver (always misses). memoryCacheDriver lands in stage 4 and
// a Supabase driver in phase 2 — the interface is the whole reason that is a new file
// rather than a rewrite.

import { STATUS } from "./quests.js";

/** No-op driver: every read misses, every write is dropped. */
export function nullCacheDriver() {
  return {
    async get() {
      return null;
    },
    async set() {},
  };
}

// Bounds memory for the in-process driver. A confirmed completion is a small object and
// entries are only ever added on proof, so this is far above any plausible warm-instance
// working set; it exists so a long-lived instance cannot grow without limit.
const MAX_ENTRIES = 50_000;

/**
 * In-process cache. Entries survive only for the life of a warm lambda instance, and
 * instances are neither shared nor durable — so this is a LATENCY optimisation, not a
 * source of truth. Two things follow, and both are fine:
 *   - a cold start re-verifies from chain (correct, just slower);
 *   - two instances can hold the same entry (identical value — it is a proven completion).
 *
 * What it must never do is remember a negative, and it cannot: createCache() filters
 * writes before they reach any driver.
 *
 * DURABILITY IS PHASE 2 (Supabase). The driver interface exists so that is a new file
 * rather than a rewrite; the service-role key for it is SERVER-ONLY and must never be
 * given a VITE_ prefix, or Vite would inline it into the browser bundle.
 */
export function memoryCacheDriver() {
  const entries = new Map();

  return {
    async get(key) {
      return entries.get(key) ?? null;
    },

    async set(key, value) {
      // Re-inserting moves the key to the end of Map iteration order, which is what makes
      // the eviction below oldest-first.
      entries.delete(key);
      entries.set(key, value);

      if (entries.size > MAX_ENTRIES) {
        const overflow = entries.size - MAX_ENTRIES;
        let dropped = 0;
        for (const k of entries.keys()) {
          entries.delete(k);
          if (++dropped >= overflow) break;
        }
      }
    },

    // Test seams. `_keys` is insertion-ordered, which is also eviction order.
    _size: () => entries.size,
    _keys: () => [...entries.keys()],
  };
}

/** UTC day stamp (YYYY-MM-DD) for daily quests' cache keys. */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Cache key. Namespaced by chain id so a testnet answer can never satisfy a mainnet quest
 * — the same wallet exists on both. Address is lower-cased so checksum casing does not
 * split the key. `bucket` carries the UTC day for daily quests and is absent otherwise,
 * which is what makes a daily `true` expire without any TTL machinery.
 */
export function cacheKey({ chainId, quest, address, bucket = null }) {
  const base = `${chainId}:${quest}:${String(address).toLowerCase()}`;
  return bucket ? `${base}:${bucket}` : base;
}

/** True only for a proven completion — the sole thing this cache is allowed to keep. */
export function isCacheable(result) {
  return Boolean(result) && result.completed === true && result.status === STATUS.CONFIRMED;
}

/**
 * Wraps a driver with the write policy and with failure isolation: a driver that throws
 * degrades to a cache miss rather than failing the verification.
 */
export function createCache(driver) {
  return {
    async get(key) {
      try {
        return (await driver.get(key)) ?? null;
      } catch (err) {
        console.error("[quest] cache read failed, treating as miss:", err?.message);
        return null;
      }
    },

    async set(key, result) {
      if (!isCacheable(result)) return false;
      try {
        await driver.set(key, result);
        return true;
      } catch (err) {
        console.error("[quest] cache write failed, continuing:", err?.message);
        return false;
      }
    },
  };
}
