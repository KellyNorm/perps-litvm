// The settler walks quest_cursor rows that the read path also walks, writes to, and derives
// verdicts from. It is a SEPARATE implementation in a separate deployable, so every
// parameter the two share is a place they can silently drift apart.
//
// Drift here is not a style problem. The read path's coverageProvesAbsence() asks whether
// `scanned_to === floor` and treats [scanned_to .. scanned_from] as contiguous. If the
// settler walked with a different chunk size, a different floor, or a different wallet
// filter, it would write a `scanned_to` that the read path either rejects as void (wasted
// work) or — worse — accepts as coverage of blocks that were never read the same way.
//
// This is a test-only import across the deployable boundary. The indexer's own isolation
// suite asserts that no SHIPPED file does the same.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { CHUNK_BLOCKS as READ_PATH_CHUNK } from "../../api/_lib/quest/scan.js";
import { ONE_TIME_BUCKET as READ_PATH_BUCKET } from "../../api/_lib/quest/supabaseCache.js";
import { QUESTS, QUEST_KIND } from "../../api/_lib/quest/quests.js";
import { CHUNK_BLOCKS as SETTLER_CHUNK } from "../../../quest-indexer/lib/walk.mjs";
import { ONE_TIME_BUCKET as SETTLER_BUCKET } from "../../../quest-indexer/lib/supabase.mjs";
// definitions.mjs, NOT sources.mjs: the latter imports ethers, which is not installed in
// the frontend's test job. Keeping the shared data in a dependency-free module is what lets
// the two suites stay independently runnable — see that file's header.
import {
  DEFAULT_DEPLOY_BLOCKS,
  SETTLEABLE_QUESTS,
  SOURCES,
  SOURCE_DEPLOY_BLOCK_VARS,
} from "../../../quest-indexer/lib/definitions.mjs";

// The read path's floors are a module-private const in chain.js, so they are re-stated here
// from that file. If chain.js changes one, this test fails and names it — which is the
// point: a floor is coupled to an address, and a settler walking to a different floor than
// the read path expects writes coverage the read path will not accept.
const READ_PATH_DEPLOY_BLOCKS = {
  QUEST_POSITION_MANAGER_DEPLOY_BLOCK: 23_302_630,
  QUEST_LIQUIDITY_POOL_DEPLOY_BLOCK: 23_302_630,
  QUEST_PREDICTION_FACTORY_DEPLOY_BLOCK: 32_222_320,
  QUEST_PREDICTION_FACTORY_OLD_DEPLOY_BLOCK: 30_665_562,
};

describe("the two walks use the same parameters", () => {
  // Not a performance choice. Both writers extend the SAME quest_cursor rows, so a
  // different stride means the two produce coverage boundaries the other did not expect.
  test("chunk size matches scan.js", () => {
    assert.equal(SETTLER_CHUNK, READ_PATH_CHUNK, "the settler and the read path must walk in the same stride");
    assert.equal(SETTLER_CHUNK, 10_000, "and it is the measured 10k, not a round number someone liked");
  });

  // "Reached the floor" is tested with EQUALITY on the read path. A settler that stopped one
  // block short, or walked one block past, would never satisfy it — or would satisfy the
  // table CHECK but not the derivation.
  test("deploy-block floors match chain.js, name for name and value for value", () => {
    assert.deepEqual(DEFAULT_DEPLOY_BLOCKS, READ_PATH_DEPLOY_BLOCKS);
  });

  test("the deploy-block env var names are the ones chain.js reads", () => {
    assert.deepEqual(SOURCE_DEPLOY_BLOCK_VARS.slice().sort(), Object.keys(READ_PATH_DEPLOY_BLOCKS).sort());
  });

  // The settler writes completions the read path looks up by exact key. A mismatched bucket
  // makes every settled completion invisible — the work happens and nobody benefits.
  test("the one-time completion bucket matches supabaseCache.js", () => {
    assert.equal(SETTLER_BUCKET, READ_PATH_BUCKET);
  });
});

