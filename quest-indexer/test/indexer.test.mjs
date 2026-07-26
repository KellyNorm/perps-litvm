// Job A, and specifically the four ways it could advance a watermark it has not earned.
//
// The watermark is a claim: "every block at or below this has been read, and every wallet
// active in it has a row". The read path turns that claim into `completed: false` for any
// wallet without a row. So every test here is really the same test — does the watermark
// ever move past work that did not happen?

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { DEFAULT_CONFIRMATIONS, DEFAULT_MAX_RANGE_BLOCKS, rangeFor, runIndexer } from "../lib/indexer.mjs";
import { SOURCES } from "../lib/sources.mjs";
import { ethers } from "ethers";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const CHAIN = 4441;
const PM = "0x9396d36f1b7b4bd8dc9c0bd8dc9c0bd8dc9c0bd8";
const WALLET = "0xe9dd9bff0ad5254673daaa77397e84fec2312292";
const MIDNIGHT = Math.floor(Date.UTC(2026, 6, 26) / 1000);

const ENV = {
  QUEST_POSITION_MANAGER_ADDRESS: PM,
  QUEST_LIQUIDITY_POOL_ADDRESS: "0x4716a0c900000000000000000000000000000000",
  QUEST_PREDICTION_FACTORY_ADDRESS: "0x7dd9e01f00000000000000000000000000000000",
  QUEST_PREDICTION_FACTORY_OLD_ADDRESS: "0x6338985c00000000000000000000000000000000",
};

const positionManager = SOURCES[0];

/** A PositionOpened log for `wallet`, with `owner` in topic 1. */
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

/** Recording writer. `fail` names a method that should throw. */
function fakeWriter({ state = new Map(), fail = null } = {}) {
  const daily = [];
  const advances = [];
  return {
    daily,
    advances,
    async loadState() {
      if (fail === "loadState") throw new Error("loadState boom");
      return state;
    },
    async writeDaily(rows) {
      if (fail === "writeDaily") throw new Error("writeDaily boom");
      daily.push(...rows);
      return rows.length;
    },
    async advance(chainId, sourceKey, lastBlock) {
      if (fail === "advance") throw new Error("advance boom");
      advances.push({ sourceKey, lastBlock });
      return "advanced";
    },
  };
}

const getBlockAt = (base = MIDNIGHT) => async (n) => ({ timestamp: base + n });

/** Run against a single source, so assertions are about one watermark. */
function run(over = {}) {
  return runIndexer({
    writer: over.writer ?? fakeWriter(),
    sources: [positionManager],
    chainId: CHAIN,
    head: 1_000_000,
    getLogs: over.getLogs ?? (async () => []),
    getBlock: over.getBlock ?? getBlockAt(),
    env: ENV,
    conf: 20,
    maxRange: 5_000,
    ...over,
  });
}

describe("rangeFor", () => {
  test("trails head by the confirmation margin", () => {
    assert.deepEqual(rangeFor({ lastBlock: 900, head: 1_000, confirmations: 20, maxRange: 5_000 }), {
      from: 881,
      to: 980,
    });
  });

  // Re-reading a few blocks is free and idempotent; a gap is invisible and permanent. The
  // overlap also re-reads exactly the blocks most likely to have been reorged.
  test("resumes with an overlap, not from lastBlock + 1", () => {
    const r = rangeFor({ lastBlock: 900, head: 1_000, confirmations: 20, maxRange: 5_000 });
    assert.equal(r.from, 881, "must re-read the confirmation window, never skip past it");
  });

  // A backfill from the deploy block is ~10M blocks to answer a question about today. The
  // cost of starting at head is that the first day is not fully covered — which is exactly
  // why daily_active must not go live until the index has run a full day.
  test("with no watermark, starts at the safe head rather than backfilling", () => {
    assert.deepEqual(rangeFor({ lastBlock: null, head: 1_000, confirmations: 20, maxRange: 5_000 }), {
      from: 980,
      to: 980,
    });
  });

  test("caps the range so a long outage cannot produce an unfinishable run", () => {
    const r = rangeFor({ lastBlock: 0, head: 1_000_000, confirmations: 20, maxRange: 5_000 });
    assert.equal(r.to - r.from + 1, 5_000);
  });

  test("returns null when there is nothing new above the watermark", () => {
    assert.equal(rangeFor({ lastBlock: 990, head: 1_000, confirmations: 20, maxRange: 5_000 }), null);
    assert.equal(rangeFor({ lastBlock: 5_000, head: 1_000, confirmations: 20, maxRange: 5_000 }), null);
  });

  test("returns null when the chain is younger than the confirmation margin", () => {
    assert.equal(rangeFor({ lastBlock: null, head: 5, confirmations: 20, maxRange: 5_000 }), null);
  });

  test("the defaults are the documented ones", () => {
    assert.equal(DEFAULT_CONFIRMATIONS, 20);
    assert.equal(DEFAULT_MAX_RANGE_BLOCKS, 5_000);
  });
});

