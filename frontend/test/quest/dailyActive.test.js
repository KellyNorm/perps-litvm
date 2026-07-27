// daily_active — the one quest where absence is an answer, and therefore the one place a
// background failure can make this endpoint lie.
//
// The property under test, stated once: NO combination of index state ever produces
// `completed: false, status: confirmed` unless the index was PROVEN current AND the blocks
// it has not reached were walked live and found empty. Everything else is indeterminate.
//
// Fully offline: injected clock, injected head, injected index storage, fake contracts.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { dailyActiveTier1, dailyActiveTier2 } from "../../api/_lib/quest/checks.js";
import {
  DAY_BOUNDARY,
  DEFAULT_MAX_LAG_MS,
  INDEXER_STALE,
  createIndexerState,
  maxLagBlocks,
  nullIndexerStateDriver,
  withinDayBoundaryGrace,
} from "../../api/_lib/quest/indexerState.js";
import { STATUS, SOURCE } from "../../api/_lib/quest/quests.js";
import { verifyQuest } from "../../api/quest/verify.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const WALLET = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";
const HEAD = 33_500_000;
// Mid-afternoon: comfortably outside the midnight grace window.
const NOON = new Date(Date.UTC(2026, 6, 26, 14, 0, 0));
const KEYS = ["0xaaa", "0xbbb", "0xccc", "0xddd"];

/** Index storage with all four sources fresh unless told otherwise. */
function indexOf({ lastBlock = HEAD - 100, ageMs = 60_000, keys = KEYS, hasRow = false, rowThrows = false, loadThrows = false } = {}) {
  return createIndexerState({
    async load() {
      if (loadThrows) throw new Error("supabase down");
      return keys.map((sourceKey) => ({ sourceKey, lastBlock, updatedAt: new Date(NOON.getTime() - ageMs).toISOString() }));
    },
    async hasDailyRow() {
      if (rowThrows) throw new Error("quest_daily unreadable");
      return hasRow;
    },
  });
}

const tier1 = (over = {}) =>
  dailyActiveTier1(WALLET, {
    indexerState: over.indexerState ?? indexOf(),
    now: () => over.now ?? NOON,
    getHead: async () => over.head ?? HEAD,
    // requiredSourceKeys() reads env addresses; stub the whole freshness input instead.
    ...over.tierOpts,
  });

/**
 * Fake tail-scan source. `floor` is assigned by `use()` below rather than hardcoded — the
 * whole point of tier 2 is that the floor comes from the watermark, so a fixture that
 * ignored it would let a scan walk to genesis and still look like it passed.
 */
function tailSource({ logsAt = {}, fail = false, label = "tail" } = {}) {
  const queries = [];
  return {
    floor: null,
    label,
    address: "0x0000000000000000000000000000000000000001",
    queries,
    filter: {},
    contract: {
      address: "0x0000000000000000000000000000000000000001",
      async queryFilter(_f, lo, hi) {
        queries.push([lo, hi]);
        if (fail) throw new Error("getLogs failed");
        return Object.keys(logsAt).map(Number).filter((b) => b >= lo && b <= hi).map((b) => ({ blockNumber: b }));
      },
    },
  };
}

/** Hand the tier's computed floor to the fixtures, the way tailScanSources() would. */
const use =
  (...sources) =>
  (_address, floor) =>
    sources.map((src) => Object.assign(src, { floor }));

// requiredSourceKeys() resolves addresses from env, which are deliberately unset in tests.
// Stub it by giving the tier a pre-built freshness call — done by pointing the tier at an
// index whose load() ignores the keys it is handed.
process.env.QUEST_POSITION_MANAGER_ADDRESS = "0x00000000000000000000000000000000000000aa";
process.env.QUEST_LIQUIDITY_POOL_ADDRESS = "0x00000000000000000000000000000000000000bb";
process.env.QUEST_PREDICTION_FACTORY_ADDRESS = "0x00000000000000000000000000000000000000cc";
process.env.QUEST_PREDICTION_FACTORY_OLD_ADDRESS = "0x00000000000000000000000000000000000000dd";
const ENV_KEYS = [
  "0x00000000000000000000000000000000000000aa",
  "0x00000000000000000000000000000000000000bb",
  "0x00000000000000000000000000000000000000cc",
  "0x00000000000000000000000000000000000000dd",
];

