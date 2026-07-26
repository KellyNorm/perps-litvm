// The Supabase driver's job is to be durable without ever being able to hurt a
// verification. So these tests are mostly about what it does when things go WRONG —
// HTTP errors, network failures, timeouts, malformed keys — because the correct
// behaviour in every one of those cases is "miss quietly and let the chain answer".
//
// The one thing it must never do is persist a negative, and that is tested here as well
// as in cache.test.js: this driver holds the durable, cross-deploy record, so it is the
// last place that should trust its caller.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { cacheKey } from "../../api/_lib/quest/cache.js";
import { ONE_TIME_BUCKET, parseCacheKey, supabaseCacheDriver } from "../../api/_lib/quest/supabaseCache.js";
import { STATUS } from "../../api/_lib/quest/quests.js";

const ADDRESS = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";
const LOWER = ADDRESS.toLowerCase();

const confirmedTrue = { completed: true, status: STATUS.CONFIRMED, checkedThroughBlock: 33_000_000 };
const confirmedFalse = { completed: false, status: STATUS.CONFIRMED };
const indeterminate = { completed: false, status: STATUS.INDETERMINATE };

/** Records every call, and replies with whatever the test asked for. */
function fetchStub({ rows = [], ok = true, status = 200, throws = null, hang = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;
    if (hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return { ok, status, json: async () => rows };
  };
  fn.calls = calls;
  return fn;
}

function driverWith(stub, opts = {}) {
  return supabaseCacheDriver({
    url: "https://proj.supabase.co",
    serviceKey: "service-role-key",
    fetch: stub,
    ...opts,
  });
}

describe("parseCacheKey", () => {
  // The parse only has to handle what cacheKey() actually emits, so pin it against the
  // real producer rather than against hand-written strings that could drift from it.
  test("round-trips a one-time key built by cacheKey()", () => {
    const parsed = parseCacheKey(cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }));
    assert.deepEqual(parsed, { chainId: 4441, quest: "first_trade", wallet: LOWER, bucket: ONE_TIME_BUCKET });
  });

  test("round-trips a daily key, keeping the day as the bucket", () => {
    const key = cacheKey({ chainId: 4441, quest: "daily_active", address: ADDRESS, bucket: "2026-07-26" });
    assert.deepEqual(parseCacheKey(key), {
      chainId: 4441,
      quest: "daily_active",
      wallet: LOWER,
      bucket: "2026-07-26",
    });
  });

  // A one-time quest and a daily quest for the same wallet must not collide on the
  // primary key, which is exactly what an empty-string bucket would risk.
  test("a one-time bucket is non-empty, so it cannot collide with a dated one", () => {
    assert.notEqual(ONE_TIME_BUCKET, "");
    const oneTime = parseCacheKey(cacheKey({ chainId: 4441, quest: "q", address: ADDRESS }));
    const daily = parseCacheKey(cacheKey({ chainId: 4441, quest: "q", address: ADDRESS, bucket: "2026-07-26" }));
    assert.notEqual(oneTime.bucket, daily.bucket);
  });

  test("rejects malformed keys instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "4441:first_trade", // too few parts
      "4441:first_trade:0xabc:2026-07-26:extra", // too many
      "notanumber:first_trade:" + LOWER,
      "4441::" + LOWER, // empty quest
      "4441:first_trade:not-an-address",
      `4441:first_trade:${ADDRESS}`, // checksum casing never comes from cacheKey()
      `4441:first_trade:${LOWER}:`, // empty bucket
    ]) {
      assert.equal(parseCacheKey(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("configuration", () => {
  test("returns null when either credential is missing, so the caller can fall back", () => {
    assert.equal(supabaseCacheDriver({ url: "", serviceKey: "k", fetch: fetchStub() }), null);
    assert.equal(supabaseCacheDriver({ url: "https://x.supabase.co", serviceKey: "", fetch: fetchStub() }), null);
  });

  test("returns a driver when both are present", () => {
    assert.notEqual(driverWith(fetchStub()), null);
  });
});

describe("get", () => {
  test("a row is a proven completion, reconstructed from its existence", async () => {
    const stub = fetchStub({ rows: [{ checked_through_block: 33_000_000 }] });
    const hit = await driverWith(stub).get(cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }));

    assert.deepEqual(hit, { completed: true, status: STATUS.CONFIRMED, checkedThroughBlock: 33_000_000 });
  });

  test("no rows is a miss, not a false", async () => {
    const hit = await driverWith(fetchStub({ rows: [] })).get(
      cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }),
    );
    // null, NOT { completed: false } — a miss means "ask the chain", a false would be an answer.
    assert.equal(hit, null);
  });

  test("queries by all four key columns", async () => {
    const stub = fetchStub({ rows: [] });
    await driverWith(stub).get(cacheKey({ chainId: 4441, quest: "daily_active", address: ADDRESS, bucket: "2026-07-26" }));

    const { url } = stub.calls[0];
    assert.match(url, /\/rest\/v1\/quest_completion\?/);
    assert.match(url, /chain_id=eq\.4441/);
    assert.match(url, new RegExp(`wallet=eq\\.${LOWER}`));
    assert.match(url, /quest=eq\.daily_active/);
    assert.match(url, /bucket=eq\.2026-07-26/);
  });

  test("sends the service-role key as both apikey and bearer", async () => {
    const stub = fetchStub({ rows: [] });
    await driverWith(stub).get(cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }));

    assert.equal(stub.calls[0].init.headers.apikey, "service-role-key");
    assert.equal(stub.calls[0].init.headers.authorization, "Bearer service-role-key");
  });

  test("an unparseable key is a miss and costs no round trip", async () => {
    const stub = fetchStub({ rows: [{ checked_through_block: 1 }] });
    assert.equal(await driverWith(stub).get("garbage"), null);
    assert.equal(stub.calls.length, 0);
  });
});

