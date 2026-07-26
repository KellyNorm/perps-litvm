// The settler's walk, and the single property that makes a second walker acceptable:
//
//     `frontier` is ALWAYS the lowest block of an unbroken run downward from the start.
//
// A hole inside [scanned_to .. scanned_from] is the one thing a cursor writer can do that
// makes the read path lie — coverageProvesAbsence treats that interval as contiguous, so an
// unread block inside it gets counted as "read and empty". scan.js prevents that with a
// frozen frontier. This walker prevents it by never continuing past a failure at all, and
// these tests are what pin that down.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CHUNK_BLOCKS, walkDown } from "../lib/walk.mjs";

/**
 * Fake log source. `logsAt` blocks produce a hit; `failAt` chunk-lows throw.
 * Every call is recorded so the walk's shape can be asserted, not just its result.
 */
function chain({ logsAt = {}, failAt = new Set() } = {}) {
  const calls = [];
  const getLogsFor = async (lo, hi) => {
    calls.push([lo, hi]);
    if (failAt.has(lo)) throw new Error("getLogs failed");
    return Object.keys(logsAt)
      .map(Number)
      .filter((b) => b >= lo && b <= hi)
      .map((b) => ({ blockNumber: b }));
  };
  getLogsFor.calls = calls;
  return getLogsFor;
}

const run = (over = {}) =>
  walkDown({
    getLogsFor: over.getLogsFor ?? chain(),
    from: over.from ?? 100_000,
    floor: over.floor ?? 0,
    budgetMs: over.budgetMs ?? 60_000,
    now: over.now ?? (() => 0),
    chunkBlocks: over.chunkBlocks ?? 10_000,
  });

describe("shape of the walk", () => {
  test("descends contiguously from `from`, in chunks", async () => {
    const getLogsFor = chain();
    await run({ getLogsFor, from: 100_000, floor: 60_000 });

    assert.equal(getLogsFor.calls[0][1], 100_000, "starts at the first uncovered block");
    for (const [lo, hi] of getLogsFor.calls) {
      assert.ok(hi - lo + 1 <= 10_000, `chunk ${lo}-${hi} too wide`);
    }
    for (let i = 1; i < getLogsFor.calls.length; i++) {
      assert.equal(getLogsFor.calls[i][1], getLogsFor.calls[i - 1][0] - 1, "gap between chunks");
    }
  });

  test("never reads below the floor", async () => {
    const getLogsFor = chain();
    await run({ getLogsFor, from: 100_000, floor: 75_000 });

    for (const [lo] of getLogsFor.calls) assert.ok(lo >= 75_000, `read ${lo}, below floor`);
  });

  test("reaching the floor reports it exactly", async () => {
    const out = await run({ from: 100_000, floor: 60_000 });

    assert.equal(out.stopped, "floor");
    assert.equal(out.frontier, 60_000, "equality is what the read path tests for");
    assert.equal(out.found, false);
  });
});

// ============================================================================
// THE INVARIANT: frontier is never ahead of contiguous coverage.
// ============================================================================
describe("frontier can never skip a block", () => {
  test("a failed chunk stops the walk dead — nothing below it is read", async () => {
    const getLogsFor = chain({ failAt: new Set([70_001]) });

    const out = await run({ getLogsFor, from: 100_000, floor: 0 });

    assert.equal(out.stopped, "error");
    assert.equal(out.frontier, 80_001, "frontier holds at the last successful chunk");
    for (const [lo] of getLogsFor.calls) {
      assert.ok(lo >= 70_001, `read ${lo}, below the failure — nothing below a hole may be touched`);
    }
  });

  // scan.js keeps reading past a hole (a positive below one is still proof) and freezes its
  // frontier. This walker returns instead. Both are hole-free; this one is simply less
  // clever, which is the whole reason a second walker is acceptable.
  test("it returns rather than continuing past a failure, unlike scan.js", async () => {
    const getLogsFor = chain({ failAt: new Set([90_001]), logsAt: { 50_000: true } });

    const out = await run({ getLogsFor, from: 100_000, floor: 0 });

    assert.equal(out.found, false, "the hit below the hole is not reached — and not needed");
    assert.equal(getLogsFor.calls.length, 1);
  });

  test("a failure on the very first chunk reports NO progress", async () => {
    const out = await run({ getLogsFor: chain({ failAt: new Set([90_001]) }), from: 100_000, floor: 0 });

    assert.equal(out.frontier, 100_001, "from + 1 — the caller must write nothing");
    assert.equal(out.chunks, 0);
  });

  test("running out of budget reports only what actually landed", async () => {
    let t = 0;
    const getLogsFor = chain();
    // Two chunks fit, then the clock jumps past the deadline.
    const out = await run({ getLogsFor, from: 100_000, floor: 0, budgetMs: 100, now: () => (t += 40) });

    assert.equal(out.stopped, "budget");
    assert.equal(out.frontier, 100_000 - getLogsFor.calls.length * 10_000 + 1);
    assert.ok(out.chunks > 0 && out.chunks < 10);
  });

  test("zero budget walks nothing and claims nothing", async () => {
    const getLogsFor = chain();
    const out = await run({ getLogsFor, from: 100_000, floor: 0, budgetMs: 0 });

    assert.equal(out.frontier, 100_001, "no progress");
    assert.equal(getLogsFor.calls.length, 0);
  });

  // Every exit path, asserted together: frontier is either untouched or the low end of a
  // run of consecutive successful chunks. There is no branch that produces anything else.
  test("across every stop reason, frontier equals from+1 - 10000*successfulChunks", async () => {
    const cases = [
      ["floor", { from: 100_000, floor: 60_000 }],
      ["error", { from: 100_000, floor: 0, getLogsFor: chain({ failAt: new Set([70_001]) }) }],
      ["budget", { from: 100_000, floor: 0, budgetMs: 100, now: (() => { let t = 0; return () => (t += 40); })() }],
    ];

    for (const [name, over] of cases) {
      const out = await run(over);
      const expected = out.chunks === 0 ? over.from + 1 : over.from + 1 - out.chunks * 10_000;
      assert.equal(out.frontier, Math.max(expected, over.floor), `${name}: frontier must match successful chunks exactly`);
    }
  });
});

describe("a positive stops everything", () => {
  test("returns found and the block, and stops walking", async () => {
    const getLogsFor = chain({ logsAt: { 95_000: true } });

    const out = await run({ getLogsFor, from: 100_000, floor: 0 });

    assert.equal(out.found, true);
    assert.equal(out.hitBlock, 95_000);
    assert.equal(getLogsFor.calls.length, 1);
  });

  // The completion is the answer; partial coverage walked on the way is irrelevant once the
  // quest is settled, and settler.mjs deliberately does not write it.
  test("reports the UNADVANCED frontier, since coverage no longer matters", async () => {
    const getLogsFor = chain({ logsAt: { 75_000: true } });

    const out = await run({ getLogsFor, from: 100_000, floor: 0 });

    assert.equal(out.found, true);
    assert.equal(out.frontier, 80_001, "the chunks walked before the hit, and nothing more");
  });
});

describe("agreement with the read path", () => {
  // Not a performance choice: the two writers share quest_cursor rows, so coverage the
  // settler produces must be coverage the read path will accept and extend. The parity test
  // in the frontend suite pins this against scan.js's own constant.
  test("the chunk size is the read path's 10k", () => {
    assert.equal(CHUNK_BLOCKS, 10_000);
  });
});
