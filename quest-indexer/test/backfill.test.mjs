// Job C, and the one question worth asking of it: can `covered_to` ever claim a block whose
// wallets were not recorded?
//
// The read path turns "coverage reached the floor, and no quest_completion row" into a
// confirmed FALSE. So every block inside [covered_to .. covered_from] is an assertion that
// anyone active there has a completion row. A frontier that runs ahead of the completions —
// by one lost chunk, one failed write, one abandoned slice — is a wallet that traded being
// told it never did. That is the only failure this job has, and every test here is a
// rehearsal of it.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { ethers } from "ethers";

import { planBackfill, runBackfill } from "../lib/backfill.mjs";
import { SOURCES } from "../lib/sources.mjs";
import { BACKFILL_CHUNK_BLOCKS, BACKFILL_MIN_CHUNK_BLOCKS } from "../lib/walk.mjs";

const realLog = console.log;
const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.log = realLog;
  console.error = realError;
});

const CHAIN = 4441;
const PM = "0x9396d36f1b7b4bd8dc9c0bd8dc9c0bd8dc9c0bd8";
const WALLET = "0xe9dd9bff0ad5254673daaa77397e84fec2312292";
const FLOOR = 1_000_000;
const HEAD = 1_100_000;

const ENV = {
  QUEST_POSITION_MANAGER_ADDRESS: PM,
  QUEST_LIQUIDITY_POOL_ADDRESS: "0x4716a0c900000000000000000000000000000000",
  QUEST_PREDICTION_FACTORY_ADDRESS: "0x7dd9e01f00000000000000000000000000000000",
  QUEST_PREDICTION_FACTORY_OLD_ADDRESS: "0x6338985c00000000000000000000000000000000",
  QUEST_POSITION_MANAGER_DEPLOY_BLOCK: String(FLOOR),
  QUEST_LIQUIDITY_POOL_DEPLOY_BLOCK: String(FLOOR),
  QUEST_PREDICTION_FACTORY_DEPLOY_BLOCK: String(FLOOR),
  QUEST_PREDICTION_FACTORY_OLD_DEPLOY_BLOCK: String(FLOOR),
};

const positionManager = SOURCES[0];

/** A PositionOpened log for `wallet` — `owner` is topic 1. */
function log(blockNumber, wallet = WALLET) {
  return {
    blockNumber,
    topics: [
      "0x" + "aa".repeat(32),
      ethers.utils.hexZeroPad(ethers.utils.getAddress(wallet), 32),
      "0x" + "bb".repeat(32),
    ],
  };
}

/**
 * A getLogs that RESPECTS THE REQUESTED RANGE, as a real node does.
 *
 * Worth the four lines: a fixture that returns the same log for every chunk makes a
 * multi-chunk sweep look like it found the same wallet repeatedly, which quietly turns an
 * assertion about deduplication into an assertion about chunk count.
 */
const logsIn =
  (...items) =>
  async (filter) =>
    items.filter((l) => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);

/** Recording writer. `fail` names a method that should throw. */
function fakeWriter({ coverage = new Map(), fail = null } = {}) {
  const completions = [];
  const extends_ = [];
  const starts = [];
  const order = [];
  return {
    completions,
    extends: extends_,
    starts,
    order,
    async loadBackfill() {
      if (fail === "loadBackfill") throw new Error("loadBackfill boom");
      return coverage;
    },
    async startBackfill(row) {
      starts.push(row);
    },
    async writeCompletions(rows) {
      if (fail === "writeCompletions") throw new Error("writeCompletions boom");
      order.push(`completions:${rows.length}`);
      completions.push(...rows);
      return rows.length;
    },
    async extendBackfillDown(row) {
      if (fail === "extendBackfillDown") throw new Error("extendBackfillDown boom");
      order.push(`frontier:${row.coveredTo}`);
      extends_.push(row);
      return "extended";
    },
  };
}

function run(over = {}) {
  console.log = () => {};
  return runBackfill({
    writer: over.writer ?? fakeWriter(),
    sources: over.sources ?? [positionManager],
    chainId: CHAIN,
    head: HEAD,
    budgetMs: 60_000,
    getLogs: over.getLogs ?? (async () => []),
    env: ENV,
    chunkBlocks: 25_000,
    log: () => {},
    ...over,
  });
}

