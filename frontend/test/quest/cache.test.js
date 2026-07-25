// The cache's write POLICY is the thing under test here, not its storage.
//
// The one bug that would actually hurt on this endpoint is a wallet being told "not
// completed" forever because a scan timed out once. createCache() is where that is made
// structurally impossible, so these tests pin it hard.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import {
  cacheKey,
  createCache,
  isCacheable,
  memoryCacheDriver,
  nullCacheDriver,
  utcDay,
} from "../../api/_lib/quest/cache.js";
import { STATUS } from "../../api/_lib/quest/quests.js";

const ADDRESS = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";

const confirmedTrue = { completed: true, status: STATUS.CONFIRMED };
const confirmedFalse = { completed: false, status: STATUS.CONFIRMED };
const indeterminate = { completed: false, status: STATUS.INDETERMINATE };
const unavailable = { completed: false, status: STATUS.UNAVAILABLE };

/** Recording driver, so we can assert on what actually reached storage. */
function spyDriver({ throwOnGet = false, throwOnSet = false } = {}) {
  const store = new Map();
  return {
    store,
    async get(key) {
      if (throwOnGet) throw new Error("driver exploded");
      return store.get(key) ?? null;
    },
    async set(key, value) {
      if (throwOnSet) throw new Error("driver exploded");
      store.set(key, value);
    },
  };
}

describe("cacheability policy", () => {
  test("only a confirmed completion is cacheable", () => {
    assert.equal(isCacheable(confirmedTrue), true);
    assert.equal(isCacheable(confirmedFalse), false);
    assert.equal(isCacheable(indeterminate), false);
    assert.equal(isCacheable(unavailable), false);
    assert.equal(isCacheable(null), false);
  });

  // An indeterminate false hardening into a permanent one is the failure this endpoint is
  // designed around. It must be impossible at the storage layer, not merely avoided by
  // callers.
  test("an indeterminate result NEVER reaches storage", async () => {
    const driver = spyDriver();
    const cache = createCache(driver);

    assert.equal(await cache.set("k", indeterminate), false);
    assert.equal(driver.store.size, 0);
    assert.equal(await cache.get("k"), null);
  });

  test("an unavailable result never reaches storage", async () => {
    const driver = spyDriver();
    assert.equal(await createCache(driver).set("k", unavailable), false);
    assert.equal(driver.store.size, 0);
  });

  // Even a PROVEN false is transient: it stays true only until the user does the thing,
  // which on a quest board is the very next thing they do.
  test("a confirmed false is not cached either", async () => {
    const driver = spyDriver();
    assert.equal(await createCache(driver).set("k", confirmedFalse), false);
    assert.equal(driver.store.size, 0);
  });

  test("a confirmed completion is stored and read back", async () => {
    const driver = spyDriver();
    const cache = createCache(driver);

    assert.equal(await cache.set("k", confirmedTrue), true);
    assert.deepEqual(await cache.get("k"), confirmedTrue);
  });
});

describe("driver failure isolation", () => {
  const realError = console.error;
  before(() => {
    console.error = () => {};
  });
  after(() => {
    console.error = realError;
  });

  // A broken cache must degrade to a live check, never fail the verification.
  test("a throwing read is a miss, not an error", async () => {
    assert.equal(await createCache(spyDriver({ throwOnGet: true })).get("k"), null);
  });

  test("a throwing write is swallowed", async () => {
    assert.equal(await createCache(spyDriver({ throwOnSet: true })).set("k", confirmedTrue), false);
  });
});

describe("cache keys", () => {
  test("namespaces by chain so a testnet answer cannot satisfy a mainnet quest", () => {
    const testnet = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS });
    const mainnet = cacheKey({ chainId: 1, quest: "first_trade", address: ADDRESS });
    assert.notEqual(testnet, mainnet);
  });

  test("is case-insensitive in the address", () => {
    const lower = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS.toLowerCase() });
    const mixed = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS });
    assert.equal(lower, mixed);
  });

  test("separates quests", () => {
    const a = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS });
    const b = cacheKey({ chainId: 4441, quest: "first_prediction", address: ADDRESS });
    assert.notEqual(a, b);
  });

  // This is how a daily quest resets: yesterday's answer is a different key, so no TTL
  // machinery is needed and no expiry job can fail to run.
  test("a daily bucket makes yesterday's answer a different key", () => {
    const today = cacheKey({ chainId: 4441, quest: "daily_active", address: ADDRESS, bucket: "2026-07-25" });
    const yesterday = cacheKey({ chainId: 4441, quest: "daily_active", address: ADDRESS, bucket: "2026-07-24" });
    const unbucketed = cacheKey({ chainId: 4441, quest: "daily_active", address: ADDRESS });

    assert.notEqual(today, yesterday);
    assert.notEqual(today, unbucketed);
  });

  test("utcDay is UTC, not local — and stamps YYYY-MM-DD", () => {
    // 23:30 UTC on the 25th is already the 26th in some local zones; the stamp must not
    // move with the server's timezone or two regions would disagree on "today".
    assert.equal(utcDay(new Date("2026-07-25T23:30:00Z")), "2026-07-25");
    assert.equal(utcDay(new Date("2026-07-26T00:01:00Z")), "2026-07-26");
  });
});

describe("null driver", () => {
  test("always misses and drops writes", async () => {
    const cache = createCache(nullCacheDriver());
    await cache.set("k", confirmedTrue);
    assert.equal(await cache.get("k"), null);
  });
});

describe("memory driver", () => {
  test("round-trips a value within one instance", async () => {
    const driver = memoryCacheDriver();
    await driver.set("k", confirmedTrue);
    assert.deepEqual(await driver.get("k"), confirmedTrue);
  });

  test("misses on an unknown key rather than returning undefined", async () => {
    assert.equal(await memoryCacheDriver().get("nope"), null);
  });

  test("keys are independent", async () => {
    const driver = memoryCacheDriver();
    await driver.set("a", { completed: true, status: STATUS.CONFIRMED, tag: "a" });
    await driver.set("b", { completed: true, status: STATUS.CONFIRMED, tag: "b" });

    assert.equal((await driver.get("a")).tag, "a");
    assert.equal((await driver.get("b")).tag, "b");
  });

  test("a rewrite replaces rather than duplicates", async () => {
    const driver = memoryCacheDriver();
    await driver.set("k", { completed: true, status: STATUS.CONFIRMED, v: 1 });
    await driver.set("k", { completed: true, status: STATUS.CONFIRMED, v: 2 });

    assert.equal((await driver.get("k")).v, 2);
    assert.equal(driver._size(), 1);
  });

  // Behind createCache, the memory driver is still subject to the write policy — the
  // driver is storage, the policy is not its business to relax.
  test("still cannot be made to store a negative", async () => {
    const driver = memoryCacheDriver();
    const cache = createCache(driver);

    await cache.set("k", indeterminate);
    await cache.set("k2", confirmedFalse);

    assert.equal(driver._size(), 0);
  });

  // Eviction is oldest-first, and "oldest" is Map insertion order. Writing past the 50k
  // cap here would be slow, so this pins the mechanism the eviction relies on: a rewrite
  // must move the key to the newest position, or a frequently-refreshed entry would be
  // evicted as though it were stale.
  test("a rewrite moves a key to the newest eviction position", async () => {
    const driver = memoryCacheDriver();
    await driver.set("old", confirmedTrue);
    await driver.set("new", confirmedTrue);
    await driver.set("old", confirmedTrue);

    assert.deepEqual(driver._keys(), ["new", "old"]);
  });
});
