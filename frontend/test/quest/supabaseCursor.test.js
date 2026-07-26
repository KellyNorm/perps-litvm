// The Supabase cursor driver's wire contract, and its failure isolation.
//
// The point of testing the raw PostgREST shape rather than mocking an SDK: the upsert only
// merges if `on_conflict` names the primary key AND the `prefer` header survives the header
// merge. Get either wrong and every poll INSERTs — which either duplicates rows or 409s,
// and in both cases coverage stops accumulating and deep wallets silently never converge.
//
// No network: `fetch` is injected everywhere.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { DEFAULT_TIMEOUT_MS, supabaseCursorDriver } from "../../api/_lib/quest/supabaseCursor.js";
import { createCursorStore } from "../../api/_lib/quest/cursor.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const URL = "https://proj.supabase.co";
const KEY = "service-role-key";
const ID = { chainId: 4441, wallet: "0x1111111111111111111111111111111111111111", quest: "first_prediction" };

/** Records every request and replies with a canned response. */
function fakeFetch(reply = { ok: true, json: async () => [] }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === "function" ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

const driverWith = (fetch, opts = {}) => supabaseCursorDriver({ url: URL, serviceKey: KEY, fetch, ...opts });

describe("construction", () => {
  test("returns null when it is not configured, rather than throwing", () => {
    // A throw here would surface a missing env var as a 503 on every verification — an
    // outage caused by an optimisation. Null lets the caller fall back.
    assert.equal(supabaseCursorDriver({ url: "", serviceKey: KEY, fetch: fakeFetch() }), null);
    assert.equal(supabaseCursorDriver({ url: URL, serviceKey: "", fetch: fakeFetch() }), null);
    // `fetch: undefined` deliberately falls back to globalThis.fetch; only a value that is
    // not callable at all means "no transport".
    assert.equal(supabaseCursorDriver({ url: URL, serviceKey: KEY, fetch: "not-a-function" }), null);
    assert.ok(supabaseCursorDriver({ url: URL, serviceKey: KEY, fetch: undefined }), "falls back to global fetch");
  });

  test("tolerates whitespace and a trailing slash on the url", async () => {
    const fetch = fakeFetch();
    const driver = supabaseCursorDriver({ url: `  ${URL}///  `, serviceKey: ` ${KEY} `, fetch });

    await driver.load(ID);

    assert.ok(fetch.calls[0].url.startsWith(`${URL}/rest/v1/quest_cursor?`), fetch.calls[0].url);
  });

  test("the hot-path timeout matches the cache driver's", () => {
    // The load sits in front of a scan that can already spend ~25s of a 30s ceiling, so a
    // hanging Supabase must cost a couple of seconds and get out of the way.
    assert.equal(DEFAULT_TIMEOUT_MS, 2_500);
  });
});

describe("load", () => {
  test("queries every source for one (chain, wallet, quest) in a single request", async () => {
    const fetch = fakeFetch();
    await driverWith(fetch).load(ID);

    assert.equal(fetch.calls.length, 1, "one round trip, not one per source");
    const { url, init } = fetch.calls[0];
    assert.equal(init.method, "GET");
    // The floor comes back with the interval: the caller cannot judge the interval without
    // knowing which floor it was computed against.
    assert.ok(url.includes("select=source_key,floor_block,scanned_from,scanned_to"), url);
    assert.ok(url.includes("chain_id=eq.4441"), url);
    assert.ok(url.includes(`wallet=eq.${ID.wallet}`), url);
    assert.ok(url.includes("quest=eq.first_prediction"), url);
    // No `limit`: a multi-source quest has a row per source and all of them are wanted.
    assert.ok(!url.includes("limit="), url);
    assert.equal(init.headers.apikey, KEY);
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  });

  test("maps snake_case columns onto the store's shape", async () => {
    const fetch = fakeFetch({
      ok: true,
      json: async () => [{ source_key: "0xaaa", floor_block: 1_000, scanned_from: 99_000, scanned_to: 40_000 }],
    });

    assert.deepEqual(await driverWith(fetch).load(ID), [
      { sourceKey: "0xaaa", floorBlock: 1_000, scannedFrom: 99_000, scannedTo: 40_000 },
    ]);
  });

  // bigint may serialize as a JSON string depending on PostgREST settings; the store parses.
  test("passes string-encoded bigints through for the store to parse", async () => {
    const fetch = fakeFetch({
      ok: true,
      json: async () => [{ source_key: "0xaaa", floor_block: "1000", scanned_from: "99000", scanned_to: "40000" }],
    });
    const store = createCursorStore(driverWith(fetch));

    assert.deepEqual(await store.load(ID), {
      "0xaaa": { sourceKey: "0xaaa", floorBlock: 1_000, scannedFrom: 99_000, scannedTo: 40_000 },
    });
  });

  // Every one of these means "no coverage yet" — a slower poll, never a wrong one.
  test("an HTTP error reads as no coverage", async () => {
    const fetch = fakeFetch({ ok: false, status: 500 });
    assert.deepEqual(await driverWith(fetch).load(ID), []);
  });

  test("a network throw reads as no coverage", async () => {
    const driver = driverWith(async () => {
      throw new Error("ECONNRESET");
    });
    assert.deepEqual(await driver.load(ID), []);
  });

  test("a non-array body reads as no coverage", async () => {
    const fetch = fakeFetch({ ok: true, json: async () => ({ message: "nope" }) });
    assert.deepEqual(await driverWith(fetch).load(ID), []);
  });

  test("unparseable JSON reads as no coverage", async () => {
    const fetch = fakeFetch({
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    });
    assert.deepEqual(await driverWith(fetch).load(ID), []);
  });

  test("aborts on timeout instead of holding the request open", async () => {
    let signal;
    const driver = driverWith(async (_url, init) => {
      signal = init.signal;
      return { ok: true, json: async () => [] };
    });

    await driver.load(ID);

    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false, "a completed request must not leave the timer firing");
  });
});

