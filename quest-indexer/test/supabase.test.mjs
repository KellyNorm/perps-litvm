// The indexer's write driver.
//
// Two properties carry the safety of the whole service:
//
//   1. EVERYTHING THROWS ON FAILURE. Elsewhere in this codebase a failed write costs
//      latency; here a swallowed error lets the caller advance a watermark over rows that
//      were never written, and the reader turns that absence into "did nothing today".
//   2. THE WATERMARK NEVER MOVES BACKWARD, and an unchanged watermark still refreshes
//      updated_at — otherwise a healthy indexer on a quiet chain eventually reads as dead.
//
// No network: fetch is injected.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { DEFAULT_TIMEOUT_MS, createSupabaseWriter } from "../lib/supabase.mjs";

const URL = "https://proj.supabase.co";
const KEY = "service-role-key";
const CHAIN = 4441;

/** Records requests; `reply` may be a function of (url, init). */
function fakeFetch(reply = { ok: true, status: 200, json: async () => [], text: async () => "" }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    return typeof reply === "function" ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

const ok = (rows) => ({ ok: true, status: 200, json: async () => rows, text: async () => "" });
const writerWith = (fetch) => createSupabaseWriter({ url: URL, serviceKey: KEY, fetch });

describe("construction", () => {
  // Unlike the read-path drivers, which return null and let the endpoint degrade, this one
  // dies loudly: a misconfigured indexer would run forever writing nothing, and the
  // watermark it never advances would read as permanently stale with no obvious cause.
  test("throws on missing config rather than silently doing nothing", () => {
    assert.throws(() => createSupabaseWriter({ url: "", serviceKey: KEY, fetch: fakeFetch() }), /required/);
    assert.throws(() => createSupabaseWriter({ url: URL, serviceKey: " ", fetch: fakeFetch() }), /required/);
    assert.throws(() => createSupabaseWriter({ url: URL, serviceKey: KEY, fetch: "nope" }), /fetch/);
  });

  test("strips a trailing slash and sends the service-role headers", async () => {
    const fetch = fakeFetch(ok([]));
    await createSupabaseWriter({ url: `${URL}//`, serviceKey: KEY, fetch }).loadState(CHAIN, ["0xa"]);

    assert.ok(fetch.calls[0].url.startsWith(`${URL}/rest/v1/indexer_state?`), fetch.calls[0].url);
    assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  });

  // A background service can afford to wait; the read path's 2.5s is a hot-path number.
  test("uses a background-appropriate timeout, not the hot-path one", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 8_000);
  });
});

describe("loadState", () => {
  test("fetches every source in one request and keys them", async () => {
    const fetch = fakeFetch(
      ok([{ source_key: "0xa", last_block: 100, updated_at: "2026-07-26T00:00:00Z", completion_from: 90 }]),
    );

    const state = await writerWith(fetch).loadState(CHAIN, ["0xa", "0xb"]);

    assert.equal(fetch.calls.length, 1, "one round trip for all sources");
    assert.ok(fetch.calls[0].url.includes("source_key=in.("), fetch.calls[0].url);
    assert.deepEqual(state.get("0xa"), { lastBlock: 100, updatedAt: "2026-07-26T00:00:00Z", completionFrom: 90 });
    assert.equal(state.get("0xb"), undefined, "a source with no row is simply absent");
  });

  // NULL means "the indexer has not yet proven from where completions were written". It is
  // not zero and not "since always" — coercing it to a number here would manufacture the
  // coverage claim 0005 refuses to invent, and the read path would cash it in for a false.
  test("a null completion_from stays null, never 0", async () => {
    const fetch = fakeFetch(ok([{ source_key: "0xa", last_block: 100, updated_at: "x", completion_from: null }]));

    const state = await writerWith(fetch).loadState(CHAIN, ["0xa"]);

    assert.equal(state.get("0xa").completionFrom, null);
    assert.notEqual(state.get("0xa").completionFrom, 0, "Number(null) is 0 and would be a silent coverage claim");
  });

  test("asks for completion_from explicitly", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).loadState(CHAIN, ["0xa"]);

    assert.ok(fetch.calls[0].url.includes("completion_from"), fetch.calls[0].url);
  });

  test("throws on an HTTP error instead of reporting an empty index", async () => {
    await assert.rejects(() => writerWith(fakeFetch({ ok: false, status: 500, text: async () => "boom" })).loadState(CHAIN, ["0xa"]), /HTTP 500/);
  });

  test("throws when the body is not an array", async () => {
    await assert.rejects(() => writerWith(fakeFetch(ok({ message: "nope" }))).loadState(CHAIN, ["0xa"]), /non-array/);
  });
});

