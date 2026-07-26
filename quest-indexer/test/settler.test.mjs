// The settler: what it works on, and — the part that matters — what it is capable of
// writing.
//
// Two properties are asserted over and over, from different angles, because they are the
// entire safety argument for a background job that touches the same rows the read path
// derives verdicts from:
//
//   1. IT CAN NEVER WRITE A FALSE. Coverage and positive completions only. There is no
//      code path, and no column, that could express "this wallet did not do it".
//   2. IT NEVER TOUCHES scanned_from. The top of the interval is the read path's to move,
//      and advancing it over an unclosed gap is one of the two ways to punch a hole.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { CANDIDATE_PAGE, SETTLEABLE_QUESTS, planWork, runSettler } from "../lib/settler.mjs";
import { DEFAULT_DEPLOY_BLOCKS } from "../lib/sources.mjs";

const realLog = console.log;
const realError = console.error;
before(() => {
  console.log = () => {};
  console.error = () => {};
});
after(() => {
  console.log = realLog;
  console.error = realError;
});

const CHAIN = 4441;
const WALLET = "0xe9dd9bff0ad5254673daaa77397e84fec2312292";
const PM = "0x00000000000000000000000000000000000000aa";
const LP = "0x00000000000000000000000000000000000000bb";
const F8 = "0x00000000000000000000000000000000000000cc";
const F24 = "0x00000000000000000000000000000000000000dd";

const ENV = {
  QUEST_POSITION_MANAGER_ADDRESS: PM,
  QUEST_LIQUIDITY_POOL_ADDRESS: LP,
  QUEST_PREDICTION_FACTORY_ADDRESS: F8,
  QUEST_PREDICTION_FACTORY_OLD_ADDRESS: F24,
};

const PM_FLOOR = DEFAULT_DEPLOY_BLOCKS.QUEST_POSITION_MANAGER_DEPLOY_BLOCK;
const F8_FLOOR = DEFAULT_DEPLOY_BLOCKS.QUEST_PREDICTION_FACTORY_DEPLOY_BLOCK;
const F24_FLOOR = DEFAULT_DEPLOY_BLOCKS.QUEST_PREDICTION_FACTORY_OLD_DEPLOY_BLOCK;

/** A quest_cursor row as pickCursorCandidates returns it. */
const row = (over = {}) => ({
  wallet: WALLET,
  quest: "first_trade",
  sourceKey: PM,
  floorBlock: PM_FLOOR,
  scannedFrom: 33_400_000,
  scannedTo: 33_000_000,
  updatedAt: "2026-07-26T00:00:00Z",
  ...over,
});

/** Recording writer. Everything it is asked to do is captured for assertion. */
function fakeWriter({ rows = [], completed = new Set() } = {}) {
  const extends_ = [];
  const completions = [];
  return {
    extends_,
    completions,
    async pickCursorCandidates() {
      return rows;
    },
    async hasCompletion(_c, wallet, quest) {
      return completed.has(`${wallet}:${quest}`);
    },
    async extendCursorDown(args) {
      extends_.push(args);
      return "extended";
    },
    async writeCompletion(args) {
      completions.push(args);
    },
  };
}

const noLogs = async () => [];
const settle = (over = {}) =>
  runSettler({
    writer: over.writer,
    chainId: CHAIN,
    budgetMs: over.budgetMs ?? 60_000,
    getLogs: over.getLogs ?? noLogs,
    env: ENV,
    now: over.now ?? (() => 0),
    log: () => {},
    page: over.page ?? CANDIDATE_PAGE,
  });

// ============================================================================
// PROPERTY 1 — IT CANNOT WRITE A FALSE
// ============================================================================
describe("it can never write a false", () => {
  test("a walk that finds nothing writes COVERAGE, never a completion", async () => {
    const writer = fakeWriter({ rows: [row({ scannedTo: PM_FLOOR + 20_000 })] });

    await settle({ writer });

    assert.equal(writer.completions.length, 0, "no completion row for a negative — ever");
    assert.equal(writer.extends_.length, 1, "only coverage");
  });

  test("a walk all the way to the floor STILL writes no completion", async () => {
    // This is the case a careless implementation would call "proven not completed".
    const writer = fakeWriter({ rows: [row({ scannedTo: PM_FLOOR + 5_000 })] });

    await settle({ writer });

    assert.equal(writer.extends_[0].scannedTo, PM_FLOOR, "coverage reaches the floor");
    assert.equal(writer.completions.length, 0, "reaching the floor is COVERAGE, not a verdict");
  });

  // The derivation lives in coverageProvesAbsence() on the read path. Nothing here computes
  // it, and nothing here has anywhere to put it if it did.
  test("what it writes carries no verdict-shaped field", async () => {
    const writer = fakeWriter({ rows: [row()] });

    await settle({ writer });

    assert.deepEqual(Object.keys(writer.extends_[0]).sort(), ["chainId", "quest", "scannedTo", "sourceKey", "wallet"]);
  });

  test("a completion is written ONLY on an actual hit", async () => {
    const writer = fakeWriter({ rows: [row()] });

    await settle({ writer, getLogs: async () => [{ blockNumber: 32_995_000 }] });

    assert.equal(writer.completions.length, 1);
    assert.equal(writer.completions[0].wallet, WALLET);
    assert.equal(writer.completions[0].quest, "first_trade");
  });

  // Once proven, the partial coverage walked on the way is dead weight — nothing will read
  // that row again.
  test("a hit writes the completion and NO coverage", async () => {
    const writer = fakeWriter({ rows: [row()] });

    await settle({ writer, getLogs: async () => [{ blockNumber: 32_995_000 }] });

    assert.equal(writer.completions.length, 1);
    assert.equal(writer.extends_.length, 0);
  });
});