describe("save", () => {
  const rows = [
    { sourceKey: "0xaaa", floorBlock: 1_000, scannedFrom: 99_000, scannedTo: 40_000 },
    { sourceKey: "0xbbb", floorBlock: 500, scannedFrom: 99_000, scannedTo: 500 },
  ];

  test("upserts every source in ONE bulk request", async () => {
    const fetch = fakeFetch();
    await driverWith(fetch).save(ID, rows);

    assert.equal(fetch.calls.length, 1, "a multi-source quest must cost one round trip");
    const body = JSON.parse(fetch.calls[0].init.body);
    assert.equal(body.length, 2);
    assert.deepEqual(body[0], {
      chain_id: 4441,
      wallet: ID.wallet,
      quest: "first_prediction",
      source_key: "0xaaa",
      floor_block: 1_000,
      scanned_from: 99_000,
      scanned_to: 40_000,
    });
  });

  // THE ONE THAT SILENTLY BREAKS CONVERGENCE. Without on_conflict + the prefer header the
  // second poll INSERTs instead of merging, coverage never accumulates, and deep wallets
  // stay indeterminate forever with nothing in the logs to say why.
  test("is an upsert: on_conflict names the primary key and prefer survives", async () => {
    const fetch = fakeFetch();
    await driverWith(fetch).save(ID, rows);

    const { url, init } = fetch.calls[0];
    assert.equal(init.method, "POST");
    assert.ok(url.endsWith("quest_cursor?on_conflict=chain_id,wallet,quest,source_key"), url);
    assert.equal(init.headers.prefer, "resolution=merge-duplicates,return=minimal");
    assert.equal(init.headers.apikey, KEY, "the auth headers must not be spread away by prefer");
  });

  // updated_at is the database's clock, not a lambda's — see the migration.
  test("never writes a timestamp or anything verdict-shaped", async () => {
    const fetch = fakeFetch();
    await driverWith(fetch).save(ID, rows);

    const body = JSON.parse(fetch.calls[0].init.body);
    assert.deepEqual(Object.keys(body[0]).sort(), [
      "chain_id",
      "floor_block",
      "quest",
      "scanned_from",
      "scanned_to",
      "source_key",
      "wallet",
    ]);
  });

  test("an HTTP error is logged and swallowed", async () => {
    const fetch = fakeFetch({ ok: false, status: 409 });
    await driverWith(fetch).save(ID, rows); // must not throw
  });

  test("a network throw is swallowed", async () => {
    const driver = driverWith(async () => {
      throw new Error("ECONNRESET");
    });
    await driver.save(ID, rows); // must not throw
  });
});

// A round trip through the store, because the store is what the scanner actually holds.
describe("through createCursorStore", () => {
  test("a poll's coverage survives the write/read round trip", async () => {
    let stored = [];
    const driver = driverWith(async (url, init) => {
      if (init.method === "POST") {
        stored = JSON.parse(init.body);
        return { ok: true };
      }
      return {
        ok: true,
        json: async () =>
          stored.map((r) => ({
            source_key: r.source_key,
            floor_block: r.floor_block,
            scanned_from: r.scanned_from,
            scanned_to: r.scanned_to,
          })),
      };
    });

    const store = createCursorStore(driver);
    await store.save(ID, [{ sourceKey: "0xaaa", floorBlock: 1_000, scannedFrom: 99_000, scannedTo: 40_000 }]);

    assert.deepEqual(await store.load(ID), {
      "0xaaa": { sourceKey: "0xaaa", floorBlock: 1_000, scannedFrom: 99_000, scannedTo: 40_000 },
    });
  });

  test("a driver that 500s on every call leaves the store empty rather than failing", async () => {
    const store = createCursorStore(driverWith(fakeFetch({ ok: false, status: 500 })));

    assert.equal(await store.save(ID, [{ sourceKey: "0xaaa", floorBlock: 0, scannedFrom: 9, scannedTo: 0 }]), 1);
    assert.deepEqual(await store.load(ID), {});
  });
});