// ============================================================================
// TIER 1 — THE FRESHNESS GATE
// ============================================================================
describe("tier 1: a stale index NEVER yields a false", () => {
  // Each of the six fail-closed conditions, asserted through the tier rather than through
  // the policy in isolation — what matters is that the QUEST degrades, not just the helper.
  const staleCases = [
    ["a required source has no row", { keys: ENV_KEYS.slice(0, 3) }],
    ["the read failed", { loadThrows: true }],
    ["the job is not running (wall-clock age)", { ageMs: DEFAULT_MAX_LAG_MS + 1_000 }],
    ["the job is losing ground (block lag)", { lastBlock: HEAD - maxLagBlocks() - 1 }],
    ["head is behind the watermark (chain reset)", { lastBlock: HEAD + 1 }],
  ];

  for (const [name, over] of staleCases) {
    test(`${name} → unreliable, reason indexer_stale`, async () => {
      const out = await tier1({ indexerState: indexOf({ keys: ENV_KEYS, ...over }) });

      assert.equal(out.completed, false);
      assert.equal(out.reliable, false, "an unreliable tier1 is what stops verify.js reaching a verdict");
      assert.equal(out.reason, INDEXER_STALE);
      assert.equal(out.checkedThroughBlock, null, "a stale answer must not claim to have checked anything");
    });
  }

  // A row EXISTS but the index is stale. The row is still proof — but we never get there,
  // because the gate runs first and we cannot trust that quest_daily is complete.
  test("staleness is checked BEFORE the row lookup, even when a row would be found", async () => {
    let asked = false;
    const state = createIndexerState({
      async load() {
        throw new Error("supabase down");
      },
      async hasDailyRow() {
        asked = true;
        return true;
      },
    });

    const out = await tier1({ indexerState: state });

    assert.equal(out.reliable, false);
    assert.equal(asked, false, "quest_daily must not be read while the index is unproven");
  });

  // An unreadable quest_daily is not an absent row.
  test("an unreadable quest_daily degrades rather than reading as 'no row'", async () => {
    const out = await tier1({ indexerState: indexOf({ keys: ENV_KEYS, rowThrows: true }) });

    assert.equal(out.completed, false);
    assert.equal(out.reliable, false);
    assert.equal(out.reason, "index_unreadable");
  });

  // With no Supabase configured there is no index at all — which must read as stale, not
  // as an empty index. There is no in-memory analogue of a forward indexer.
  test("an unconfigured index is stale, not empty", async () => {
    const out = await tier1({ indexerState: createIndexerState(nullIndexerStateDriver()) });

    assert.equal(out.reliable, false);
    assert.equal(out.reason, INDEXER_STALE);
  });
});

describe("tier 1: the happy paths", () => {
  test("a row is proof — completed, reliable", async () => {
    const out = await tier1({ indexerState: indexOf({ keys: ENV_KEYS, hasRow: true }) });

    assert.equal(out.completed, true);
    assert.equal(out.reliable, true);
  });

  // The crucial one: no row + fresh index is still only a HINT. It must not be reliable-and-
  // final on its own; the tail scan is what earns the verdict.
  test("no row on a fresh index is a reliable HINT, and reports where the index stopped", async () => {
    const out = await tier1({ indexerState: indexOf({ keys: ENV_KEYS, lastBlock: HEAD - 100 }) });

    assert.equal(out.completed, false);
    assert.equal(out.reliable, true);
    assert.equal(out.indexedThrough, HEAD - 100, "tier 2 needs to know where to start");
    assert.equal(out.checkedThroughBlock, HEAD, "reported as of head — the tail scan is what earns that");
  });
});

describe("tier 1: the midnight window", () => {
  const justAfterMidnight = new Date(Date.UTC(2026, 6, 26, 0, 2, 0));

  // The writer dates rows by BLOCK timestamp, the reader asks for the WALL-CLOCK day. Near
  // 00:00 those disagree, and the disagreement produces a confident false for a wallet that
  // acted seconds ago.
  test("declines to answer just after 00:00 UTC", async () => {
    const out = await tier1({ now: justAfterMidnight, indexerState: indexOf({ keys: ENV_KEYS, hasRow: true }) });

    assert.equal(out.reliable, false);
    assert.equal(out.reason, DAY_BOUNDARY);
    assert.notEqual(out.reason, INDEXER_STALE, "a different problem from a dead indexer, and not a bug");
  });

  test("is checked before anything else — no index read, no head fetch needed", async () => {
    let touched = false;
    const state = createIndexerState({
      async load() {
        touched = true;
        return [];
      },
      async hasDailyRow() {
        touched = true;
        return false;
      },
    });

    await tier1({ now: justAfterMidnight, indexerState: state });

    assert.equal(touched, false, "there is nothing to gain by looking during the window");
  });

  test("answers normally outside the window", async () => {
    assert.equal(withinDayBoundaryGrace(justAfterMidnight), true);
    assert.equal(withinDayBoundaryGrace(NOON), false);

    const out = await tier1({ indexerState: indexOf({ keys: ENV_KEYS, hasRow: true }) });
    assert.equal(out.reliable, true);
  });
});