// ============================================================================
// PROPERTY 2 — IT NEVER TOUCHES scanned_from
// ============================================================================
describe("it never touches scanned_from", () => {
  test("no write it makes carries scanned_from", async () => {
    const writer = fakeWriter({ rows: [row(), row({ quest: "first_prediction", sourceKey: F8, floorBlock: F8_FLOOR })] });

    await settle({ writer });

    for (const call of writer.extends_) {
      assert.ok(!("scannedFrom" in call), "the top of the interval is the read path's to move");
      assert.ok(!("scanned_from" in call));
    }
  });

  test("coverage only ever moves DOWN", async () => {
    const writer = fakeWriter({ rows: [row({ scannedTo: 33_000_000 })] });

    await settle({ writer });

    assert.ok(writer.extends_[0].scannedTo < 33_000_000, "downward, always");
    assert.ok(writer.extends_[0].scannedTo >= PM_FLOOR, "and never below the floor");
  });

  test("a walk with no progress writes nothing at all", async () => {
    const writer = fakeWriter({ rows: [row()] });

    // Budget gone before the first chunk can land.
    await settle({ writer, budgetMs: 0 });

    assert.equal(writer.extends_.length, 0, "no progress means no write, not a no-op write");
  });
});

// ============================================================================
// WHAT IT PICKS UP
// ============================================================================
describe("planWork", () => {
  test("groups by (wallet, quest), not by source", () => {
    const work = planWork(
      [
        row({ quest: "first_prediction", sourceKey: F8, floorBlock: F8_FLOOR, scannedTo: F8_FLOOR + 100 }),
        row({ quest: "first_prediction", sourceKey: F24, floorBlock: F24_FLOOR, scannedTo: F24_FLOOR + 100 }),
      ],
      { env: ENV },
    );

    assert.equal(work.length, 1, "first_prediction is one unit of work with two sources");
    assert.equal(work[0].sources.length, 2);
  });

  // FLOOR COUPLING. A row computed against a different floor is void — the read path
  // discards it via isUsablePrior, so walking it would be pure waste.
  test("drops rows whose floor no longer matches the configured one", () => {
    const work = planWork([row({ floorBlock: PM_FLOOR - 1_000 })], { env: ENV });
    assert.deepEqual(work, []);
  });

  test("drops rows already at their floor", () => {
    assert.deepEqual(planWork([row({ scannedTo: PM_FLOOR })], { env: ENV }), []);
  });

  // Orphaned rows for retired addresses are harmless and ignored, exactly as the migration
  // says — but they must not be mistaken for work.
  test("drops rows for addresses we no longer configure", () => {
    const work = planWork([row({ sourceKey: "0x00000000000000000000000000000000000000ff" })], { env: ENV });
    assert.deepEqual(work, []);
  });

  test("drops quests that are not settleable", () => {
    // daily_active writes no cursor rows at all, but a stray one must not be worked.
    assert.deepEqual(planWork([row({ quest: "daily_active" })], { env: ENV }), []);
    assert.deepEqual(planWork([row({ quest: "made_up" })], { env: ENV }), []);
  });

  test("a source paired with the wrong quest is not worked", () => {
    // A prediction-factory row filed under first_trade is not something first_trade scans.
    assert.deepEqual(planWork([row({ quest: "first_trade", sourceKey: F8, floorBlock: F8_FLOOR })], { env: ENV }), []);
  });

  // LEAST REMAINING FIRST: the work is bounded and terminating, so round-robin settles
  // nobody for a long time and then everybody at once.
  test("orders by remaining work, shallowest first", () => {
    const deep = row({ wallet: "0x1111111111111111111111111111111111111111", scannedTo: 33_000_000 });
    const shallow = row({ wallet: "0x2222222222222222222222222222222222222222", scannedTo: PM_FLOOR + 100 });

    const work = planWork([deep, shallow], { env: ENV });

    assert.equal(work[0].wallet, shallow.wallet, "finish the nearly-done first");
    assert.ok(work[0].remaining < work[1].remaining);
  });

  test("remaining sums every source of a multi-source quest", () => {
    const work = planWork(
      [
        row({ quest: "first_prediction", sourceKey: F8, floorBlock: F8_FLOOR, scannedTo: F8_FLOOR + 100 }),
        row({ quest: "first_prediction", sourceKey: F24, floorBlock: F24_FLOOR, scannedTo: F24_FLOOR + 900 }),
      ],
      { env: ENV },
    );

    assert.equal(work[0].remaining, 1_000, "a quest settles only when BOTH sources bottom out");
  });
});

