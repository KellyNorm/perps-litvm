// The coverage cursor store, and the convergence it buys.
//
// The invariant under test throughout: this store moves INTERVALS, never verdicts, and
// every way it can fail — a dead driver, a malformed row, a stale floor, a lost write —
// must end in LESS coverage, which derives to indeterminate. There is no failure of this
// store that can produce a `confirmed: false`.
//
// Fully offline: fake contracts, fake drivers, no network and no clock.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import {
  createCursorStore,
  memoryCursorDriver,
  normalizeCoverageRow,
  normalizeIdentity,
  nullCursorDriver,
  scanWithResume,
} from "../../api/_lib/quest/cursor.js";
import { sourceKeyOf } from "../../api/_lib/quest/scan.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const WALLET = "0x1111111111111111111111111111111111111111";
const ID = { chainId: 4441, wallet: WALLET, quest: "first_prediction" };

/** Same fake source as scan.test.js: `logsAt` blocks produce a matching log. */
function source({ floor, logsAt = {}, fail = () => false, label = "src", address = "0xab".padEnd(42, "c") } = {}) {
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
const budget = { chunkBlocks: 10_000, maxChunks: 3, verifyFloor: floorOk };

describe("normalizeIdentity", () => {
  test("accepts a well-formed identity", () => {
    assert.deepEqual(normalizeIdentity(ID), { chainId: 4441, wallet: WALLET, quest: "first_prediction" });
  });

  // Checksum casing must not split one wallet's coverage across two rows — that would make
  // a walk that HAS reached the floor look permanently partial.
  test("lower-cases the wallet at the boundary", () => {
    const mixed = normalizeIdentity({ ...ID, wallet: WALLET.toUpperCase().replace("0X", "0x") });
    assert.equal(mixed.wallet, WALLET);
  });

  test("trims and parses a numeric-string chain id", () => {
    assert.equal(normalizeIdentity({ ...ID, chainId: "4441" }).chainId, 4441);
    assert.equal(normalizeIdentity({ ...ID, quest: "  first_trade  " }).quest, "first_trade");
  });

  test("rejects anything it cannot key a row by", () => {
    for (const bad of [
      null,
      undefined,
      "nope",
      { ...ID, chainId: 0 },
      { ...ID, chainId: -1 },
      { ...ID, chainId: 1.5 },
      { ...ID, chainId: undefined },
      { ...ID, wallet: "0xnothex" },
      { ...ID, wallet: "" },
      { ...ID, wallet: 42 },
      { ...ID, quest: "" },
      { ...ID, quest: null },
    ]) {
      assert.equal(normalizeIdentity(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("normalizeCoverageRow", () => {
  const ok = { sourceKey: "0xabc", floorBlock: 1_000, scannedFrom: 9_000, scannedTo: 1_000 };

  test("accepts a well-formed interval", () => {
    assert.deepEqual(normalizeCoverageRow(ok), ok);
  });

  test("accepts block numbers that arrived as strings", () => {
    const row = normalizeCoverageRow({ ...ok, floorBlock: "1000", scannedFrom: "9000", scannedTo: "1000" });
    assert.deepEqual(row, ok);
  });

  test("lower-cases the source key, as the table CHECK requires", () => {
    assert.equal(normalizeCoverageRow({ ...ok, sourceKey: "0xAbC" }).sourceKey, "0xabc");
  });

  // These mirror the table's CHECK constraints on purpose. On a WRITE one bad interval
  // would fail the whole batch at PostgREST and discard every other source's honest
  // progress; on a READ a row that got past them must not be allowed to buy a negative.
  test("drops intervals that claim coverage BELOW the floor", () => {
    assert.equal(normalizeCoverageRow({ ...ok, scannedTo: 999 }), null);
  });

  test("drops inverted intervals", () => {
    assert.equal(normalizeCoverageRow({ ...ok, scannedFrom: 1_000, scannedTo: 9_000 }), null);
  });

  test("drops missing, negative and non-integer blocks", () => {
    for (const bad of [
      null,
      "row",
      { ...ok, sourceKey: "" },
      { ...ok, sourceKey: null },
      { ...ok, floorBlock: -1 },
      { ...ok, scannedTo: -5 },
      { ...ok, scannedFrom: 1.5 },
      { ...ok, scannedFrom: null },
      { ...ok, scannedTo: undefined },
      { ...ok, floorBlock: "abc" },
    ]) {
      assert.equal(normalizeCoverageRow(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("createCursorStore — reads", () => {
  test("keys usable rows by source, ready for scanForEvent", async () => {
    const store = createCursorStore({
      async load() {
        return [{ sourceKey: "0xaaa", floorBlock: 10, scannedFrom: 900, scannedTo: 10 }];
      },
      async save() {},
    });

    assert.deepEqual(await store.load(ID), {
      "0xaaa": { sourceKey: "0xaaa", floorBlock: 10, scannedFrom: 900, scannedTo: 10 },
    });
  });

  test("drops malformed rows and keeps the good ones", async () => {
    const store = createCursorStore({
      async load() {
        return [
          { sourceKey: "0xaaa", floorBlock: 10, scannedFrom: 900, scannedTo: 10 },
          { sourceKey: "0xbbb", floorBlock: 10, scannedFrom: 900, scannedTo: 5 }, // below floor
          null,
        ];
      },
      async save() {},
    });

    assert.deepEqual(Object.keys(await store.load(ID)), ["0xaaa"]);
  });

  // A dead store must read as "nothing walked yet", which is the state a first-ever poll is
  // in. Slower, never wrong.
  test("a throwing driver reads as no coverage", async () => {
    const store = createCursorStore({
      async load() {
        throw new Error("supabase down");
      },
      async save() {},
    });

    assert.deepEqual(await store.load(ID), {});
  });

  test("a driver returning nonsense reads as no coverage", async () => {
    for (const value of [null, "rows", 42, undefined]) {
      const store = createCursorStore({ async load() { return value; }, async save() {} });
      assert.deepEqual(await store.load(ID), {});
    }
  });

  test("an unusable identity never reaches the driver", async () => {
    let called = false;
    const store = createCursorStore({
      async load() {
        called = true;
        return [];
      },
      async save() {},
    });

    assert.deepEqual(await store.load({ ...ID, wallet: "nope" }), {});
    assert.equal(called, false);
  });
});

describe("createCursorStore — writes", () => {
  test("writes validated rows and reports how many landed", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);

    const n = await store.save(ID, [{ sourceKey: "0xAAA", floorBlock: 10, scannedFrom: 900, scannedTo: 20 }]);

    assert.equal(n, 1);
    assert.deepEqual(await store.load(ID), {
      "0xaaa": { sourceKey: "0xaaa", floorBlock: 10, scannedFrom: 900, scannedTo: 20 },
    });
  });

  // One bad interval must not cost the other sources their honest progress.
  test("drops an invalid row without losing the valid ones", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);

    const n = await store.save(ID, [
      { sourceKey: "0xaaa", floorBlock: 10, scannedFrom: 900, scannedTo: 20 },
      { sourceKey: "0xbbb", floorBlock: 10, scannedFrom: 900, scannedTo: 5 },
    ]);

    assert.equal(n, 1);
    assert.deepEqual(Object.keys(await store.load(ID)), ["0xaaa"]);
  });

  test("a throwing driver does not throw out of the store", async () => {
    const store = createCursorStore({
      async load() {
        return [];
      },
      async save() {
        throw new Error("supabase down");
      },
    });

    assert.equal(await store.save(ID, [{ sourceKey: "0xaaa", floorBlock: 0, scannedFrom: 9, scannedTo: 0 }]), 0);
  });

  test("an empty batch or unusable identity writes nothing", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);

    assert.equal(await store.save(ID, []), 0);
    assert.equal(await store.save(ID, null), 0);
    assert.equal(await store.save({ ...ID, quest: "" }, [{ sourceKey: "0xa", floorBlock: 0, scannedFrom: 1, scannedTo: 0 }]), 0);
    assert.equal(driver._size(), 0);
  });

  test("rows are namespaced by chain, wallet and quest", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const row = { sourceKey: "0xaaa", floorBlock: 0, scannedFrom: 900, scannedTo: 100 };

    await store.save(ID, [row]);

    assert.deepEqual(await store.load({ ...ID, quest: "first_trade" }), {});
    assert.deepEqual(await store.load({ ...ID, chainId: 1 }), {});
    assert.deepEqual(await store.load({ ...ID, wallet: "0x2222222222222222222222222222222222222222" }), {});
    assert.equal(Object.keys(await store.load(ID)).length, 1);
  });

  // STRUCTURAL: there is no verdict-shaped field anywhere in what gets persisted, so no
  // future bug can smuggle a `false` into durable storage through this path.
  test("a persisted row carries coverage and nothing that resembles a verdict", async () => {
    let written;
    const store = createCursorStore({
      async load() {
        return [];
      },
      async save(_id, rows) {
        written = rows;
      },
    });

    await store.save(ID, [
      {
        sourceKey: "0xaaa",
        floorBlock: 0,
        scannedFrom: 900,
        scannedTo: 0,
        // Anything a careless caller might attach must simply not survive.
        completed: false,
        status: "confirmed",
        dirty: true,
      },
    ]);

    assert.deepEqual(Object.keys(written[0]).sort(), ["floorBlock", "scannedFrom", "scannedTo", "sourceKey"]);
  });
});

describe("nullCursorDriver", () => {
  test("remembers nothing, so every poll restarts from head", async () => {
    const store = createCursorStore(nullCursorDriver());
    await store.save(ID, [{ sourceKey: "0xaaa", floorBlock: 0, scannedFrom: 900, scannedTo: 0 }]);
    assert.deepEqual(await store.load(ID), {});
  });
});

describe("scanWithResume", () => {
  test("resumes from stored coverage and writes back what it advanced", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const s = source({ floor: 1_000 });

    await scanWithResume([s], { ...ID, cursors: store, head: 100_000, ...budget });
    const first = await store.load(ID);
    assert.equal(first[sourceKeyOf(s)].scannedTo, 70_001);

    const s2 = source({ floor: 1_000 });
    await scanWithResume([s2], { ...ID, cursors: store, head: 100_000, ...budget });
    const second = await store.load(ID);

    assert.equal(second[sourceKeyOf(s2)].scannedTo, 40_001, "the second poll must go deeper, not repeat");
    assert.equal(s2.queries[0][1], 70_000, "and must resume below the stored interval");
  });

  // Requirement 4: a found event is recorded as a completion in the VERDICT cache; the
  // cursor for this wallet/quest will never be read again, so writing it is pure noise.
  test("a found event writes no coverage at all", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);
    const s = source({ floor: 1_000, logsAt: { 95_000: true } });

    const out = await scanWithResume([s], { ...ID, cursors: store, head: 100_000, ...budget });

    assert.equal(out.found, true);
    assert.equal(driver._size(), 0);
  });

  test("a poll that advances nothing writes nothing", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);

    // Already at the floor and already at head: there is no work and no write.
    await store.save(ID, [{ sourceKey: sourceKeyOf(source({ floor: 1_000 })), floorBlock: 1_000, scannedFrom: 100_000, scannedTo: 1_000 }]);
    let writes = 0;
    const counting = createCursorStore({
      load: (id) => driver.load(id),
      save: async (id, rows) => {
        writes++;
        return driver.save(id, rows);
      },
    });

    const out = await scanWithResume([source({ floor: 1_000 })], { ...ID, cursors: counting, head: 100_000, ...budget });

    assert.equal(out.complete, true);
    assert.equal(writes, 0, "an unchanged interval must not be re-upserted every poll");
  });

  test("degrades to a plain one-shot scan when no store is wired", async () => {
    const s = source({ floor: 1_000 });
    const out = await scanWithResume([s], { head: 100_000, ...budget });

    assert.equal(out.complete, false);
    assert.equal(s.queries[0][1], 100_000);
  });

  test("degrades to a plain scan when the identity is incomplete", async () => {
    const driver = memoryCursorDriver();
    const store = createCursorStore(driver);

    // A caller that forgot `quest` must get a correct answer, not a crash and not a row
    // filed under the wrong key.
    const out = await scanWithResume([source({ floor: 1_000 })], {
      chainId: 4441,
      wallet: WALLET,
      cursors: store,
      head: 100_000,
      ...budget,
    });

    assert.equal(out.complete, false);
    assert.equal(driver._size(), 0);
  });

  // ==========================================================================
  // THE SAFETY DIRECTION: every store failure costs coverage, never correctness.
  // ==========================================================================
  test("a store outage yields indeterminate, NEVER a false", async () => {
    const store = createCursorStore({
      async load() {
        throw new Error("supabase down");
      },
      async save() {
        throw new Error("supabase down");
      },
    });

    const out = await scanWithResume([source({ floor: 1_000 })], { ...ID, cursors: store, head: 100_000, ...budget });

    assert.equal(out.complete, false, "a lost cursor must degrade the answer, not settle it");
    assert.equal(out.found, false);
    assert.equal(out.exhausted, true);
  });

  test("a failed write costs the next poll depth, not the current answer", async () => {
    const store = createCursorStore({
      async load() {
        return [];
      },
      async save() {
        throw new Error("write rejected");
      },
    });

    const s = source({ floor: 1_000, logsAt: { 95_000: true } });
    const out = await scanWithResume([s], { ...ID, cursors: store, head: 100_000, ...budget });

    assert.equal(out.found, true, "the verdict is unaffected by a cursor write failure");
  });

  // Requirement 6, through the store: the floor lives in the row, so a floor that moved
  // voids the coverage rather than silently validating it against the wrong contract.
  test("stored coverage against a moved floor cannot settle the answer", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const s = source({ floor: 1_000 });

    // A complete-looking interval, but computed when the floor was 500.
    await store.save(ID, [{ sourceKey: sourceKeyOf(s), floorBlock: 500, scannedFrom: 100_000, scannedTo: 500 }]);

    const out = await scanWithResume([s], { ...ID, cursors: store, head: 100_000, ...budget });

    assert.equal(out.complete, false, "coverage from a different floor must not settle anything");
    assert.equal(s.queries[0][1], 100_000, "and the walk must restart from head");
  });

  test("a row hand-written to claim impossible coverage is rejected on read", async () => {
    const driver = memoryCursorDriver();
    const s = source({ floor: 1_000 });
    // Bypass the store's validation to simulate a corrupt/forged row reaching the driver.
    await driver.save(normalizeIdentity(ID), [
      { sourceKey: sourceKeyOf(s), floorBlock: 1_000, scannedFrom: 100_000, scannedTo: 0 },
    ]);

    const out = await scanWithResume([s], { ...ID, cursors: createCursorStore(driver), head: 100_000, ...budget });

    assert.equal(out.complete, false);
  });
});

// ============================================================================
// END TO END: the store and the scanner together, which is where convergence lives.
// ============================================================================
describe("convergence through the real store", () => {
  test("repeated polls on a deep-history wallet reach a confirmed false", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const statuses = [];

    for (let poll = 0; poll < 4; poll++) {
      const out = await scanWithResume([source({ floor: 1_000 })], {
        ...ID,
        cursors: store,
        head: 100_000,
        ...budget,
      });
      statuses.push(out.complete ? "confirmed" : "indeterminate");
    }

    assert.deepEqual(statuses, ["indeterminate", "indeterminate", "indeterminate", "confirmed"]);
  });

  test("the same wallet with a null store never converges", async () => {
    const store = createCursorStore(nullCursorDriver());
    const statuses = [];

    for (let poll = 0; poll < 4; poll++) {
      const out = await scanWithResume([source({ floor: 1_000 })], {
        ...ID,
        cursors: store,
        head: 100_000,
        ...budget,
      });
      statuses.push(out.complete ? "confirmed" : "indeterminate");
    }

    assert.deepEqual(statuses, Array(4).fill("indeterminate"));
  });

  // Requirement 5 end to end: first_prediction's two factories, different floors, one row
  // each, and no verdict until BOTH bottom out.
  test("a two-factory quest tracks each cursor independently and settles only on both", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const live = () => source({ floor: 60_000, label: "live", address: "0x11".padEnd(42, "1") });
    const old = () => source({ floor: 1_000, label: "old", address: "0x22".padEnd(42, "2") });
    const statuses = [];

    for (let poll = 0; poll < 5; poll++) {
      const out = await scanWithResume([live(), old()], { ...ID, cursors: store, head: 100_000, ...budget });
      statuses.push(out.complete ? "confirmed" : "indeterminate");
    }

    const rows = await store.load(ID);
    assert.equal(Object.keys(rows).length, 2, "one row per source, not one per quest");
    assert.equal(rows[sourceKeyOf(live())].floorBlock, 60_000);
    assert.equal(rows[sourceKeyOf(old())].floorBlock, 1_000);

    assert.equal(statuses.at(-1), "confirmed", "settles once both factories reach their floors");
    // And every poll before that was honest about not knowing.
    const firstConfirmed = statuses.indexOf("confirmed");
    assert.ok(firstConfirmed > 0, "a deep two-source quest cannot settle on the first poll");
    assert.deepEqual(statuses.slice(0, firstConfirmed), Array(firstConfirmed).fill("indeterminate"));
  });

  // The realistic shape of first_prediction: the live factory bottoms out on the first
  // poll, the superseded one is ~10M blocks down and will not bottom out for a long time.
  // The quest must stay indeterminate the whole way — a settled source is not a settled
  // quest, no matter how many polls it has been settled for.
  test("a settled source alone never settles the quest while the other is deep", async () => {
    const store = createCursorStore(memoryCursorDriver());
    const shallow = () => source({ floor: 9_980_000, label: "shallow", address: "0x11".padEnd(42, "1") });
    const deep = () => source({ floor: 0, label: "deep", address: "0x22".padEnd(42, "2") });

    for (let poll = 0; poll < 6; poll++) {
      const out = await scanWithResume([shallow(), deep()], { ...ID, cursors: store, head: 10_000_000, ...budget });
      assert.equal(out.complete, false, `poll ${poll} must stay indeterminate`);
    }

    const rows = await store.load(ID);
    assert.equal(rows[sourceKeyOf(shallow())].scannedTo, 9_980_000, "the shallow source has been at its floor for polls");
    assert.ok(rows[sourceKeyOf(deep())].scannedTo > 0, "and the deep one is still nowhere near its own");
  });
});
