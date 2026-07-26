// The scanner's contract, which is the whole safety story of Tier 2:
//   a positive stops the walk and is proof;
//   a negative is an answer ONLY if every source was walked to a validated floor with no
//   lost chunks — otherwise it is `exhausted`, which the handler reports as indeterminate.
//
// Fully offline: fake contracts, injected clock, injected floor check. Nothing here waits
// on a timer or touches an RPC.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import {
  CHUNK_BLOCKS,
  MAX_CHUNKS,
  TIME_BUDGET_MS,
  coverageProvesAbsence,
  isUsablePrior,
  scanForEvent,
  sourceKeyOf,
} from "../../api/_lib/quest/scan.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

/**
 * Fake source. `logsAt` maps a block number to a log; a chunk returns any log whose block
 * falls inside it. `fail` makes specific chunks throw. `trace`, when shared between
 * sources, records the global order of getLogs calls — which is how the phase-ordering
 * tests below observe that every gap closes before any source descends.
 */
function source({
  floor,
  logsAt = {},
  fail = () => false,
  label = "src",
  address = "0x0000000000000000000000000000000000000001",
  trace = null,
} = {}) {
  const queries = [];
  return {
    floor,
    label,
    address,
    queries,
    filter: {},
    contract: {
      address,
      async queryFilter(_filter, lo, hi) {
        queries.push([lo, hi]);
        trace?.push([label, lo, hi]);
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

/** Coverage keyed the way scanForEvent expects it, straight from a scan's own output. */
function asPrior(coverage) {
  return Object.fromEntries(coverage.map((c) => [c.sourceKey, c]));
}

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

// ============================================================================
// COVERAGE → VERDICT. The derivation is the never-lie invariant in one function, so it is
// tested directly as well as through the scanner.
// ============================================================================
describe("coverageProvesAbsence — the only route to a false", () => {
  const src = { floor: 1_000, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const key = sourceKeyOf(src);
  const head = 100_000;
  const full = { [key]: { floorBlock: 1_000, scannedFrom: head, scannedTo: 1_000 } };

  test("floor-to-head coverage on every source proves absence", () => {
    assert.equal(coverageProvesAbsence([src], full, head), true);
  });

  // THE HEADLINE INVARIANT. Every one of these is coverage that stops SHORT, and not one
  // of them may buy a proven negative.
  const shortfalls = [
    ["one block above the floor", { floorBlock: 1_000, scannedFrom: head, scannedTo: 1_001 }],
    ["barely started", { floorBlock: 1_000, scannedFrom: head, scannedTo: 99_000 }],
    ["one block below head", { floorBlock: 1_000, scannedFrom: head - 1, scannedTo: 1_000 }],
    ["stale top and bottom", { floorBlock: 1_000, scannedFrom: 90_000, scannedTo: 40_000 }],
    ["floor reached but top far behind", { floorBlock: 1_000, scannedFrom: 50_000, scannedTo: 1_000 }],
    ["non-integer bounds", { floorBlock: 1_000, scannedFrom: head, scannedTo: "1000" }],
  ];

  for (const [name, cov] of shortfalls) {
    test(`partial coverage (${name}) is NOT a proven false`, () => {
      assert.equal(coverageProvesAbsence([src], { [key]: cov }, head), false);
    });
  }

  test("missing coverage is not a proven false", () => {
    assert.equal(coverageProvesAbsence([src], {}, head), false);
    assert.equal(coverageProvesAbsence([src], null, head), false);
  });

  // A row claiming to have read below the contract's first block is corrupt, not thorough.
  // Equality with the floor — never <= — is what refuses it.
  test("coverage claiming to go BELOW the floor is not a proven false", () => {
    const cov = { [key]: { floorBlock: 1_000, scannedFrom: head, scannedTo: 500 } };
    assert.equal(coverageProvesAbsence([src], cov, head), false);
  });

  test("no sources proves nothing, rather than proving it vacuously", () => {
    assert.equal(coverageProvesAbsence([], full, head), false);
    assert.equal(coverageProvesAbsence(null, full, head), false);
  });

  // Requirement 5: a multi-source quest is settled by its LEAST-covered source.
  test("one complete source cannot settle a quest whose other source is short", () => {
    const other = { floor: 2_000, address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    const coverage = {
      ...full,
      [sourceKeyOf(other)]: { floorBlock: 2_000, scannedFrom: head, scannedTo: 60_000 },
    };

    assert.equal(coverageProvesAbsence([src, other], coverage, head), false);
    assert.equal(
      coverageProvesAbsence([src, other], { ...full, [sourceKeyOf(other)]: { floorBlock: 2_000, scannedFrom: head, scannedTo: 2_000 } }, head),
      true,
    );
  });

  // head moves every poll. Yesterday's complete coverage is not today's.
  test("coverage that was complete at an older head is no longer complete", () => {
    assert.equal(coverageProvesAbsence([src], full, head), true);
    assert.equal(coverageProvesAbsence([src], full, head + 1), false);
  });
});

describe("isUsablePrior — floor coupling", () => {
  const src = { floor: 1_000 };

  test("accepts an interval computed against the current floor", () => {
    assert.equal(isUsablePrior({ floorBlock: 1_000, scannedFrom: 9_000, scannedTo: 1_000 }, src), true);
  });

  // Requirement 6. A floor is bound to an address; coverage computed against a different
  // one is void in BOTH directions — lower means unwalked history below us, higher means we
  // may have been reading a different contract.
  test("rejects an interval computed against a different floor", () => {
    assert.equal(isUsablePrior({ floorBlock: 900, scannedFrom: 9_000, scannedTo: 1_000 }, src), false);
    assert.equal(isUsablePrior({ floorBlock: 1_100, scannedFrom: 9_000, scannedTo: 1_100 }, src), false);
  });

  test("rejects malformed and inverted intervals", () => {
    assert.equal(isUsablePrior(null, src), false);
    assert.equal(isUsablePrior({ floorBlock: 1_000, scannedFrom: 1_000, scannedTo: 9_000 }, src), false);
    assert.equal(isUsablePrior({ floorBlock: 1_000, scannedFrom: 9_000, scannedTo: 500 }, src), false);
    assert.equal(isUsablePrior({ floorBlock: 1_000, scannedFrom: 9_000, scannedTo: null }, src), false);
  });
});

// ============================================================================
// RESUME — the convergence machinery.
// ============================================================================
describe("resuming from prior coverage", () => {
  const budget = { chunkBlocks: 10_000, maxChunks: 3, verifyFloor: floorOk };

  test("descends from below prior coverage instead of re-walking it", async () => {
    const s = source({ floor: 0 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 70_001 } };

    await scanForEvent([s], { head: 100_000, priorCoverage: prior, ...budget });

    assert.equal(s.queries[0][1], 70_000, "must resume just below the covered interval");
    for (const [lo] of s.queries) assert.ok(lo < 70_001, `re-walked already-covered block ${lo}`);
  });

  test("extends the interval downward and keeps the top anchored", async () => {
    const s = source({ floor: 0 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 70_001 } };

    const out = await scanForEvent([s], { head: 100_000, priorCoverage: prior, ...budget });

    assert.deepEqual(out.coverage, [
      { sourceKey: sourceKeyOf(s), floorBlock: 0, scannedFrom: 100_000, scannedTo: 40_001, dirty: true },
    ]);
  });

  test("coverage that already spans floor→head settles with ZERO chunks", async () => {
    const s = source({ floor: 1_000 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 1_000, scannedFrom: 100_000, scannedTo: 1_000 } };

    const out = await scanForEvent([s], { head: 100_000, priorCoverage: prior, ...budget });

    assert.equal(out.complete, true);
    assert.equal(out.found, false);
    assert.equal(out.chunksUsed, 0, "settled work must not be re-done");
    assert.equal(s.queries.length, 0);
  });

  // The floor is re-proved on every derivation, not only on the poll that reaches it: the
  // coverage is durable and long-lived, and cashing it in for a negative is exactly when
  // the floor it was computed against has to still be right.
  test("a zero-chunk settle still validates the floor", async () => {
    const s = source({ floor: 1_000 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 1_000, scannedFrom: 100_000, scannedTo: 1_000 } };

    let checked = 0;
    const out = await scanForEvent([s], {
      head: 100_000,
      priorCoverage: prior,
      ...budget,
      verifyFloor: async () => {
        checked++;
        return false;
      },
    });

    assert.equal(checked, 1, "the floor must be re-proved even when no chunk ran");
    assert.equal(out.complete, false);
    assert.equal(out.reason, "floor_unverified");
  });

  // Requirement 6, end to end: the address is in the key, so a redeploy finds no row.
  test("prior coverage against a stale floor is discarded and the walk restarts at head", async () => {
    const s = source({ floor: 1_000 });
    const stale = { [sourceKeyOf(s)]: { floorBlock: 500, scannedFrom: 100_000, scannedTo: 500 } };

    const out = await scanForEvent([s], { head: 100_000, priorCoverage: stale, ...budget });

    assert.equal(s.queries[0][1], 100_000, "must restart from head, not trust the stale interval");
    assert.equal(out.complete, false, "a stale interval must never settle the answer");
    assert.equal(out.coverage[0].scannedFrom, 100_000);
    assert.equal(out.coverage[0].floorBlock, 1_000);
  });

  test("garbage prior coverage is ignored rather than trusted", async () => {
    const s = source({ floor: 1_000 });
    const junk = { [sourceKeyOf(s)]: { floorBlock: 1_000, scannedFrom: 5, scannedTo: 99_000 } };

    const out = await scanForEvent([s], { head: 100_000, priorCoverage: junk, ...budget });

    assert.equal(s.queries[0][1], 100_000);
    assert.equal(out.complete, false);
  });
});

describe("phase A — closing the top gap", () => {
  const budget = { chunkBlocks: 10_000, maxChunks: 6, verifyFloor: floorOk };

  test("scans the new range above prior coverage BEFORE descending further", async () => {
    const s = source({ floor: 0 });
    // Covered to 100_000 last poll; head has since moved to 115_000.
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 60_001 } };

    const out = await scanForEvent([s], { head: 115_000, priorCoverage: prior, ...budget });

    assert.deepEqual(s.queries.slice(0, 2), [
      [105_001, 115_000],
      [100_001, 105_000],
    ]);
    assert.equal(s.queries[2][1], 60_000, "then continues descending from below the old bottom");
    // BOTH ends moved: a genuine contiguous interval, wider than either end alone.
    assert.equal(out.coverage[0].scannedFrom, 115_000);
    assert.equal(out.coverage[0].scannedTo, 20_001);
  });

  test("every source closes its gap before any source descends", async () => {
    const trace = [];
    const a = source({ floor: 0, label: "a", address: "0xaa".padEnd(42, "a"), trace });
    const b = source({ floor: 0, label: "b", address: "0xbb".padEnd(42, "b"), trace });
    const prior = {
      [sourceKeyOf(a)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 90_001 },
      [sourceKeyOf(b)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 90_001 },
    };

    await scanForEvent([a, b], { head: 105_000, priorCoverage: prior, ...budget });

    // A deep source must not be able to starve a shallow source's gap forever — otherwise
    // the shallow one's top never reaches head and it can never settle.
    assert.deepEqual(trace.slice(0, 2), [
      ["a", 100_001, 105_000],
      ["b", 100_001, 105_000],
    ]);
  });

  // THE CONTIGUITY RULE. A gap that does not fully close is discarded: recording it would
  // put a hole inside an interval that later reads count as contiguous — a silent way to
  // manufacture a proven false over blocks nobody read.
  test("a gap cut short by the budget does NOT advance the top", async () => {
    const s = source({ floor: 0 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 90_001 } };

    const out = await scanForEvent([s], {
      head: 140_000,
      priorCoverage: prior,
      chunkBlocks: 10_000,
      maxChunks: 2, // the gap is 40k wide; two chunks cannot close it
      verifyFloor: floorOk,
    });

    assert.equal(out.coverage[0].scannedFrom, 100_000, "partial gap work must be discarded");
    assert.equal(out.coverage[0].scannedTo, 90_001, "and the bottom must not move either");
    assert.equal(out.coverage[0].dirty, false, "nothing advanced, so nothing to write");
    assert.equal(out.complete, false);
    assert.equal(out.reason, "budget_exhausted");
  });

  test("a gap broken by a lost chunk does NOT advance the top", async () => {
    const s = source({ floor: 0, fail: (lo) => lo === 100_001 });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 90_001 } };

    const out = await scanForEvent([s], { head: 120_000, priorCoverage: prior, ...budget });

    assert.equal(out.coverage[0].scannedFrom, 100_000);
    assert.equal(out.complete, false);
    assert.equal(out.reason, "chunk_error");
  });

  test("a hit inside the new range is proof and stops the walk", async () => {
    const s = source({ floor: 0, logsAt: { 112_000: true } });
    const prior = { [sourceKeyOf(s)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 60_001 } };

    const out = await scanForEvent([s], { head: 115_000, priorCoverage: prior, ...budget });

    assert.equal(out.found, true);
    assert.equal(out.chunksUsed, 1);
    // Requirement 4: the completion goes to the verdict cache; the cursor is done with.
    assert.deepEqual(out.coverage, [], "a found event writes no coverage");
  });
});

describe("phase B — a lost chunk freezes the frontier", () => {
  // Blocks below a hole are still WORTH READING (a positive there is proof) but must never
  // be RECORDED: they are not contiguous with the interval anchored at head.
  test("coverage stops at the hole even though the walk continues past it", async () => {
    const s = source({ floor: 0, fail: (lo) => lo === 70_001 });

    const out = await scanForEvent([s], {
      head: 100_000,
      chunkBlocks: 10_000,
      maxChunks: 6,
      verifyFloor: floorOk,
    });

    assert.equal(out.coverage[0].scannedTo, 80_001, "the frontier must stop at the hole");
    assert.ok(
      s.queries.some(([lo]) => lo < 70_001),
      "the walk should still read below the hole, where a positive would still be proof",
    );
    assert.equal(out.complete, false);
    assert.equal(out.reason, "chunk_error");
  });

  test("a hole in the very first chunk records no coverage at all", async () => {
    const s = source({ floor: 0, fail: (lo) => lo === 90_001 });

    const out = await scanForEvent([s], {
      head: 100_000,
      chunkBlocks: 10_000,
      maxChunks: 4,
      verifyFloor: floorOk,
    });

    assert.deepEqual(out.coverage, [], "nothing below the hole is contiguous with head");
  });

  test("a hit below a hole is still proof", async () => {
    const s = source({ floor: 0, fail: (lo) => lo === 90_001, logsAt: { 75_000: true } });

    const out = await scanForEvent([s], {
      head: 100_000,
      chunkBlocks: 10_000,
      maxChunks: 6,
      verifyFloor: floorOk,
    });

    assert.equal(out.found, true);
  });
});

describe("multi-source coverage advances independently", () => {
  const budget = { chunkBlocks: 10_000, maxChunks: 4, verifyFloor: floorOk };
  const live = () => source({ floor: 60_000, label: "live", address: "0x11".padEnd(42, "1") });
  const old = () => source({ floor: 0, label: "old", address: "0x22".padEnd(42, "2") });

  // Requirement 5: the routine mid-convergence state is "one factory fully walked, the
  // other barely started". A single interval could not express it; two rows can.
  test("a fully-walked source does not settle the quest while the other is short", async () => {
    const a = live();
    const b = old();

    // 5 chunks take the shallow source to its floor; the remaining 2 barely dent the deep one.
    const out = await scanForEvent([a, b], { head: 100_000, ...budget, maxChunks: 7 });

    const cov = asPrior(out.coverage);
    assert.equal(cov[sourceKeyOf(a)].scannedTo, 60_000, "the shallow source reached its floor");
    assert.ok(cov[sourceKeyOf(b)].scannedTo > 0, "the deep source did not");
    assert.equal(out.complete, false, "one source at its floor is not a proven negative");
    assert.equal(out.reason, "budget_exhausted");
  });

  test("the quest settles only once BOTH sources reach their floors", async () => {
    const a = live();
    const b = old();
    const prior = {
      [sourceKeyOf(a)]: { floorBlock: 60_000, scannedFrom: 100_000, scannedTo: 60_000 },
      [sourceKeyOf(b)]: { floorBlock: 0, scannedFrom: 100_000, scannedTo: 70_001 },
    };

    const partial = await scanForEvent([a, b], { head: 100_000, priorCoverage: prior, ...budget });
    assert.equal(partial.complete, false, "still short on the deep source");

    const finished = await scanForEvent([live(), old()], {
      head: 100_000,
      priorCoverage: asPrior(partial.coverage),
      ...budget,
    });
    assert.equal(finished.complete, true, "both floors reached — now it is a proven negative");
  });

  test("a source with no coverage at all blocks the verdict", async () => {
    const a = live();
    const b = old();
    // b's budget ran out before it started; only a has a row.
    const prior = { [sourceKeyOf(a)]: { floorBlock: 60_000, scannedFrom: 100_000, scannedTo: 60_000 } };

    const out = await scanForEvent([a, b], {
      head: 100_000,
      priorCoverage: prior,
      chunkBlocks: 10_000,
      maxChunks: 0, // no budget at all this poll
      verifyFloor: floorOk,
    });

    assert.equal(out.complete, false, "an entirely unread source cannot be proven empty");
  });
});

// ============================================================================
// THE POINT OF THE WHOLE STEP: polls converge instead of restarting.
// ============================================================================
describe("convergence over repeated polls", () => {
  const budget = { chunkBlocks: 10_000, maxChunks: 3, verifyFloor: floorOk };

  test("a deep-history wallet goes indeterminate → confirmed over N polls", async () => {
    const head = 100_000;
    const floor = 1_000;
    let coverage = {};
    const statuses = [];
    const depths = [];

    for (let poll = 0; poll < 4; poll++) {
      const s = source({ floor });
      const out = await scanForEvent([s], { head, priorCoverage: coverage, ...budget });
      coverage = asPrior(out.coverage);
      statuses.push(out.complete ? "confirmed" : "indeterminate");
      depths.push(coverage[sourceKeyOf(s)].scannedTo);
    }

    assert.deepEqual(statuses, ["indeterminate", "indeterminate", "indeterminate", "confirmed"]);
    // Strictly deeper every poll — the property that makes convergence inevitable rather
    // than lucky. Without a cursor every entry here would be identical.
    assert.deepEqual(depths, [70_001, 40_001, 10_001, 1_000]);
  });

  // Without resume, the SAME work happens forever and the answer never settles. This is the
  // regression that would silently undo the whole step.
  test("without a cursor the same poll repeats forever and never settles", async () => {
    const head = 100_000;
    const statuses = [];

    for (let poll = 0; poll < 4; poll++) {
      const s = source({ floor: 1_000 });
      const out = await scanForEvent([s], { head, ...budget });
      statuses.push(out.complete ? "confirmed" : "indeterminate");
      assert.equal(s.queries[0][1], head, "every unresumed poll restarts at head");
    }

    assert.deepEqual(statuses, ["indeterminate", "indeterminate", "indeterminate", "indeterminate"]);
  });

  // Convergence must survive a moving head: each poll re-anchors the top before descending.
  test("converges even while head keeps moving", async () => {
    let coverage = {};
    let head = 100_000;
    let settled = -1;

    for (let poll = 0; poll < 6; poll++) {
      const s = source({ floor: 1_000 });
      const out = await scanForEvent([s], { head, priorCoverage: coverage, ...budget });
      coverage = asPrior(out.coverage);
      if (out.complete && settled < 0) settled = poll;
      // The top must track head on every poll, or the answer could never be honest as of head.
      assert.equal(coverage[sourceKeyOf(s)].scannedFrom, head);
      head += 5_000;
    }

    assert.ok(settled >= 0, "must settle despite the moving head");
  });

  // The invariant, asserted across the whole convergence run rather than at one point:
  // at no poll before the floor is reached may the scan report a proven negative.
  test("NO poll reports a proven false before coverage reaches the floor", async () => {
    const head = 100_000;
    const floor = 1_000;
    let coverage = {};

    for (let poll = 0; poll < 4; poll++) {
      const s = source({ floor });
      const out = await scanForEvent([s], { head, priorCoverage: coverage, ...budget });
      coverage = asPrior(out.coverage);

      const reachedFloor = coverage[sourceKeyOf(s)].scannedTo === floor;
      assert.equal(
        out.complete,
        reachedFloor,
        `poll ${poll}: complete must be exactly "coverage reached the floor", never more`,
      );
      if (!reachedFloor) {
        assert.equal(out.exhausted, true);
        assert.equal(out.found, false);
      }
    }
  });

  // A wallet that DID act deep in history is found on the way down, not mislabelled.
  test("a deep positive is found by a later poll rather than turning into a false", async () => {
    const head = 100_000;
    let coverage = {};
    const statuses = [];

    for (let poll = 0; poll < 4; poll++) {
      const s = source({ floor: 1_000, logsAt: { 25_000: true } });
      const out = await scanForEvent([s], { head, priorCoverage: coverage, ...budget });
      statuses.push(out.found ? "found" : out.complete ? "confirmed-false" : "indeterminate");
      if (out.found) break;
      coverage = asPrior(out.coverage);
    }

    assert.deepEqual(statuses, ["indeterminate", "indeterminate", "found"]);
    assert.ok(!statuses.includes("confirmed-false"), "must never pass through a false");
  });
});