// ============================================================================
// THE ORDER. Rows first, watermark only on success.
// ============================================================================
describe("write ordering", () => {
  test("writes rows BEFORE advancing the watermark", async () => {
    const order = [];
    const writer = {
      async loadState() { return new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]); },
      async writeDaily(rows) { order.push(`rows:${rows.length}`); },
      async advance() { order.push("watermark"); },
    };

    await run({ writer, getLogs: async () => [log(900_100)] });

    assert.deepEqual(order, ["rows:1", "watermark"], "the reverse order is the wrong-false window");
  });

  // The one that matters most: if the rows did not land, the watermark must not claim they
  // did. Otherwise a verify sees a current index with no row and answers a confident false.
  test("a failed row write leaves the watermark UNTOUCHED", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]), fail: "writeDaily" });

    const out = await run({ writer, getLogs: async () => [log(900_100)] });

    assert.deepEqual(writer.advances, [], "never advance over rows that did not land");
    assert.equal(out.failed, 1);
    assert.match(out.sources[0].error, /writeDaily boom/);
  });

  test("an unresolvable day leaves the watermark untouched", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    const out = await run({
      writer,
      getLogs: async () => [log(900_100)],
      getBlock: async () => null, // pruned node
    });

    assert.deepEqual(writer.advances, []);
    assert.equal(out.failed, 1);
  });

  // A wrong walletTopic, a malformed topic, a truncated log — any of them means we cannot
  // say who was active. Skipping the log while advancing would bury that block forever.
  test("an unextractable wallet leaves the watermark untouched", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    const out = await run({
      writer,
      getLogs: async () => [{ blockNumber: 900_100, topics: ["0xaa"] }],
    });

    assert.deepEqual(writer.advances, []);
    assert.equal(out.failed, 1);
    assert.match(out.sources[0].error, /no usable topic/);
  });

  test("a getLogs failure leaves the watermark untouched", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    const out = await run({
      writer,
      getLogs: async () => {
        throw new Error("rpc down");
      },
    });

    assert.deepEqual(writer.advances, []);
    assert.equal(out.failed, 1);
  });

  test("an empty range still advances — no activity is a real, indexable fact", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    await run({ writer, getLogs: async () => [] });

    assert.equal(writer.daily.length, 0);
    assert.equal(writer.advances.length, 1, "an empty range is indexed, not skipped");
  });
});

describe("the idle case", () => {
  // A healthy indexer on a quiet chain must not age past the wall-clock freshness threshold
  // and read as dead. `advance` guards on last_block=lte, so re-writing the same value
  // refreshes updated_at without moving anything.
  test("with nothing new, re-touches the watermark to refresh updated_at", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 999_990, updatedAt: "" }]]) });

    const out = await run({ writer, head: 1_000_000 });

    assert.deepEqual(writer.advances, [{ sourceKey: PM, lastBlock: 999_990 }], "same value, fresh timestamp");
    assert.equal(out.sources[0].idle, true);
  });

  test("a source that has never been indexed is not touched when the chain is too young", async () => {
    const writer = fakeWriter();
    await run({ writer, head: 5 });
    assert.deepEqual(writer.advances, [], "nothing to claim yet");
  });
});