// ============================================================================
// THE PLANNER — three states, and the one that discards work on purpose.
// ============================================================================
describe("planBackfill", () => {
  const plan = (coverage, sources = [positionManager]) =>
    planBackfill({ sources, coverage, head: HEAD, env: ENV });

  test("with no row, anchors a fresh pass at the CURRENT head", () => {
    const [item] = plan(new Map());

    assert.equal(item.state, "fresh");
    assert.equal(item.from, HEAD, "the ceiling is the handoff point the read path checks");
    assert.equal(item.remaining, HEAD - FLOOR);
  });

  test("with partial coverage, resumes one block below it", () => {
    const [item] = plan(new Map([[PM, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: 1_050_000 }]]));

    assert.equal(item.state, "resume");
    assert.equal(item.from, 1_049_999, "coverage starts AT covered_to, so the first unswept block is below it");
    assert.equal(item.remaining, 50_000);
  });

  // Equality, not <=. The table CHECK makes lower impossible, so "reached the floor" is
  // exactly equality — the same rule coverageProvesAbsence() applies to quest_cursor.
  test("coverage at the floor is complete", () => {
    const [item] = plan(new Map([[PM, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: FLOOR }]]));

    assert.equal(item.state, "complete");
    assert.equal(item.remaining, 0);
  });

  // A floor moved DOWN means unswept history below what we covered; moved UP means the pass
  // may have been reading a different contract. Either way the coverage is void — discarding
  // it costs hours and can never cost a wrong answer.
  test("a changed floor voids the coverage and restarts the pass", () => {
    const [item] = plan(new Map([[PM, { floorBlock: FLOOR - 500, coveredFrom: HEAD, coveredTo: FLOOR - 500 }]]));

    assert.equal(item.state, "floor_changed", "a completed pass against the wrong floor is not a completed pass");
    assert.equal(item.from, HEAD);
  });

  // Same reasoning as the settler: the work is finite and terminating, so finishing the
  // nearly-done first settles whole quests sooner rather than settling everybody at once at
  // the very end.
  test("orders least-remaining-first", () => {
    const coverage = new Map([
      [PM, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: 1_090_000 }],
      [ENV.QUEST_LIQUIDITY_POOL_ADDRESS, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: 1_010_000 }],
    ]);

    const ordered = plan(coverage, [SOURCES[0], SOURCES[1]]);

    assert.deepEqual(
      ordered.map((p) => p.remaining),
      [10_000, 90_000],
    );
  });
});

// ============================================================================
// THE WRITE ORDER. Completions, then the frontier that claims them.
// ============================================================================
describe("write ordering", () => {
  test("records completions BEFORE the frontier, every chunk", async () => {
    const writer = fakeWriter();
    await run({
      writer,
      head: FLOOR + 50_000,
      getLogs: async () => [log(FLOOR + 40_000)],
    });

    assert.deepEqual(
      writer.order,
      ["completions:1", "frontier:1025001", "completions:1", "frontier:1000001", "completions:1", "frontier:1000000"],
      "each chunk commits its wallets before claiming to have covered them",
    );
  });

  test("a failed completion write does NOT advance the frontier", async () => {
    const writer = fakeWriter({ fail: "writeCompletions" });

    const out = await run({ writer, head: FLOOR + 25_000, getLogs: async () => [log(FLOOR + 20_000)] });

    assert.deepEqual(writer.extends, [], "never claim coverage of wallets that were not recorded");
    assert.equal(out.complete, false);
    assert.equal(out.reason, "chunk_error");
  });

  test("a failed frontier write stops the sweep rather than skipping the block", async () => {
    const writer = fakeWriter({ fail: "extendBackfillDown" });

    const out = await run({ writer, head: FLOOR + 50_000 });

    assert.equal(out.complete, false);
    assert.equal(out.reason, "chunk_error");
    assert.equal(out.chunks, 0, "a chunk that could not be recorded is not a chunk of progress");
  });

  // The frontier is the bottom of an unbroken run. A chunk lost below a successful one must
  // not be silently included by the chunks above it continuing.
  test("a lost chunk freezes the frontier where it was", async () => {
    const writer = fakeWriter();
    let call = 0;
    const out = await run({
      writer,
      head: FLOOR + 75_000,
      chunkBlocks: 25_000,
      getLogs: async () => {
        // The first chunk lands; the second fails at every halving.
        if (++call === 1) return [];
        throw new Error("rpc timeout");
      },
    });

    assert.equal(out.reason, "chunk_error");
    assert.deepEqual(
      writer.extends.map((e) => e.coveredTo),
      [1_050_001],
      "only the one chunk that succeeded is recorded",
    );
  });
});

