// The scanner's contract, which is the whole safety story of Tier 2:
//   a positive stops the walk and is proof;
//   a negative is an answer ONLY if every source was walked to a validated floor with no
//   lost chunks — otherwise it is `exhausted`, which the handler reports as indeterminate.
//
// Fully offline: fake contracts, injected clock, injected floor check. Nothing here waits
// on a timer or touches an RPC.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { CHUNK_BLOCKS, MAX_CHUNKS, TIME_BUDGET_MS, scanForEvent } from "../../api/_lib/quest/scan.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

/**
 * Fake source. `logsAt` maps a block number to a log; a chunk returns any log whose block
 * falls inside it. `failChunks` makes specific chunk starts throw.
 */
function source({ floor, logsAt = {}, fail = () => false, label = "src" } = {}) {
  const queries = [];
  return {
    floor,
    label,
    address: "0x0000000000000000000000000000000000000001",
    queries,
    filter: {},
    contract: {
      address: "0x0000000000000000000000000000000000000001",
      async queryFilter(_filter, lo, hi) {
        queries.push([lo, hi]);
        if (fail(lo, hi)) throw new Error("getLogs failed");
        return Object.keys(logsAt)
          .map(Number)
          .filter((b) => b >= lo && b <= hi)
          .map((b) => ({ blockNumber: b }));
      },
    },
  };
}

const floorOk = async () => true;