describe("rows", () => {
  test("one row per (wallet, day), deduped across many logs", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    await run({ writer, getLogs: async () => [log(900_100), log(900_101), log(900_102)] });

    assert.equal(writer.daily.length, 1, "a busy trader is one row, not three");
    assert.equal(writer.daily[0].wallet, WALLET);
    assert.equal(writer.daily[0].firstSeenBlock, 900_100, "the FIRST sighting, stable across replays");
  });

  test("distinct wallets get distinct rows", async () => {
    const other = "0x1111111111111111111111111111111111111111";
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    await run({ writer, getLogs: async () => [log(900_100), log(900_101, other)] });

    assert.deepEqual(writer.daily.map((r) => r.wallet).sort(), [other, WALLET].sort());
  });

  test("wallets are lower-cased, or the table CHECK would reject the whole batch", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });
    await run({ writer, getLogs: async () => [log(900_100, "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292")] });

    assert.equal(writer.daily[0].wallet, WALLET);
  });

  // A catch-up run replaying a backlog must stamp each log with ITS block's day, not with
  // the day the indexer happened to be running.
  test("the day comes from the block, not from the clock", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });

    // One block per hour, starting at midnight on the 26th: block 900_081 is ~2 days later.
    await run({
      writer,
      getLogs: async () => [log(900_081)],
      getBlock: async (n) => ({ timestamp: MIDNIGHT + (n - 900_000) * 3600 }),
      maxRange: 5_000,
    });

    assert.equal(writer.daily[0].day, "2026-07-29", "dated from block 900081's own timestamp");
    assert.match(writer.daily[0].day, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("records which event produced the sighting, for debugging only", async () => {
    const writer = fakeWriter({ state: new Map([[PM, { lastBlock: 900_000, updatedAt: "" }]]) });
    await run({ writer, getLogs: async () => [log(900_100)] });
    assert.equal(writer.daily[0].firstSeenVia, "PositionOpened");
  });
});

describe("per-source independence", () => {
  const allFour = (over = {}) =>
    runIndexer({
      writer: over.writer,
      sources: SOURCES,
      chainId: CHAIN,
      head: 1_000_000,
      getLogs: over.getLogs ?? (async () => []),
      getBlock: getBlockAt(),
      env: ENV,
      conf: 20,
      maxRange: 5_000,
      ...over,
    });

  // One broken source degrades daily_active to indeterminate via the freshness gate, which
  // is correct. Also freezing the healthy sources would be needless.
  test("a failure on one source does not stop the others", async () => {
    const writer = fakeWriter();
    let call = 0;
    const out = await allFour({
      writer,
      getLogs: async () => {
        if (++call === 1) throw new Error("first source down");
        return [];
      },
    });

    assert.equal(out.failed, 1);
    assert.equal(writer.advances.length, 3, "the other three still advanced");
  });

  test("each source advances its own watermark, keyed by address", async () => {
    const writer = fakeWriter();
    await allFour({ writer });

    assert.deepEqual(
      writer.advances.map((a) => a.sourceKey).sort(),
      Object.values(ENV).map((a) => a.toLowerCase()).sort(),
    );
  });

  // Addresses resolve before any state is read, so a bad env var cannot half-index.
  test("a misconfigured address kills the run before anything is written", async () => {
    const writer = fakeWriter();
    await assert.rejects(() => allFour({ writer, env: { ...ENV, QUEST_LIQUIDITY_POOL_ADDRESS: "" } }), /not set/);
    assert.deepEqual(writer.advances, []);
    assert.deepEqual(writer.daily, []);
  });
});

describe("the deadline", () => {
  // Not an error: unstarted sources keep their watermarks and catch up next run, and their
  // staleness is what makes the endpoint answer indeterminate meanwhile.
  test("stops starting new sources past the deadline, without failing", async () => {
    const writer = fakeWriter();
    let t = 0;
    const out = await runIndexer({
      writer,
      sources: SOURCES,
      chainId: CHAIN,
      head: 1_000_000,
      getLogs: async () => [],
      getBlock: getBlockAt(),
      env: ENV,
      conf: 20,
      maxRange: 5_000,
      now: () => (t += 10),
      deadline: 25,
    });

    assert.equal(out.failed, 0, "running out of time is not a failure");
    assert.ok(out.sources.some((s) => s.skipped === "deadline"));
    assert.ok(writer.advances.length < SOURCES.length);
  });
});

describe("shared work across sources", () => {
  test("the four sources share one block-day resolver", async () => {
    const writer = fakeWriter();
    const seen = [];
    await runIndexer({
      writer,
      sources: SOURCES,
      chainId: CHAIN,
      head: 1_000_000,
      // Every source finds a log in the same block, so a per-source resolver would date it
      // four times.
      getLogs: async () => [log(999_975)],
      getBlock: async (n) => {
        seen.push(n);
        return { timestamp: MIDNIGHT + n };
      },
      env: ENV,
      conf: 20,
      maxRange: 5_000,
    });

    assert.equal(seen.length, new Set(seen).size, "no block should be dated twice in one run");
  });
});