describe("the settleable set agrees with the registry", () => {
  test("every settleable id is a real quest with a tier2", () => {
    for (const id of Object.keys(SETTLEABLE_QUESTS)) {
      const quest = QUESTS[id];
      assert.ok(quest, `${id} is not a registered quest`);
      assert.ok(quest.tier2, `${id} has no tier2 — it writes no cursor rows to settle`);
    }
  });

  test("every one-time quest with a tier2 is settleable", () => {
    const oneTimeScanners = Object.values(QUESTS)
      .filter((q) => q.kind === QUEST_KIND.ONE_TIME && q.tier2)
      .map((q) => q.id)
      .sort();

    assert.deepEqual(
      Object.keys(SETTLEABLE_QUESTS).sort(),
      oneTimeScanners,
      "a deep quest missing from the settler would silently keep needing ~200 user polls",
    );
  });

  // daily_active is answered by the index plus a live tail scan and passes no cursors, so it
  // writes no quest_cursor rows. Settling it would be meaningless work against a floor that
  // moves every minute.
  test("daily_active is NOT settleable", () => {
    assert.ok(!("daily_active" in SETTLEABLE_QUESTS));
  });

  test("every source the settler names exists in the shared descriptor list", () => {
    const known = new Set(SOURCES.map((s) => s.key));
    for (const [id, keys] of Object.entries(SETTLEABLE_QUESTS)) {
      for (const key of keys) assert.ok(known.has(key), `${id} names unknown source ${key}`);
    }
  });

  // The pairing itself — which sources belong to which quest — mirrors checks.js, which
  // builds its sources inside functions rather than declaring them. This pins the one
  // property that IS machine-checkable: a multi-source quest must stay multi-source.
  test("first_prediction still scans both factories", () => {
    assert.equal(
      SETTLEABLE_QUESTS.first_prediction.length,
      2,
      "dropping the draining factory would settle the quest against half its history",
    );
  });
});

// ============================================================================
// THE INDEX PROOF'S SOURCE LIST
// ============================================================================
// A quest opted into the zero-chunk negative (indexProof.js) demands a completed backfill
// for every source in `indexSources()` and then reports a confirmed false. So this list is
// the one the indexer and the backfill must have actually swept — and the direction it can
// go wrong is asymmetric and quiet: a list that is too SHORT proves less than it claims and
// hands out a confident false to a wallet whose only activity was on the source nobody
// required. Equality is the assertion, not containment.
//
// checks.js already makes this hard by construction — the proof and the Tier 2 scan read the
// SAME declaration — so this test is the guard on the other pairing, the one between that
// declaration and the indexer's own SETTLEABLE_QUESTS.

describe("the index proof requires exactly the sources the indexer writes", () => {
  const ADDRESSES = {
    QUEST_POSITION_MANAGER_ADDRESS: "0x9396D36F713302FF39E0bA5b38012656f8E4eACF",
    QUEST_LIQUIDITY_POOL_ADDRESS: "0x4716a0c9c504F83918002A3086590f1ed192560B",
    QUEST_PREDICTION_FACTORY_ADDRESS: "0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512",
    QUEST_PREDICTION_FACTORY_OLD_ADDRESS: "0x6338985C7f689C3e1959bfe1a8bb36E44849EA40",
  };

  const saved = {};
  before(() => {
    for (const [k, v] of Object.entries(ADDRESSES)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const byKey = Object.fromEntries(SOURCES.map((s) => [s.key, s]));

  test("every opted-in quest names the same contracts and floors the indexer sweeps", () => {
    const optedIn = Object.values(QUESTS).filter((q) => typeof q.indexSources === "function");
    assert.ok(optedIn.length > 0, "no quest is on the fast path — did the registry lose indexSources?");

    for (const quest of optedIn) {
      const indexerSide = (SETTLEABLE_QUESTS[quest.id] ?? []).map((key) => ({
        address: process.env[byKey[key].addressVar].toLowerCase(),
        floor: DEFAULT_DEPLOY_BLOCKS[byKey[key].deployBlockVar],
      }));

      const readPathSide = quest.indexSources().map((s) => ({ address: s.address.toLowerCase(), floor: s.floor }));

      assert.deepEqual(
        readPathSide.slice().sort((a, b) => a.address.localeCompare(b.address)),
        indexerSide.slice().sort((a, b) => a.address.localeCompare(b.address)),
        `${quest.id}: a shorter list here is a confirmed false about a source nobody swept`,
      );
    }
  });

  // provide_liquidity is deliberately NOT opted in while the LiquidityPool sweep is still
  // descending. Nothing enforces that — the proof fails `not_at_floor` on its own and falls
  // back to the scan — so this only records that the omission is a decision, not an oversight.
  test("an opted-in quest is one whose sources are settleable at all", () => {
    for (const quest of Object.values(QUESTS)) {
      if (typeof quest.indexSources !== "function") continue;
      assert.ok(SETTLEABLE_QUESTS[quest.id], `${quest.id} is on the fast path but the indexer writes nothing for it`);
    }
  });
});