describe("completions", () => {
  // A head exactly one chunk above the floor, so these assertions are about ONE getLogs
  // call and cannot be confused by a second chunk re-reporting the same wallet.
  const ONE_CHUNK = FLOOR + 24_999;

  test("a PositionOpened proves first_trade for that address", async () => {
    const writer = fakeWriter();
    await run({ writer, head: ONE_CHUNK, getLogs: logsIn(log(FLOOR + 20_000)) });

    assert.deepEqual(writer.completions, [
      { chainId: CHAIN, wallet: WALLET, quest: "first_trade", checkedThroughBlock: FLOOR + 20_000, source: "backfill" },
    ]);
  });

  test("deduped per (wallet, quest) within a chunk", async () => {
    const writer = fakeWriter();
    await run({
      writer,
      head: ONE_CHUNK,
      getLogs: logsIn(log(FLOOR + 20_000), log(FLOOR + 20_001), log(FLOOR + 20_002)),
    });

    assert.equal(writer.completions.length, 1, "a busy trader is one row, not three");
  });

  test("distinct wallets each get a row", async () => {
    const writer = fakeWriter();
    const other = "0x1111111111111111111111111111111111111111";
    await run({
      writer,
      head: ONE_CHUNK,
      getLogs: logsIn(log(FLOOR + 20_000), log(FLOOR + 20_001, other)),
    });

    assert.deepEqual(writer.completions.map((c) => c.wallet).sort(), [other, WALLET].sort());
  });

  // A log we cannot resolve to a wallet is a hole. Skipping it while the frontier advanced
  // would bury that trader under coverage claiming to have read their block.
  test("an unextractable wallet stops the sweep rather than being skipped", async () => {
    const writer = fakeWriter();

    const out = await run({
      writer,
      head: FLOOR + 25_000,
      getLogs: async () => [{ blockNumber: FLOOR + 20_000, topics: ["0xaa"] }],
    });

    assert.equal(out.reason, "chunk_error");
    assert.deepEqual(writer.extends, [], "nothing recorded, nothing claimed");
  });

  test("an empty chunk writes no completions but still advances coverage", async () => {
    const writer = fakeWriter();
    await run({ writer, head: ONE_CHUNK, getLogs: async () => [] });

    assert.deepEqual(writer.completions, []);
    assert.equal(writer.extends.length, 1, "a range read and found empty is genuinely covered");
  });
});

// ============================================================================
// COMPLETION — the flag the read path's whole derivation hangs on.
// ============================================================================
describe("the complete flag", () => {
  test("true only when the sweep actually reaches the floor", async () => {
    const out = await run({ writer: fakeWriter(), head: FLOOR + 25_000 });

    assert.equal(out.complete, true);
    assert.equal(out.reason, "complete");
  });

  test("false when the budget ran out mid-descent", async () => {
    let t = 0;
    const out = await run({
      writer: fakeWriter(),
      head: FLOOR + 500_000,
      budgetMs: 25,
      now: () => (t += 10),
    });

    assert.equal(out.complete, false);
    assert.equal(out.reason, "budget");
  });

  // The expensive-but-correct case: three sources at their floors and one still descending
  // must NOT report complete, or the read path would derive a negative for a quest whose
  // fourth source was never swept.
  test("false when any single source is short, even if the others are done", async () => {
    const coverage = new Map(
      SOURCES.map((s) => [
        ENV[s.addressVar].toLowerCase(),
        { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: FLOOR },
      ]),
    );
    coverage.set(ENV.QUEST_PREDICTION_FACTORY_OLD_ADDRESS.toLowerCase(), {
      floorBlock: FLOOR,
      coveredFrom: HEAD,
      coveredTo: FLOOR + 500_000,
    });

    let t = 0;
    const out = await run({
      writer: fakeWriter({ coverage }),
      sources: SOURCES,
      budgetMs: 25,
      now: () => (t += 10),
    });

    assert.equal(out.complete, false, "one unswept source makes the whole answer unprovable");
  });

  test("already-complete coverage short-circuits without sweeping", async () => {
    const coverage = new Map([[PM, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: FLOOR }]]);
    const writer = fakeWriter({ coverage });

    const out = await run({
      writer,
      getLogs: async () => {
        throw new Error("must not be called");
      },
    });

    assert.equal(out.complete, true);
    assert.equal(out.reason, "already_complete");
    assert.equal(out.chunks, 0);
  });
});

