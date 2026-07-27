// The staleness guard, condition by condition.
//
// quest_daily is the ONE table in this schema where absence is an answer. This guard is the
// only thing standing between "the indexer stopped" and "every wallet did nothing today".
// So each of the six fail-closed conditions gets its own test, asserted independently —
// a guard that catches five of six is a guard that manufactures falses on the sixth.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import {
  DEFAULT_BLOCK_TIME_MS,
  DEFAULT_MAX_LAG_MS,
  INDEXER_STALE,
  createIndexerState,
  maxLagBlocks,
} from "../../api/_lib/quest/indexerState.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddd";
const SOURCES = [A, B, C, D];

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const HEAD = 33_500_000;

/** A driver returning fixed rows. `at` defaults every source to the same fresh watermark. */
function driverOf(rows) {
  return { async load() { return rows; } };
}

function freshRows({ keys = SOURCES, lastBlock = HEAD - 100, ageMs = 60_000 } = {}) {
  return keys.map((sourceKey) => ({
    sourceKey,
    lastBlock,
    updatedAt: new Date(NOW - ageMs).toISOString(),
  }));
}

const read = (driver, over = {}) =>
  createIndexerState(driver).readFreshness({
    chainId: 4441,
    sourceKeys: SOURCES,
    head: HEAD,
    now: () => NOW,
    ...over,
  });

describe("the happy path", () => {
  test("a fully-indexed, recently-updated set is fresh", async () => {
    const out = await read(driverOf(freshRows()));

    assert.equal(out.fresh, true);
    assert.equal(out.reason, null);
    assert.equal(out.indexedThrough, HEAD - 100);
  });

  // An index-derived answer must be scoped to what the index actually reached, never to
  // head — the blocks in between are exactly where the wallet's activity might be.
  test("indexedThrough is the MINIMUM watermark, not the max and not head", async () => {
    const rows = freshRows();
    rows[2].lastBlock = HEAD - 900;

    const out = await read(driverOf(rows));

    assert.equal(out.fresh, true);
    assert.equal(out.indexedThrough, HEAD - 900, "the least-advanced stream decides");
  });
});