describe("a positive stops the walk", () => {
  test("returns found immediately and does not keep scanning", async () => {
    // Log sits in the first chunk down from head.
    const s = source({ floor: 0, logsAt: { 999_990: true } });

    const out = await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(out.found, true);
    assert.equal(out.complete, true);
    assert.equal(out.exhausted, false);
    assert.equal(out.chunksUsed, 1);
    assert.equal(s.queries.length, 1);
  });

  test("a hit in a later source still short-circuits the rest", async () => {
    const first = source({ floor: 990_000, label: "new" });
    const second = source({ floor: 900_000, logsAt: { 950_000: true }, label: "old" });

    const out = await scanForEvent([first, second], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(out.found, true);
    assert.ok(second.queries.length >= 1);
  });
});

describe("a negative is only an answer when the walk is complete", () => {
  test("walking every source to its floor yields a PROVEN negative", async () => {
    const s = source({ floor: 960_000 });

    const out = await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(out.found, false);
    assert.equal(out.complete, true);
    assert.equal(out.exhausted, false);
    assert.equal(out.scannedDownTo, 960_000, "must reach the floor exactly, not below it");
  });

  test("never queries below the floor", async () => {
    const s = source({ floor: 975_000 });
    await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    for (const [lo] of s.queries) assert.ok(lo >= 975_000, `queried ${lo}, below floor`);
  });

  // THE RULE THAT MATTERS. A budget-limited scan must never look like proof of absence.
  test("budget exhaustion is INDETERMINATE, never a proven false", async () => {
    // Floor is 10M blocks down — far beyond 12 chunks, like the real perps contracts.
    const s = source({ floor: 0 });

    const out = await scanForEvent([s], { head: 10_000_000, verifyFloor: floorOk });

    assert.equal(out.found, false);
    assert.equal(out.complete, false, "an incomplete walk must NOT be reported as complete");
    assert.equal(out.exhausted, true);
    assert.equal(out.reason, "budget_exhausted");
    assert.equal(out.chunksUsed, MAX_CHUNKS);
  });

  test("the time budget stops the walk even with chunks left", async () => {
    const s = source({ floor: 0 });
    // Clock jumps past the budget after the second chunk.
    let calls = 0;
    const now = () => (++calls > 3 ? TIME_BUDGET_MS + 1 : 0);

    const out = await scanForEvent([s], { head: 10_000_000, now, verifyFloor: floorOk });

    assert.equal(out.exhausted, true);
    assert.equal(out.reason, "budget_exhausted");
    assert.ok(out.chunksUsed < MAX_CHUNKS, "should stop on time, before the chunk cap");
  });

  // A chunk lost to an error is a hole in the coverage. Finding nothing in a range you
  // did not fully read is not evidence of anything.
  test("a lost chunk downgrades the result to indeterminate", async () => {
    const s = source({ floor: 900_000, fail: (lo) => lo === 950_001 });

    const out = await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(out.found, false);
    assert.equal(out.complete, false);
    assert.equal(out.exhausted, true);
    assert.equal(out.reason, "chunk_error");
  });

  // The first chunk (950_001-1_000_000) is lost; the hit sits in the second (900_001-950_000).
  // A positive is proof regardless of coverage holes elsewhere.
  test("a lost chunk does NOT suppress a hit found elsewhere", async () => {
    const s = source({ floor: 900_000, fail: (lo) => lo === 950_001, logsAt: { 940_000: true } });

    const out = await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(out.found, true);
    assert.equal(out.complete, true);
  });
});

describe("floor validation", () => {
  // A floor set too high (stale env after a redeploy) would end the walk above the events
  // and manufacture a confident false. The check exists to make that impossible.
  test("an unverified floor blocks the proven negative", async () => {
    const s = source({ floor: 960_000 });

    const out = await scanForEvent([s], { head: 1_000_000, verifyFloor: async () => false });

    assert.equal(out.complete, false);
    assert.equal(out.exhausted, true);
    assert.equal(out.reason, "floor_unverified");
  });

  test("a throwing floor check is treated as unverified, not as verified", async () => {
    const s = source({ floor: 960_000 });

    const out = await scanForEvent([s], {
      head: 1_000_000,
      verifyFloor: async () => {
        throw new Error("rpc down");
      },
    });

    assert.equal(out.reason, "floor_unverified");
    assert.equal(out.complete, false);
  });

  // Only on the negative path — a positive is already proof and must not pay for it.
  test("is skipped entirely when a hit was found", async () => {
    const s = source({ floor: 960_000, logsAt: { 999_999: true } });
    let checked = false;

    const out = await scanForEvent([s], {
      head: 1_000_000,
      verifyFloor: async () => {
        checked = true;
        return true;
      },
    });

    assert.equal(out.found, true);
    assert.equal(checked, false);
  });
});

describe("chunking", () => {
  test("walks backward from head in 50k chunks, contiguously", async () => {
    const s = source({ floor: 850_000 });
    await scanForEvent([s], { head: 1_000_000, verifyFloor: floorOk });

    assert.equal(s.queries[0][1], 1_000_000, "first chunk starts at head");
    for (const [lo, hi] of s.queries) {
      assert.ok(hi - lo + 1 <= CHUNK_BLOCKS, `chunk ${lo}-${hi} exceeds ${CHUNK_BLOCKS}`);
    }
    // Contiguous, no gaps: each chunk starts one block below the previous one's floor.
    for (let i = 1; i < s.queries.length; i++) {
      assert.equal(s.queries[i][1], s.queries[i - 1][0] - 1, "gap between chunks");
    }
  });

  // 10k, not 50k: getLogs costs ~0.3ms/block either way (measured 2026-07-25), so the
  // smaller chunk buys the same coverage in ~3.5s steps instead of ~15s ones — less waste
  // when the time budget cuts off mid-chunk, and a tenth the coverage lost to a bad chunk.
  test("the default chunk size is the measured 10k", () => {
    assert.equal(CHUNK_BLOCKS, 10_000);
  });

  test("sources share one budget rather than getting one each", async () => {
    const a = source({ floor: 0, label: "a" });
    const b = source({ floor: 0, label: "b" });

    const out = await scanForEvent([a, b], { head: 10_000_000, verifyFloor: floorOk });

    assert.equal(out.chunksUsed, MAX_CHUNKS);
    assert.equal(a.queries.length + b.queries.length, MAX_CHUNKS);
    assert.equal(b.queries.length, 0, "budget spent on the first source, as ordered");
  });
});