describe("writeDaily", () => {
  const rows = [
    { chainId: CHAIN, wallet: "0xaaa", day: "2026-07-26", firstSeenBlock: 10, firstSeenVia: "PositionOpened" },
    { chainId: CHAIN, wallet: "0xbbb", day: "2026-07-25", firstSeenBlock: 9, firstSeenVia: "BetPlaced" },
  ];

  test("bulk-inserts in one request", async () => {
    const fetch = fakeFetch(ok([]));
    const n = await writerWith(fetch).writeDaily(rows);

    assert.equal(n, 2);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].body.length, 2);
  });

  // The cron is at-least-once: a restart overlap or a retried range must be a no-op rather
  // than a duplicate-key error. That idempotence is what makes overlap-on-resume safe.
  test("is on-conflict-do-nothing, so a replayed range is a no-op", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).writeDaily(rows);

    const { url, init } = fetch.calls[0];
    assert.ok(url.endsWith("quest_daily?on_conflict=chain_id,wallet,day"), url);
    assert.equal(init.headers.prefer, "resolution=ignore-duplicates,return=minimal");
    assert.equal(init.headers.apikey, KEY, "auth must survive the prefer header merge");
  });

  // A full ISO timestamp into a `date` column casts using the session timezone. Supabase
  // defaults to UTC so it would work — until it doesn't.
  test("sends a bare YYYY-MM-DD, never a timestamp", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).writeDaily(rows);

    for (const row of fetch.calls[0].body) {
      assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/, `${row.day} must be a bare date`);
    }
  });

  // An inactive range is the common case and must not block the watermark.
  test("an empty batch is a successful no-op with no request at all", async () => {
    const fetch = fakeFetch(ok([]));
    assert.equal(await writerWith(fetch).writeDaily([]), 0);
    assert.equal(fetch.calls.length, 0);
  });

  test("throws on an HTTP error so the caller cannot advance over unwritten rows", async () => {
    const fetch = fakeFetch({ ok: false, status: 400, text: async () => "check violation" });
    await assert.rejects(() => writerWith(fetch).writeDaily(rows), /HTTP 400/);
  });

  test("surfaces the response body, because a 400 here is usually a CHECK violation", async () => {
    const fetch = fakeFetch({ ok: false, status: 400, text: async () => "quest_daily_wallet_is_lower" });
    await assert.rejects(() => writerWith(fetch).writeDaily(rows), /wallet_is_lower/);
  });
});