// ============================================================================
// THE SIX. Each one independently, because five-of-six is not a guard.
// ============================================================================
describe("fails closed", () => {
  test("1. a required source has no row", async () => {
    const out = await read(driverOf(freshRows({ keys: [A, B, C] })));

    assert.equal(out.fresh, false);
    assert.equal(out.reason, INDEXER_STALE);
    assert.equal(out.detail, `missing_source:${D}`);
    assert.equal(out.indexedThrough, null);
  });

  // A redeploy introduces a new address with no row — self-invalidating, exactly as
  // quest_cursor is, because the address IS the key.
  test("1b. a redeployed address reads as never-indexed rather than inheriting a watermark", async () => {
    const redeployed = "0x1111111111111111111111111111111111111111";
    const out = await read(driverOf(freshRows()), { sourceKeys: [A, B, C, redeployed] });

    assert.equal(out.fresh, false);
    assert.equal(out.detail, `missing_source:${redeployed}`);
  });

  test("2. rows came back for sources nobody asked about, and one required is still absent", async () => {
    const rows = [...freshRows({ keys: [A, B, C] }), { sourceKey: "0xdeadbeef", lastBlock: HEAD, updatedAt: new Date(NOW).toISOString() }];
    const out = await read(driverOf(rows));

    assert.equal(out.fresh, false, "a full row count must not substitute for the RIGHT rows");
    assert.equal(out.detail, `missing_source:${D}`);
  });

  test("3. the read threw", async () => {
    const out = await read({ async load() { throw new Error("supabase down"); } });

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "read_failed");
  });

  test("3b. the read returned nonsense", async () => {
    for (const value of [null, undefined, "rows", 42, {}]) {
      const out = await read(driverOf(value));
      assert.equal(out.fresh, false, `should reject ${JSON.stringify(value)}`);
    }
  });

  test("3c. a row is present but unreadable, which is worse than absent", async () => {
    for (const broken of [
      { sourceKey: D, lastBlock: "not-a-number", updatedAt: new Date(NOW).toISOString() },
      { sourceKey: D, lastBlock: -1, updatedAt: new Date(NOW).toISOString() },
      { sourceKey: D, lastBlock: 1.5, updatedAt: new Date(NOW).toISOString() },
      { sourceKey: D, lastBlock: HEAD, updatedAt: "never" },
      { sourceKey: D, lastBlock: HEAD },
      { sourceKey: "", lastBlock: HEAD, updatedAt: new Date(NOW).toISOString() },
    ]) {
      const out = await read(driverOf([...freshRows({ keys: [A, B, C] }), broken]));
      assert.equal(out.fresh, false, `should reject ${JSON.stringify(broken)}`);
    }
  });

  test("4. the job is not running — updated_at is older than the threshold", async () => {
    const out = await read(driverOf(freshRows({ ageMs: DEFAULT_MAX_LAG_MS + 1_000 })));

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "updated_at_stale");
  });

  test("4b. ONE stale source makes the whole answer stale", async () => {
    const rows = freshRows();
    rows[1].updatedAt = new Date(NOW - DEFAULT_MAX_LAG_MS - 1_000).toISOString();

    const out = await read(driverOf(rows));

    assert.equal(out.fresh, false, "a wallet whose only activity was on the lagging source must not read inactive");
    assert.equal(out.detail, "updated_at_stale");
  });

  test("5. the job runs but is losing ground — block lag past the threshold", async () => {
    const behind = HEAD - maxLagBlocks() - 1;
    const out = await read(driverOf(freshRows({ lastBlock: behind })));

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "block_lag");
  });

  test("5b. lag exactly at the threshold is still fresh; one past it is not", async () => {
    const atLimit = HEAD - maxLagBlocks();
    assert.equal((await read(driverOf(freshRows({ lastBlock: atLimit })))).fresh, true);
    assert.equal((await read(driverOf(freshRows({ lastBlock: atLimit - 1 })))).fresh, false);
  });

  // THE NASTY ONE. A testnet re-genesis leaves the watermark above the new head. `head -
  // last_block` goes negative, which reads as ZERO lag — so without this check the guard
  // reports a permanently fresh, permanently empty index and hands out confident falses
  // forever, with nothing in any log to say why.
  test("6. head below the watermark — a chain reset must not read as zero lag", async () => {
    const out = await read(driverOf(freshRows({ lastBlock: HEAD + 1 })));

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "head_behind_watermark");
  });

  test("6b. a wildly rewound head is caught too, not just an off-by-one", async () => {
    const out = await read(driverOf(freshRows({ lastBlock: HEAD })), { head: 1_000 });

    assert.equal(out.fresh, false);
    assert.equal(out.detail, "head_behind_watermark");
  });

  test("6c. head exactly equal to the watermark is fine — a fully caught-up indexer", async () => {
    const out = await read(driverOf(freshRows({ lastBlock: HEAD })));
    assert.equal(out.fresh, true);
  });
});

describe("degenerate inputs", () => {
  // Vacuous truth is the enemy here: zero required sources must not mean "all of them fresh".
  test("no required sources proves nothing rather than proving it vacuously", async () => {
    for (const keys of [[], null, undefined]) {
      const out = await read(driverOf(freshRows()), { sourceKeys: keys });
      assert.equal(out.fresh, false);
      assert.equal(out.detail, "no_required_sources");
    }
  });

  test("an unusable head is stale, not zero", async () => {
    for (const head of [null, undefined, -1, 1.5, NaN, "33500000"]) {
      const out = await read(driverOf(freshRows()), { head });
      assert.equal(out.fresh, false, `should reject head=${JSON.stringify(head)}`);
      assert.equal(out.detail, "no_head");
    }
  });

  test("source keys are compared case-insensitively, so checksum casing cannot fake a miss", async () => {
    const out = await read(driverOf(freshRows()), { sourceKeys: SOURCES.map((s) => s.toUpperCase().replace("0X", "0x")) });
    assert.equal(out.fresh, true);
  });
});