describe("set", () => {
  test("upserts the completion with its key columns", async () => {
    const stub = fetchStub();
    await driverWith(stub).set(cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }), {
      ...confirmedTrue,
      source: "tier2",
    });

    const { url, init } = stub.calls[0];
    assert.equal(init.method, "POST");
    assert.match(url, /on_conflict=chain_id,wallet,quest,bucket/);
    assert.deepEqual(JSON.parse(init.body), {
      chain_id: 4441,
      wallet: LOWER,
      quest: "first_trade",
      bucket: ONE_TIME_BUCKET,
      checked_through_block: 33_000_000,
      source: "tier2",
    });
  });

  // REGRESSION: the request wrapper merges default headers with per-call ones. Spread in
  // the wrong order, `prefer` vanishes and every re-verification of an already-proven
  // wallet becomes a duplicate-key error instead of a no-op upsert.
  test("sends the upsert Prefer header, not just the defaults", async () => {
    const stub = fetchStub();
    await driverWith(stub).set(cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS }), confirmedTrue);

    const { headers } = stub.calls[0].init;
    assert.equal(headers.prefer, "resolution=merge-duplicates,return=minimal");
    assert.equal(headers.apikey, "service-role-key", "defaults must survive the merge too");
  });

  // The durable record is the last place that should trust its caller to have filtered.
  test("refuses to write anything that is not a proven completion", async () => {
    const stub = fetchStub();
    const driver = driverWith(stub);
    const key = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS });

    await driver.set(key, confirmedFalse);
    await driver.set(key, indeterminate);
    await driver.set(key, null);

    assert.equal(stub.calls.length, 0, "a negative must never reach durable storage");
  });

  test("an unparseable key is dropped rather than written", async () => {
    const stub = fetchStub();
    await driverWith(stub).set("garbage", confirmedTrue);
    assert.equal(stub.calls.length, 0);
  });
});

// Every failure below must degrade to "verify from chain", never to an exception. The
// cache sits in front of the scan inside a 30s function; a driver that throws or hangs
// would turn a slow database into a broken endpoint.
describe("failure isolation", () => {
  const realError = console.error;
  before(() => {
    console.error = () => {};
  });
  after(() => {
    console.error = realError;
  });

  const key = cacheKey({ chainId: 4441, quest: "first_trade", address: ADDRESS });

  test("an HTTP error on read is a miss", async () => {
    assert.equal(await driverWith(fetchStub({ ok: false, status: 500 })).get(key), null);
  });

  test("a network throw on read is a miss", async () => {
    assert.equal(await driverWith(fetchStub({ throws: new Error("ECONNREFUSED") })).get(key), null);
  });

  test("malformed JSON on read is a miss", async () => {
    const stub = fetchStub();
    stub.calls.length = 0;
    const driver = driverWith(async (url, init) => {
      stub.calls.push({ url, init });
      return { ok: true, status: 200, json: async () => "not an array" };
    });
    assert.equal(await driver.get(key), null);
  });

  test("an HTTP error on write is swallowed", async () => {
    await driverWith(fetchStub({ ok: false, status: 409 })).set(key, confirmedTrue);
  });

  test("a network throw on write is swallowed", async () => {
    await driverWith(fetchStub({ throws: new Error("ECONNREFUSED") })).set(key, confirmedTrue);
  });

  // A hanging Supabase must cost the timeout and then get out of the way, or it would eat
  // the budget the scan needs.
  test("a hanging read aborts and misses", async () => {
    const driver = driverWith(fetchStub({ hang: true }), { timeoutMs: 20 });
    assert.equal(await driver.get(key), null);
  });

  test("a hanging write aborts and is swallowed", async () => {
    const driver = driverWith(fetchStub({ hang: true }), { timeoutMs: 20 });
    await driver.set(key, confirmedTrue);
  });
});
