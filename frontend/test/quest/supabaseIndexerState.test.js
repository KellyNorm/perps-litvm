// The indexer read driver's wire contract.
//
// The property that matters most here is the one that inverts the rest of the read path:
// this driver THROWS instead of degrading to an empty result. A failed read reported as
// "no rows" would be indistinguishable from "the indexer has never run", and the policy
// above needs to tell those apart — both end up stale, but only if the failure actually
// reaches it.
//
// No network: fetch is injected.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { DEFAULT_TIMEOUT_MS, supabaseIndexerStateDriver } from "../../api/_lib/quest/supabaseIndexerState.js";
import { createIndexerState } from "../../api/_lib/quest/indexerState.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const URL = "https://proj.supabase.co";
const KEY = "service-role-key";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";

function fakeFetch(reply = { ok: true, json: async () => [] }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === "function" ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

const driverWith = (fetch) => supabaseIndexerStateDriver({ url: URL, serviceKey: KEY, fetch });

describe("construction", () => {
  // Null, not a throw: this is built lazily in the request path, so throwing would turn a
  // missing env var into a 503 on every verification. A null driver makes daily_active
  // permanently stale, which is what an unconfigured index deserves.
  test("returns null when unconfigured rather than throwing", () => {
    assert.equal(supabaseIndexerStateDriver({ url: "", serviceKey: KEY, fetch: fakeFetch() }), null);
    assert.equal(supabaseIndexerStateDriver({ url: URL, serviceKey: "", fetch: fakeFetch() }), null);
    assert.equal(supabaseIndexerStateDriver({ url: URL, serviceKey: KEY, fetch: "nope" }), null);
  });

  test("uses the hot-path timeout, like the other read-path drivers", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 2_500);
  });
});

describe("load", () => {
  test("fetches every source in one request", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    await driverWith(fetch).load(4441, [A, "0xBBBB"]);

    assert.equal(fetch.calls.length, 1, "one round trip, not one per source");
    const { url, init } = fetch.calls[0];
    assert.ok(url.includes("select=source_key,last_block,updated_at"), url);
    assert.ok(url.includes("chain_id=eq.4441"), url);
    assert.ok(url.includes("source_key=in.("), url);
    assert.ok(url.includes("0xbbbb"), "source keys are lower-cased to match the table CHECK");
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  });

  test("maps snake_case columns onto the policy's shape", async () => {
    const fetch = fakeFetch({
      ok: true,
      json: async () => [{ source_key: A, last_block: 33_000_000, updated_at: "2026-07-26T00:00:00Z" }],
    });

    assert.deepEqual(await driverWith(fetch).load(4441, [A]), [
      { sourceKey: A, lastBlock: 33_000_000, updatedAt: "2026-07-26T00:00:00Z" },
    ]);
  });

  test("parses a string-encoded bigint", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [{ source_key: A, last_block: "33000000", updated_at: "2026-07-26T00:00:00Z" }] });
    const [row] = await driverWith(fetch).load(4441, [A]);
    assert.equal(row.lastBlock, 33_000_000);
  });

  // THE INVERSION. Every other read-path driver swallows; this one must not.
  test("throws on an HTTP error instead of reporting an empty index", async () => {
    await assert.rejects(() => driverWith(fakeFetch({ ok: false, status: 500 })).load(4441, [A]), /HTTP 500/);
  });

  test("throws on a network failure", async () => {
    const driver = driverWith(async () => {
      throw new Error("ECONNRESET");
    });
    await assert.rejects(() => driver.load(4441, [A]), /ECONNRESET/);
  });

  test("throws on a non-array body", async () => {
    await assert.rejects(() => driverWith(fakeFetch({ ok: true, json: async () => ({}) })).load(4441, [A]), /non-array/);
  });
});

describe("hasDailyRow", () => {
  test("asks for existence only, bounded to one row", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    await driverWith(fetch).hasDailyRow({ chainId: 4441, wallet: WALLET, day: "2026-07-26" });

    const { url } = fetch.calls[0];
    assert.ok(url.includes("day=eq.2026-07-26"), url);
    assert.ok(url.includes(`wallet=eq.${WALLET.toLowerCase()}`), "wallet must be lower-cased to match the CHECK");
    assert.ok(url.includes("limit=1"), url);
  });

  test("row present is true, row absent is false", async () => {
    assert.equal(await driverWith(fakeFetch({ ok: true, json: async () => [{ wallet: WALLET.toLowerCase() }] })).hasDailyRow({ chainId: 4441, wallet: WALLET, day: "2026-07-26" }), true);
    assert.equal(await driverWith(fakeFetch({ ok: true, json: async () => [] })).hasDailyRow({ chainId: 4441, wallet: WALLET, day: "2026-07-26" }), false);
  });

  // An unreadable quest_daily must not be reported as an absent row — that is the wrong
  // false this whole step exists to prevent, arrived at through the driver.
  test("throws rather than reporting an unreadable table as an absent row", async () => {
    await assert.rejects(
      () => driverWith(fakeFetch({ ok: false, status: 503 })).hasDailyRow({ chainId: 4441, wallet: WALLET, day: "2026-07-26" }),
      /HTTP 503/,
    );
  });
});

// The driver and the policy together, which is how they are actually used.
describe("through createIndexerState", () => {
  const rows = (over = {}) => [
    { source_key: A, last_block: 33_000_000, updated_at: new Date(Date.now() - 30_000).toISOString(), ...over },
  ];

  test("a healthy read is fresh", async () => {
    const state = createIndexerState(driverWith(fakeFetch({ ok: true, json: async () => rows() })));
    const out = await state.readFreshness({ chainId: 4441, sourceKeys: [A], head: 33_000_050 });

    assert.equal(out.fresh, true);
    assert.equal(out.indexedThrough, 33_000_000);
  });

  // The driver throws, the POLICY catches — which is why the catch lives up there.
  test("a driver failure surfaces as stale, not as an empty index", async () => {
    const state = createIndexerState(driverWith(fakeFetch({ ok: false, status: 500 })));
    const out = await state.readFreshness({ chainId: 4441, sourceKeys: [A], head: 33_000_050 });

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "read_failed");
    assert.equal(out.indexedThrough, null);
  });
});
