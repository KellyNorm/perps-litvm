// Dating logs by BLOCK timestamp rather than wall clock, and doing it cheaply.
//
// The correctness property: a log's day is the day its block was mined, never the day the
// indexer happened to run. Get that wrong and a catch-up run files six hours of backlog
// under today, or a run crossing midnight files the tail of yesterday under today — either
// way the wallet reads "not active" on the day it actually was.
//
// The cost property: zero calls when nothing matched, two when the range fits in one day,
// and bounded by the range span (not the log count) when it does not.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createBlockDayResolver, dayFromTimestamp } from "../lib/blockDay.mjs";

const DAY = 86_400;
/** 2026-07-26T00:00:00Z */
const MIDNIGHT = Math.floor(Date.UTC(2026, 6, 26) / 1000);

/**
 * Fake provider. Block N has timestamp `base + N * blockSeconds`, so timestamps are
 * monotonic in block number, as Nitro guarantees.
 */
function chain({ base = MIDNIGHT, blockSeconds = 1, missing = new Set() } = {}) {
  const asked = [];
  const getBlock = async (n) => {
    asked.push(n);
    if (missing.has(n)) return null;
    return { timestamp: base + n * blockSeconds };
  };
  getBlock.asked = asked;
  return getBlock;
}

const logsAt = (...blocks) => blocks.map((blockNumber) => ({ blockNumber }));

describe("dayFromTimestamp", () => {
  test("is the UTC calendar day, matching utcDay() in cache.js", () => {
    assert.equal(dayFromTimestamp(MIDNIGHT), "2026-07-26");
    assert.equal(dayFromTimestamp(MIDNIGHT + DAY - 1), "2026-07-26", "23:59:59 is still that day");
    assert.equal(dayFromTimestamp(MIDNIGHT + DAY), "2026-07-27");
  });

  test("rejects a non-timestamp rather than producing an epoch day", () => {
    for (const bad of [undefined, null, NaN, -1, "1700000000"]) {
      assert.throws(() => dayFromTimestamp(bad), /not a unix time/);
    }
  });
});

describe("cost", () => {
  // The common case on a quiet testnet: the range matched nothing at all.
  test("no logs costs ZERO rpc calls", async () => {
    const getBlock = chain();
    const r = createBlockDayResolver(getBlock);

    const days = await r.resolve([], { fromBlock: 100, toBlock: 200 });

    assert.equal(days.size, 0);
    assert.equal(getBlock.asked.length, 0, "resolution must be lazy — nothing until a log exists");
    assert.equal(r.calls(), 0);
  });

  test("a same-day range costs exactly two calls, however many logs", async () => {
    const getBlock = chain();
    const r = createBlockDayResolver(getBlock);

    const many = logsAt(...Array.from({ length: 500 }, (_, i) => 100 + i));
    const days = await r.resolve(many, { fromBlock: 100, toBlock: 600 });

    assert.equal(r.calls(), 2, "the endpoints, and nothing else");
    assert.equal(days.size, 500);
    for (const d of days.values()) assert.equal(d, "2026-07-26");
  });

  // Four sources scan the same range in one run; the endpoints must not be re-fetched.
  test("memoises across sources within a run", async () => {
    const getBlock = chain();
    const r = createBlockDayResolver(getBlock);

    await r.resolve(logsAt(150), { fromBlock: 100, toBlock: 600 });
    await r.resolve(logsAt(200), { fromBlock: 100, toBlock: 600 });
    await r.resolve(logsAt(300), { fromBlock: 100, toBlock: 600 });

    assert.equal(r.calls(), 2, "one pair of endpoint lookups for the whole run");
  });
});