describe("candidate selection", () => {
  test("skips wallets already proven complete", async () => {
    const writer = fakeWriter({ rows: [row()], completed: new Set([`${WALLET}:first_trade`]) });

    const out = await settle({ writer });

    assert.equal(out.skipped, 1);
    assert.equal(writer.extends_.length, 0, "its cursor rows are dead weight");
  });

  test("moves on to the next candidate when the first is already complete", async () => {
    const other = "0x3333333333333333333333333333333333333333";
    const writer = fakeWriter({
      rows: [row({ scannedTo: PM_FLOOR + 100 }), row({ wallet: other, scannedTo: PM_FLOOR + 200 })],
      completed: new Set([`${WALLET}:first_trade`]),
    });

    await settle({ writer });

    assert.equal(writer.extends_.length, 1);
    assert.equal(writer.extends_[0].wallet, other);
  });

  test("nothing to settle is a clean no-op", async () => {
    const out = await settle({ writer: fakeWriter({ rows: [] }) });
    assert.equal(out.reason, "nothing_to_settle");
  });

  // No silent caps: a full page means deeper work may exist that this run never saw.
  test("logs when the candidate page is full", async () => {
    const lines = [];
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ wallet: `0x${String(i).repeat(40)}`.slice(0, 42), scannedTo: PM_FLOOR + 100 }),
    );

    await runSettler({
      writer: fakeWriter({ rows }),
      chainId: CHAIN,
      budgetMs: 60_000,
      getLogs: noLogs,
      env: ENV,
      now: () => 0,
      log: (m) => lines.push(m),
      page: 3,
    });

    assert.ok(lines.some((l) => l.includes("page full")), lines.join("\n"));
  });
});

describe("multi-source quests", () => {
  test("works every source of the chosen quest", async () => {
    const writer = fakeWriter({
      rows: [
        row({ quest: "first_prediction", sourceKey: F8, floorBlock: F8_FLOOR, scannedTo: F8_FLOOR + 5_000 }),
        row({ quest: "first_prediction", sourceKey: F24, floorBlock: F24_FLOOR, scannedTo: F24_FLOOR + 5_000 }),
      ],
    });

    await settle({ writer });

    assert.equal(writer.extends_.length, 2, "both factories must reach their floors for the quest to settle");
    assert.deepEqual(writer.extends_.map((e) => e.sourceKey).sort(), [F8, F24].sort());
  });

  test("a hit on the first source short-circuits the second", async () => {
    const writer = fakeWriter({
      rows: [
        row({ quest: "first_prediction", sourceKey: F8, floorBlock: F8_FLOOR }),
        row({ quest: "first_prediction", sourceKey: F24, floorBlock: F24_FLOOR }),
      ],
    });

    await settle({ writer, getLogs: async () => [{ blockNumber: F8_FLOOR + 1 }] });

    assert.equal(writer.completions.length, 1);
    assert.equal(writer.extends_.length, 0);
  });
});

describe("failure handling", () => {
  test("a chunk error keeps the progress made before it", async () => {
    let call = 0;
    const writer = fakeWriter({ rows: [row({ scannedTo: 33_000_000 })] });

    await settle({
      writer,
      getLogs: async () => {
        if (++call > 2) throw new Error("rpc down");
        return [];
      },
    });

    assert.equal(writer.extends_.length, 1);
    assert.equal(writer.extends_[0].scannedTo, 33_000_000 - 20_000, "two successful chunks, then stop");
    assert.equal(writer.completions.length, 0);
  });

  test("an error on the very first chunk writes nothing", async () => {
    const writer = fakeWriter({ rows: [row()] });

    await settle({
      writer,
      getLogs: async () => {
        throw new Error("rpc down");
      },
    });

    assert.equal(writer.extends_.length, 0);
    assert.equal(writer.completions.length, 0);
  });
});

describe("the settleable set", () => {
  // daily_active must never appear: it is answered by the index plus a live tail scan and
  // writes no cursor rows, so a cursor row for it would be a bug elsewhere.
  test("covers exactly the one-time quests", () => {
    assert.deepEqual(Object.keys(SETTLEABLE_QUESTS).sort(), ["first_prediction", "first_trade", "provide_liquidity"]);
    assert.ok(!("daily_active" in SETTLEABLE_QUESTS));
  });

  test("first_prediction scans both factories", () => {
    assert.deepEqual(SETTLEABLE_QUESTS.first_prediction.sort(), ["predictionFactory", "predictionFactoryOld"]);
  });
});
