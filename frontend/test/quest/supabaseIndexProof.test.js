// The index-proof driver's wire contract.
//
// The property that matters most is the one it does NOT share with supabaseCache.js, which
// reads the very same quest_completion table: this driver throws. Its caller turns "no row"
// into a confirmed false, so a swallowed HTTP 500 there would be a wrong answer about a real
// trader rather than a slower verification.
//
// No network: fetch is injected.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { DEFAULT_TIMEOUT_MS, ONE_TIME_BUCKET, supabaseIndexProofDriver } from "../../api/_lib/quest/supabaseIndexProof.js";
import { ONE_TIME_BUCKET as CACHE_BUCKET } from "../../api/_lib/quest/supabaseCache.js";

const URL = "https://proj.supabase.co";
const KEY = "service-role-key";
const PM = "0x9396D36F713302FF39E0bA5b38012656f8E4eACF";
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

const driverWith = (fetch) => supabaseIndexProofDriver({ url: URL, serviceKey: KEY, fetch });

describe("construction", () => {
  test("returns null when unconfigured rather than throwing", () => {
    assert.equal(supabaseIndexProofDriver({ url: "", serviceKey: KEY, fetch: fakeFetch() }), null);
    assert.equal(supabaseIndexProofDriver({ url: URL, serviceKey: "", fetch: fakeFetch() }), null);
    assert.equal(supabaseIndexProofDriver({ url: URL, serviceKey: KEY, fetch: "nope" }), null);
  });

  test("uses the hot-path timeout, like the other read-path drivers", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 2_500);
  });

  // Three modules address these rows. A bucket mismatch would hide every backfilled
  // completion, which reads as a proven false for exactly the wallets the sweep found.
  test("the one-time bucket matches supabaseCache.js", () => {
    assert.equal(ONE_TIME_BUCKET, CACHE_BUCKET);
  });
});

describe("loadBackfill", () => {
  test("fetches every source in one request, lower-cased", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    await driverWith(fetch).loadBackfill(4441, [PM, "0xBBBB"]);

    assert.equal(fetch.calls.length, 1, "one round trip, not one per source");
    const { url, init } = fetch.calls[0];
    assert.ok(url.includes("quest_backfill?select=source_key,floor_block,covered_from,covered_to"), url);
    assert.ok(url.includes("chain_id=eq.4441"), url);
    assert.ok(url.includes(PM.toLowerCase()), "source keys are lower-cased to match the table CHECK");
    assert.ok(!url.includes(PM), "the checksummed form would match no row");
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  });

  test("keys the result by source and coerces the bigints", async () => {
    const fetch = fakeFetch({
      ok: true,
      // PostgREST may serialize bigint as a string; both forms must land as numbers.
      json: async () => [{ source_key: PM.toLowerCase(), floor_block: "23302630", covered_from: 33000000, covered_to: "23302630" }],
    });

    const out = await driverWith(fetch).loadBackfill(4441, [PM]);
    assert.deepEqual(out.get(PM.toLowerCase()), { floorBlock: 23_302_630, coveredFrom: 33_000_000, coveredTo: 23_302_630 });
  });

  test("a missing source is simply absent — the policy decides what that means", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    const out = await driverWith(fetch).loadBackfill(4441, [PM]);
    assert.equal(out.size, 0);
  });

  test("an HTTP error THROWS rather than reading as no coverage", async () => {
    const fetch = fakeFetch({ ok: false, status: 500 });
    await assert.rejects(() => driverWith(fetch).loadBackfill(4441, [PM]), /HTTP 500/);
  });

  test("a non-array body throws", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => ({ message: "nope" }) });
    await assert.rejects(() => driverWith(fetch).loadBackfill(4441, [PM]), /non-array/);
  });
});

describe("readCompletion", () => {
  test("queries the exact row, lower-cased, in the one-time bucket", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    await driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" });

    const { url } = fetch.calls[0];
    assert.ok(url.includes("quest_completion?select=checked_through_block"), url);
    assert.ok(url.includes(`wallet=eq.${encodeURIComponent(WALLET.toLowerCase())}`), url);
    assert.ok(url.includes("quest=eq.first_trade"), url);
    assert.ok(url.includes(`bucket=eq.${encodeURIComponent(ONE_TIME_BUCKET)}`), url);
    assert.ok(url.includes("limit=1"), url);
  });

  test("a row is a completion, and carries the block it was proven at", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [{ checked_through_block: "31000000" }] });
    const out = await driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" });

    assert.deepEqual(out, { found: true, checkedThroughBlock: 31_000_000 });
  });

  test("a row with no block is still a completion — the row IS the fact", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [{ checked_through_block: null }] });
    const out = await driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" });

    assert.deepEqual(out, { found: true, checkedThroughBlock: null });
  });

  test("no rows is a genuine absence", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => [] });
    const out = await driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" });

    assert.deepEqual(out, { found: false, checkedThroughBlock: null });
  });

  // THE central difference from supabaseCache.js, which returns null here.
  test("an HTTP error THROWS rather than reading as an absent row", async () => {
    const fetch = fakeFetch({ ok: false, status: 500 });
    await assert.rejects(
      () => driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" }),
      /HTTP 500/,
    );
  });

  test("a network throw propagates", async () => {
    const fetch = async () => {
      throw new Error("ECONNRESET");
    };
    await assert.rejects(
      () => driverWith(fetch).readCompletion({ chainId: 4441, wallet: WALLET, quest: "first_trade" }),
      /ECONNRESET/,
    );
  });
});