describe("writeCompletions", () => {
  const rows = [
    { chainId: CHAIN, wallet: "0xaaa", quest: "first_trade", checkedThroughBlock: 10 },
    { chainId: CHAIN, wallet: "0xbbb", quest: "first_prediction", checkedThroughBlock: 11, source: "backfill" },
  ];

  test("bulk-inserts in one request", async () => {
    const fetch = fakeFetch(ok([]));
    const n = await writerWith(fetch).writeCompletions(rows);

    assert.equal(n, 2);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].body.length, 2);
  });

  // A row's EXISTENCE is the completion (0001). There is no column that could carry a
  // negative, so this function structurally cannot express one — the test pins the shape
  // that makes that true.
  test("writes no verdict column, because none exists", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).writeCompletions(rows);

    for (const row of fetch.calls[0].body) {
      assert.ok(!("completed" in row), "quest_completion has no completed column, by design");
      assert.ok(!("status" in row), "nor a status column");
      assert.equal(row.bucket, "-", "one-time quests share the one bucket the read path looks under");
    }
  });

  // A completion may already exist from a user poll or the settler, recorded against a
  // block those knew more about. The row's existence is the fact; overwriting it could only
  // lose information.
  test("is ignore-duplicates, so it never clobbers an existing completion", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).writeCompletions(rows);

    const { url, init } = fetch.calls[0];
    assert.ok(url.endsWith("quest_completion?on_conflict=chain_id,wallet,quest,bucket"), url);
    assert.equal(init.headers.prefer, "resolution=ignore-duplicates,return=minimal");
    assert.equal(init.headers.apikey, KEY, "auth must survive the prefer header merge");
  });

  test("defaults the provenance to the indexer but lets a caller name itself", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).writeCompletions(rows);

    assert.equal(fetch.calls[0].body[0].source, "indexer");
    assert.equal(fetch.calls[0].body[1].source, "backfill");
  });

  test("an empty batch is a successful no-op with no request at all", async () => {
    const fetch = fakeFetch(ok([]));
    assert.equal(await writerWith(fetch).writeCompletions([]), 0);
    assert.equal(fetch.calls.length, 0);
  });

  test("throws on an HTTP error so the caller cannot advance over unwritten rows", async () => {
    const fetch = fakeFetch({ ok: false, status: 400, text: async () => "quest_completion_wallet_is_lower" });
    await assert.rejects(() => writerWith(fetch).writeCompletions(rows), /wallet_is_lower/);
  });
});

describe("claimCompletionFrom — the set-once handoff watermark", () => {
  // The guard IS the function. Without `completion_from=is.null` a later run would overwrite
  // the first claim with a higher block, and the range between them — whose completions were
  // written — would stop being provably covered.
  test("guards on completion_from=is.null so it can only ever be set once", async () => {
    const fetch = fakeFetch(ok([{ completion_from: 500 }]));
    const out = await writerWith(fetch).claimCompletionFrom(CHAIN, "0xa", 500);

    assert.equal(out, "claimed");
    const { url, init } = fetch.calls[0];
    assert.equal(init.method, "PATCH");
    assert.ok(url.includes("completion_from=is.null"), url);
    assert.ok(url.includes("chain_id=eq.4441"), url);
    assert.ok(url.includes("source_key=eq.0xa"), url);
  });

  // A second run, or a racing one, must be a silent no-op — not an error and not an
  // overwrite. The recorded value stays the FIRST, which is the only one describing
  // contiguous coverage.
  test("a second claim is a no-op, not an error and not an overwrite", async () => {
    const fetch = fakeFetch(ok([]));
    assert.equal(await writerWith(fetch).claimCompletionFrom(CHAIN, "0xa", 900), "already_set");
    assert.equal(fetch.calls.length, 1, "no INSERT fallback — this must never create a row");
  });

  // It shares a table with the watermark, so the one thing it must not be able to do is
  // move it. A completion_from claim that dragged last_block would be a watermark advanced
  // over blocks nothing read.
  test("cannot touch last_block", async () => {
    const fetch = fakeFetch(ok([{ completion_from: 1 }]));
    await writerWith(fetch).claimCompletionFrom(CHAIN, "0xa", 1);

    assert.deepEqual(Object.keys(fetch.calls[0].body), ["completion_from"]);
  });

  test("throws on an HTTP error rather than reporting a phantom claim", async () => {
    const fetch = fakeFetch({ ok: false, status: 503, text: async () => "" });
    await assert.rejects(() => writerWith(fetch).claimCompletionFrom(CHAIN, "0xa", 1), /HTTP 503/);
  });
});