// ============================================================================
// TIER 2 — THE TAIL SCAN
// ============================================================================
describe("tier 2: the tail scan closes the fresh-but-trailing gap", () => {
  const fresh = { reliable: true, indexedThrough: HEAD - 500 };

  test("walks exactly [watermark+1, head], and no further down", async () => {
    const src = tailSource();

    await dailyActiveTier2(WALLET, { head: HEAD, tier1: fresh, makeSources: use(src) });

    assert.ok(src.queries.length > 0);
    const lowest = Math.min(...src.queries.map(([lo]) => lo));
    const highest = Math.max(...src.queries.map(([, hi]) => hi));
    assert.equal(highest, HEAD, "must reach the current head");
    assert.equal(lowest, HEAD - 499, "must start one block above the watermark, not at a deploy block");
  });

  // THE WHOLE POINT. The index is fresh and has no row, but the wallet acted ninety seconds
  // ago in a block the indexer has not reached. Without this the answer is a confident false.
  test("finds activity the index has not reached yet", async () => {
    const src = tailSource({ logsAt: { [HEAD - 200]: true } });

    const out = await dailyActiveTier2(WALLET, { head: HEAD, tier1: fresh, makeSources: use(src) });

    assert.equal(out.found, true, "a just-active user must not be told 'no'");
  });

  test("an empty tail is a proven negative — the only route to a confirmed false", async () => {
    const out = await dailyActiveTier2(WALLET, { head: HEAD, tier1: fresh, makeSources: use(tailSource()) });

    assert.equal(out.found, false);
    assert.equal(out.complete, true);
  });

  test("a failed tail chunk degrades to indeterminate rather than a false", async () => {
    const out = await dailyActiveTier2(WALLET, {
      head: HEAD,
      tier1: fresh,
      makeSources: use(tailSource({ fail: true })),
    });

    assert.equal(out.complete, false);
    assert.equal(out.exhausted, true);
  });

  test("one failing source among several blocks the verdict", async () => {
    const out = await dailyActiveTier2(WALLET, {
      head: HEAD,
      tier1: fresh,
      makeSources: use(tailSource(), tailSource({ fail: true, label: "b" })),
    });

    assert.equal(out.complete, false);
  });

  // The index already covers head, so the tail is empty. scanForEvent with floor > head
  // walks nothing and would report `exhausted` — an indeterminate for the case where
  // coverage is actually total.
  test("a fully caught-up index needs no scan and is complete", async () => {
    const src = tailSource();

    const out = await dailyActiveTier2(WALLET, {
      head: HEAD,
      tier1: { reliable: true, indexedThrough: HEAD },
      makeSources: use(src),
    });

    assert.equal(out.complete, true);
    assert.equal(out.found, false);
    assert.equal(out.chunksUsed, 0);
    assert.equal(src.queries.length, 0, "nothing left to walk");
  });

  // The floor is a WATERMARK, not a deploy block, so the default verifyFloor (which asks
  // whether the contract has no code below the floor) would fail forever. The property that
  // matters is "the index provably covers everything below", which tier 1 established.
  test("the floor check is tier 1's freshness proof, carried forward", async () => {
    const ok = await dailyActiveTier2(WALLET, { head: HEAD, tier1: fresh, makeSources: use(tailSource()) });
    assert.equal(ok.complete, true);

    // A tier 1 that did not establish freshness cannot license a proven negative.
    const bad = await dailyActiveTier2(WALLET, {
      head: HEAD,
      tier1: { reliable: false, indexedThrough: HEAD - 500 },
      makeSources: use(tailSource()),
    });
    assert.equal(bad.complete, false);
    assert.equal(bad.reason, "floor_unverified");
  });

  // The tail cannot be wider than the freshness threshold — beyond it, tier 1 already said
  // stale and tier 2 never runs. So the scan is one small getLogs per source.
  test("is bounded by the freshness threshold, one chunk per source", async () => {
    const src = tailSource();

    await dailyActiveTier2(WALLET, {
      head: HEAD,
      tier1: { reliable: true, indexedThrough: HEAD - maxLagBlocks() },
      makeSources: use(src),
    });

    assert.equal(src.queries.length, 1, "the widest legal tail is still a single chunk");
  });
});