describe("the threshold is one number, not two", () => {
  // Two independently-configured numbers meaning the same duration can disagree, and the
  // direction they disagree in decides whether the guard does anything at all.
  test("maxLagBlocks is derived from maxLagMs and the block time", () => {
    assert.equal(maxLagBlocks({ lagMs: 900_000, blockMs: 300 }), 3_000);
    assert.equal(maxLagBlocks({ lagMs: 60_000, blockMs: 320 }), Math.ceil(60_000 / 320));
  });

  test("defaults are 15 minutes at the measured block time", () => {
    assert.equal(DEFAULT_MAX_LAG_MS, 15 * 60 * 1000);
    assert.equal(DEFAULT_BLOCK_TIME_MS, 320);
  });

  test("never returns zero, which would make every index permanently stale", () => {
    assert.ok(maxLagBlocks({ lagMs: 1, blockMs: 100_000 }) >= 1);
  });
});

// The property the whole file exists for, stated once, directly.
describe("the invariant", () => {
  test("NO staleness condition ever reports fresh", async () => {
    const cases = [
      ["missing source", driverOf(freshRows({ keys: [A, B, C] })), {}],
      ["read threw", { async load() { throw new Error("x"); } }, {}],
      ["read nonsense", driverOf(null), {}],
      ["updated_at stale", driverOf(freshRows({ ageMs: DEFAULT_MAX_LAG_MS + 1 })), {}],
      ["block lag", driverOf(freshRows({ lastBlock: HEAD - maxLagBlocks() - 1 })), {}],
      ["chain reset", driverOf(freshRows({ lastBlock: HEAD + 1 })), {}],
      ["no sources", driverOf(freshRows()), { sourceKeys: [] }],
      ["no head", driverOf(freshRows()), { head: null }],
    ];

    for (const [name, driver, over] of cases) {
      const out = await read(driver, over);
      assert.equal(out.fresh, false, `${name} must not be fresh`);
      assert.equal(out.reason, INDEXER_STALE, `${name} must carry the public reason code`);
      assert.equal(out.indexedThrough, null, `${name} must expose no watermark to read against`);
    }
  });
});

// ============================================================================
// THE HANDOFF WATERMARK, CARRIED THROUGH
// ============================================================================
// completion_from is not a freshness input — a null one must not make a source stale, it
// makes the ONE-TIME-quest proof fail, over in indexProof.js, where that is the right
// failure. What this guard owes that proof is the value, validated, and only on the fresh
// path: a stale verdict carries no rows at all, so nothing downstream can join against
// coverage this file has just refused to vouch for.

describe("completion_from passes through to the one-time-quest proof", () => {
  const withHandoff = (completionFrom) => freshRows().map((r) => ({ ...r, completionFrom }));

  test("a fresh result carries the per-source rows, keyed", async () => {
    const out = await read(driverOf(withHandoff(32_000_000)));

    assert.equal(out.fresh, true);
    assert.equal(out.sources.length, SOURCES.length);
    assert.deepEqual(out.sources.map((s) => s.sourceKey).sort(), SOURCES.slice().sort());
    assert.equal(out.sources[0].completionFrom, 32_000_000);
  });

  // NULL IS NOT ZERO. `Number(null)` is 0, which would read as "completions have been
  // written since the genesis block" — the coverage claim 0005_quest_backfill.sql refuses to
  // invent. It must survive as null so the proof fails closed on it.
  test("a null handoff stays null, and does not make the source stale", async () => {
    const out = await read(driverOf(withHandoff(null)));

    assert.equal(out.fresh, true, "freshness is about last_block and updated_at, not this column");
    assert.equal(out.sources[0].completionFrom, null);
  });

  test("an unparseable handoff degrades to null rather than to a number", async () => {
    for (const bad of ["", "wat", -1, 1.5, {}]) {
      const out = await read(driverOf(withHandoff(bad)));
      assert.equal(out.sources[0].completionFrom, null, `${JSON.stringify(bad)} must not become a block`);
    }
  });

  test("a string-encoded handoff is parsed, like every other bigint here", async () => {
    const out = await read(driverOf(withHandoff("32000000")));
    assert.equal(out.sources[0].completionFrom, 32_000_000);
  });

  // A stale verdict must not hand out rows: they describe an index that has just been
  // declared unusable, and the proof's only correct move is to ignore them entirely.
  test("a stale result carries no rows at all", async () => {
    const out = await read(driverOf(withHandoff(32_000_000)), { head: HEAD - 1_000_000 });

    assert.equal(out.fresh, false);
    assert.equal(out.sources, null);
  });
});