describe("midnight", () => {
  // Block 0 is exactly midnight, so a range starting before it straddles the boundary.
  const straddling = () => chain({ base: MIDNIGHT - 100, blockSeconds: 1 });

  test("attributes each log to its own day across the boundary", async () => {
    const r = createBlockDayResolver(straddling());

    // Blocks 0..99 are 2026-07-25 (base is 100s before midnight); 100+ are 2026-07-26.
    const days = await r.resolve(logsAt(50, 99, 100, 150), { fromBlock: 0, toBlock: 200 });

    assert.equal(days.get(50), "2026-07-25");
    assert.equal(days.get(99), "2026-07-25", "the last second of yesterday is yesterday");
    assert.equal(days.get(100), "2026-07-26");
    assert.equal(days.get(150), "2026-07-26");
  });

  // A busy range at the real range-cap width: ~13 lookups to bisect 5,000 blocks beats
  // naming 60 log-bearing blocks, and the resolver works that out rather than assuming it.
  test("bisects a busy wide range, and it is genuinely cheaper", async () => {
    const getBlock = chain({ base: MIDNIGHT - 2_000, blockSeconds: 1 });
    const r = createBlockDayResolver(getBlock);

    const many = logsAt(...Array.from({ length: 60 }, (_, i) => i * 80));
    const days = await r.resolve(many, { fromBlock: 0, toBlock: 5_000 });

    assert.equal(days.get(1_920), "2026-07-25", "block 1920 is 80s before midnight");
    assert.equal(days.get(2_000), "2026-07-26", "block 2000 is midnight exactly");
    assert.ok(r.calls() < many.length, `bisection should beat ${many.length} lookups, used ${r.calls()}`);
  });

  // The other end of the same trade-off: over a narrow range bisection is NOT cheaper, so
  // the resolver must not reach for it. A fixed threshold got this wrong.
  test("does not bisect a narrow range where per-block lookups are cheaper", async () => {
    const getBlock = straddling();
    const r = createBlockDayResolver(getBlock);

    const few = logsAt(50, 99, 100, 150);
    const days = await r.resolve(few, { fromBlock: 0, toBlock: 200 });

    assert.equal(days.get(99), "2026-07-25");
    assert.equal(days.get(100), "2026-07-26");
    assert.equal(r.calls(), 2 + few.length, "two endpoints plus one per log-bearing block");
  });

  test("bisection finds the exact boundary block", async () => {
    const getBlock = straddling();
    const r = createBlockDayResolver(getBlock, { maxPerBlockLookups: 0 });

    const days = await r.resolve(logsAt(98, 99, 100, 101), { fromBlock: 0, toBlock: 200 });

    assert.deepEqual(
      [days.get(98), days.get(99), days.get(100), days.get(101)],
      ["2026-07-25", "2026-07-25", "2026-07-26", "2026-07-26"],
      "off by one here misfiles a whole day's worth of activity",
    );
  });
});

describe("catch-up", () => {
  // A run replaying a long backlog must stamp each block with ITS day, not with today.
  test("a multi-day range dates each log by its own block", async () => {
    const getBlock = chain({ base: MIDNIGHT, blockSeconds: 3600 }); // one block per hour
    const r = createBlockDayResolver(getBlock, { maxPerBlockLookups: 100 });

    const days = await r.resolve(logsAt(1, 25, 49), { fromBlock: 0, toBlock: 72 });

    assert.equal(days.get(1), "2026-07-26");
    assert.equal(days.get(25), "2026-07-27");
    assert.equal(days.get(49), "2026-07-28");
  });
});

describe("failing closed", () => {
  // A pruned or lagging node returning null must not degrade to "skip this log": that
  // leaves the block permanently unindexed under a watermark claiming to cover it.
  test("a null block throws rather than skipping the log", async () => {
    const r = createBlockDayResolver(chain({ missing: new Set([100]) }));

    await assert.rejects(() => r.resolve(logsAt(150), { fromBlock: 100, toBlock: 200 }), /returned no timestamp/);
  });

  test("a null block on the slow path throws too", async () => {
    const getBlock = chain({ base: MIDNIGHT - 100, missing: new Set([50]) });
    const r = createBlockDayResolver(getBlock, { maxPerBlockLookups: 100 });

    await assert.rejects(() => r.resolve(logsAt(50), { fromBlock: 0, toBlock: 200 }), /returned no timestamp/);
  });

  test("a log with no block number throws", async () => {
    const r = createBlockDayResolver(chain());
    await assert.rejects(() => r.resolve([{ blockNumber: undefined }], { fromBlock: 1, toBlock: 2 }), /no usable blockNumber/);
  });

  // The shortcut and the bisection both assume timestamps never decrease. Nitro guarantees
  // it — but if the endpoints come back out of order we must not trust the assumption, so
  // we fall through to naming each block, which needs no assumption at all.
  test("non-monotonic endpoints fall back to per-block lookups instead of guessing", async () => {
    const getBlock = async (n) => ({ timestamp: n === 200 ? MIDNIGHT - DAY : MIDNIGHT });
    const r = createBlockDayResolver(getBlock);

    const days = await r.resolve(logsAt(150), { fromBlock: 100, toBlock: 200 });

    assert.equal(days.get(150), "2026-07-26", "dated from block 150 itself, not from the bad endpoints");
  });
});