describe("opening a pass", () => {
  test("fixes the ceiling before the first chunk, so a crash resumes rather than re-anchors", async () => {
    const writer = fakeWriter();
    await run({ writer, head: FLOOR + 25_000 });

    assert.deepEqual(writer.starts, [
      { chainId: CHAIN, sourceKey: PM, floorBlock: FLOOR, coveredFrom: FLOOR + 25_000 },
    ]);
  });

  // Re-anchoring a resumable row would reset covered_from to a NEW head and silently discard
  // everything already swept.
  test("does not re-open a pass that is resuming", async () => {
    const coverage = new Map([[PM, { floorBlock: FLOOR, coveredFrom: HEAD, coveredTo: FLOOR + 25_000 }]]);
    const writer = fakeWriter({ coverage });

    await run({ writer });

    assert.deepEqual(writer.starts, [], "the ceiling is set once and never moved");
  });

  test("re-opens a pass whose floor changed, discarding the void coverage", async () => {
    const coverage = new Map([[PM, { floorBlock: FLOOR - 500, coveredFrom: HEAD, coveredTo: FLOOR - 500 }]]);
    const writer = fakeWriter({ coverage });

    await run({ writer, head: FLOOR + 25_000 });

    assert.equal(writer.starts.length, 1);
    assert.equal(writer.starts[0].floorBlock, FLOOR, "re-anchored against the configured floor");
  });
});

// ============================================================================
// THE ADAPTIVE HALVING — an anti-stall, and it must not become a hole.
// ============================================================================
describe("adaptive chunk halving", () => {
  test("halves and retries the SAME range rather than skipping it", async () => {
    const spans = [];
    const writer = fakeWriter();

    await run({
      writer,
      head: FLOOR + 25_000,
      chunkBlocks: 25_000,
      getLogs: async (filter) => {
        spans.push(filter.toBlock - filter.fromBlock + 1);
        // Fail once at full span, succeed at half.
        if (spans.length === 1) throw new Error("timeout");
        return [];
      },
    });

    assert.equal(spans[0], 25_000);
    assert.equal(spans[1], 12_500, "same hi, smaller span");
    assert.equal(writer.extends[0].coveredTo, FLOOR + 12_501, "the retry covers the top half only");
  });

  // Restoring the span after a success would oscillate — fail, halve, succeed, restore,
  // fail — paying a wasted request each cycle. A slice is one tick; the next starts fresh.
  test("does not restore the span within a slice", async () => {
    const spans = [];
    await run({
      writer: fakeWriter(),
      head: FLOOR + 50_000,
      chunkBlocks: 25_000,
      getLogs: async (filter) => {
        spans.push(filter.toBlock - filter.fromBlock + 1);
        if (spans.length === 1) throw new Error("timeout");
        return [];
      },
    });

    assert.ok(
      spans.slice(1).every((s) => s <= 12_500),
      `expected no recovery to 25k, got ${spans.join(",")}`,
    );
  });

  // Below the minimum, a chunk that still fails is a problem shrinking cannot fix, and
  // pretending otherwise turns a visible failure into an invisible crawl.
  test("gives up at the minimum span rather than shrinking forever", async () => {
    const spans = [];
    const out = await run({
      writer: fakeWriter(),
      head: FLOOR + 25_000,
      chunkBlocks: 25_000,
      getLogs: async (filter) => {
        spans.push(filter.toBlock - filter.fromBlock + 1);
        throw new Error("timeout");
      },
    });

    assert.equal(out.reason, "chunk_error");
    assert.equal(spans.at(-1), BACKFILL_MIN_CHUNK_BLOCKS);
    assert.ok(spans.length < 20, `halving must terminate, took ${spans.length} attempts`);
  });
});

describe("the measured defaults", () => {
  // 25k is the throughput optimum measured on this RPC on 2026-07-27 (10k: 5.6s, 25k: 9.9s,
  // 50k: 29.8s with 2/5 timing out against a ~30s server-side request timeout). It is
  // deliberately NOT the read path's 10k — see the note in walk.mjs.
  test("the chunk size is the measured optimum, not the read path's", async () => {
    const { CHUNK_BLOCKS } = await import("../lib/walk.mjs");

    assert.equal(BACKFILL_CHUNK_BLOCKS, 25_000);
    assert.equal(BACKFILL_MIN_CHUNK_BLOCKS, 2_500);
    assert.notEqual(
      BACKFILL_CHUNK_BLOCKS,
      CHUNK_BLOCKS,
      "these are free to differ: the backfill writes quest_backfill, which nothing else writes",
    );
  });

  test("a misconfigured address kills the slice before anything is written", async () => {
    const writer = fakeWriter();
    await assert.rejects(
      () => run({ writer, env: { ...ENV, QUEST_POSITION_MANAGER_ADDRESS: "" } }),
      /not set/,
    );
    assert.deepEqual(writer.extends, []);
    assert.deepEqual(writer.completions, []);
  });
});