describe("the backfill's coverage writes", () => {
  test("loadBackfill fetches every source in one request and keys them", async () => {
    const fetch = fakeFetch(
      ok([{ source_key: "0xa", floor_block: 100, covered_from: 900, covered_to: 400, updated_at: "x" }]),
    );

    const cov = await writerWith(fetch).loadBackfill(CHAIN, ["0xa", "0xb"]);

    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(cov.get("0xa"), { floorBlock: 100, coveredFrom: 900, coveredTo: 400, updatedAt: "x" });
    assert.equal(cov.get("0xb"), undefined, "a source with no row is simply absent");
  });

  test("loadBackfill throws rather than reporting an unswept chain as swept", async () => {
    const fetch = fakeFetch({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(() => writerWith(fetch).loadBackfill(CHAIN, ["0xa"]), /HTTP 500/);
  });

  // The ceiling is the handoff point the read path checks against completion_from. Opening
  // a pass sets it and the coverage starts EMPTY at it — covered_to = covered_from means
  // "nothing swept yet", which the interval CHECK accepts and the floor CHECK does not
  // mistake for completion.
  test("startBackfill anchors the ceiling with empty coverage", async () => {
    const fetch = fakeFetch(ok([]));
    await writerWith(fetch).startBackfill({ chainId: CHAIN, sourceKey: "0xa", floorBlock: 100, coveredFrom: 900 });

    const { url, init, body } = fetch.calls[0];
    assert.ok(url.endsWith("quest_backfill?on_conflict=chain_id,source_key"), url);
    assert.equal(init.headers.prefer, "resolution=merge-duplicates,return=minimal");
    assert.equal(body.covered_from, 900);
    assert.equal(body.covered_to, 900, "empty coverage, not coverage down to the floor");
    assert.equal(body.floor_block, 100);
  });

  // THE GUARD IS THE FUNCTION. Without covered_to=gte a replayed or concurrent slice holding
  // a staler frontier would drag coverage back UP, discarding swept blocks the read path was
  // relying on.
  test("extendBackfillDown can only ever move coverage DOWN", async () => {
    const fetch = fakeFetch(ok([{ covered_to: 400 }]));
    const out = await writerWith(fetch).extendBackfillDown({
      chainId: CHAIN,
      sourceKey: "0xa",
      floorBlock: 100,
      coveredTo: 400,
    });

    assert.equal(out, "extended");
    const { url, init } = fetch.calls[0];
    assert.equal(init.method, "PATCH");
    assert.ok(url.includes("covered_to=gte.400"), url);
  });

  // Pins the row to the floor the caller PLANNED against. If the configured floor changed
  // underneath a running slice, this must fail to match rather than extend coverage computed
  // against a different contract.
  test("extendBackfillDown pins the floor it planned against", async () => {
    const fetch = fakeFetch(ok([{ covered_to: 400 }]));
    await writerWith(fetch).extendBackfillDown({ chainId: CHAIN, sourceKey: "0xa", floorBlock: 100, coveredTo: 400 });

    assert.ok(fetch.calls[0].url.includes("floor_block=eq.100"), fetch.calls[0].url);
  });

  // A writer that could raise the ceiling could claim blocks nothing swept. It is set once,
  // by startBackfill, and this function has no way to express it.
  test("extendBackfillDown cannot move the ceiling", async () => {
    const fetch = fakeFetch(ok([{ covered_to: 400 }]));
    await writerWith(fetch).extendBackfillDown({ chainId: CHAIN, sourceKey: "0xa", floorBlock: 100, coveredTo: 400 });

    assert.ok(!("covered_from" in fetch.calls[0].body), "the ceiling is startBackfill's alone");
    assert.deepEqual(Object.keys(fetch.calls[0].body).sort(), ["covered_to", "updated_at"]);
  });

  test("a superseded extend is a no-op, not an error", async () => {
    const fetch = fakeFetch(ok([]));
    const out = await writerWith(fetch).extendBackfillDown({
      chainId: CHAIN,
      sourceKey: "0xa",
      floorBlock: 100,
      coveredTo: 900,
    });

    assert.equal(out, "superseded");
    assert.equal(fetch.calls.length, 1, "no INSERT fallback — this must never create a row");
  });

  test("throws on an HTTP error so the sweep cannot advance over unrecorded blocks", async () => {
    const fetch = fakeFetch({ ok: false, status: 409, text: async () => "quest_backfill_not_below_floor" });
    await assert.rejects(
      () => writerWith(fetch).extendBackfillDown({ chainId: CHAIN, sourceKey: "0xa", floorBlock: 100, coveredTo: 50 }),
      /not_below_floor/,
    );
  });
});

describe("advance — the guarded watermark", () => {
  // Two runs racing after a restart both read the same watermark and both try to write.
  // Without the guard the slower one lands last and drags the watermark backward, re-opening
  // a window it had already closed.
  test("guards on last_block=lte so it can never move backward", async () => {
    const fetch = fakeFetch(ok([{ last_block: 500 }]));
    const out = await writerWith(fetch).advance(CHAIN, "0xa", 500);

    assert.equal(out, "advanced");
    const { url, init } = fetch.calls[0];
    assert.equal(init.method, "PATCH");
    assert.ok(url.includes("last_block=lte.500"), url);
    assert.ok(url.includes("chain_id=eq.4441"), url);
    assert.ok(url.includes("source_key=eq.0xa"), url);
  });

  // `lte`, not `lt`. On a quiet chain a run legitimately finds no new blocks; if that left
  // updated_at untouched, the wall-clock freshness check would declare a healthy indexer dead.
  test("uses lte so an unchanged watermark still refreshes updated_at", async () => {
    const fetch = fakeFetch(ok([{ last_block: 500 }]));
    await writerWith(fetch).advance(CHAIN, "0xa", 500);

    const { url, init } = fetch.calls[0];
    assert.ok(url.includes("lte."), "lt would skip the equal case");
    assert.ok(!url.includes("last_block=lt."), url);
    assert.ok(init.headers.prefer.includes("return=representation"), "needs the row count back");
    assert.ok(typeof fetch.calls[0].body.updated_at === "string", "PATCH does not fire the column default");
  });

  test("creates the row on the first ever write for a source", async () => {
    const fetch = fakeFetch((url, init) => (init.method === "PATCH" ? ok([]) : ok([{ last_block: 100 }])));
    const out = await writerWith(fetch).advance(CHAIN, "0xnew", 100);

    assert.equal(out, "created");
    assert.equal(fetch.calls[1].method, "POST");
    assert.ok(fetch.calls[1].url.includes("on_conflict=chain_id,source_key"), fetch.calls[1].url);
  });

  // A newer run already moved past us: the PATCH matches nothing and the INSERT is ignored.
  // Correct outcome is a silent no-op, not an error and not a backward move.
  test("a superseded write is a no-op, not an error", async () => {
    const fetch = fakeFetch(ok([]));
    const out = await writerWith(fetch).advance(CHAIN, "0xa", 100);

    assert.equal(out, "superseded");
    assert.equal(fetch.calls[1].init.headers.prefer, "resolution=ignore-duplicates,return=representation");
  });

  test("throws on an HTTP error rather than reporting a phantom advance", async () => {
    const fetch = fakeFetch({ ok: false, status: 503, text: async () => "" });
    await assert.rejects(() => writerWith(fetch).advance(CHAIN, "0xa", 100), /HTTP 503/);
  });

  test("stamps updated_at from the injected clock", async () => {
    const fetch = fakeFetch(ok([{ last_block: 1 }]));
    const when = new Date("2026-07-26T12:00:00.000Z");
    await writerWith(fetch).advance(CHAIN, "0xa", 1, { now: () => when });

    assert.equal(fetch.calls[0].body.updated_at, when.toISOString());
  });
});