// ============================================================================
// THE TWO TIERS TOGETHER, THROUGH THE REAL VERDICT MAPPING
// ============================================================================
describe("end to end through verifyQuest", () => {
  const definition = (state, over = {}) => ({
    id: "daily_active",
    kind: "daily",
    tier1: (addr) => dailyActiveTier1(addr, { indexerState: state, now: () => NOON, getHead: async () => HEAD }),
    tier2: (addr, opts) => dailyActiveTier2(addr, { ...opts, makeSources: use(over.source ?? tailSource()) }),
  });

  test("fresh index + row → CONFIRMED true", async () => {
    const out = await verifyQuest(definition(indexOf({ keys: ENV_KEYS, hasRow: true })), WALLET);

    assert.equal(out.completed, true);
    assert.equal(out.status, STATUS.CONFIRMED);
    assert.equal(out.source, SOURCE.TIER1);
  });

  test("fresh index + no row + empty tail → CONFIRMED false", async () => {
    const out = await verifyQuest(definition(indexOf({ keys: ENV_KEYS })), WALLET);

    assert.equal(out.completed, false);
    assert.equal(out.status, STATUS.CONFIRMED, "the only route to a settled no");
    assert.equal(out.source, SOURCE.TIER2);
  });

  test("fresh index + no row + activity in the tail → CONFIRMED true", async () => {
    const out = await verifyQuest(
      definition(indexOf({ keys: ENV_KEYS }), { source: tailSource({ logsAt: { [HEAD - 50]: true } }) }),
      WALLET,
    );

    assert.equal(out.completed, true);
    assert.equal(out.status, STATUS.CONFIRMED);
    assert.equal(out.source, SOURCE.TIER2);
  });

  // THE HEADLINE. Every staleness cause, through the full mapping, must be indeterminate.
  test("NO stale condition ever produces a confirmed false", async () => {
    const cases = [
      ["missing source", { keys: ENV_KEYS.slice(0, 3) }],
      ["read failed", { keys: ENV_KEYS, loadThrows: true }],
      ["wall-clock age", { keys: ENV_KEYS, ageMs: DEFAULT_MAX_LAG_MS + 1 }],
      ["block lag", { keys: ENV_KEYS, lastBlock: HEAD - maxLagBlocks() - 1 }],
      ["chain reset", { keys: ENV_KEYS, lastBlock: HEAD + 1 }],
      ["quest_daily unreadable", { keys: ENV_KEYS, rowThrows: true }],
    ];

    for (const [name, over] of cases) {
      const out = await verifyQuest(definition(indexOf(over)), WALLET);

      assert.equal(out.status, STATUS.INDETERMINATE, `${name} must be indeterminate`);
      assert.notEqual(
        `${out.completed}:${out.status}`,
        `false:${STATUS.CONFIRMED}`,
        `${name} MUST NOT produce a confirmed false`,
      );
    }
  });

  test("the reason names WHICH problem, so a stale index is distinguishable from a dead RPC", async () => {
    const stale = await verifyQuest(definition(indexOf({ keys: ENV_KEYS.slice(0, 3) })), WALLET);
    assert.equal(stale.reason, INDEXER_STALE);

    const boundary = await verifyQuest(
      {
        id: "daily_active",
        kind: "daily",
        tier1: (addr) =>
          dailyActiveTier1(addr, {
            indexerState: indexOf({ keys: ENV_KEYS }),
            now: () => new Date(Date.UTC(2026, 6, 26, 0, 1, 0)),
            getHead: async () => HEAD,
          }),
        tier2: null,
      },
      WALLET,
    );
    assert.equal(boundary.reason, DAY_BOUNDARY);
  });

  test("a broken tail scan is indeterminate, never a false", async () => {
    const out = await verifyQuest(
      definition(indexOf({ keys: ENV_KEYS }), { source: tailSource({ fail: true }) }),
      WALLET,
    );

    assert.equal(out.status, STATUS.INDETERMINATE);
    assert.equal(out.completed, false);
  });
});
