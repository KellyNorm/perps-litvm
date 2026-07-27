// The zero-chunk negative. This is the second place in the codebase allowed to produce a
// `completed: false, status: confirmed`, so the suite is organised around the seven ways it
// must REFUSE to, one test per condition.
//
// FULLY OFFLINE: the stores are plain objects and the floor check is injected, so nothing
// here reaches Supabase or an RPC.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { PROOF, createIndexProof, unionCovers } from "../../api/_lib/quest/indexProof.js";

// The declines log deliberately; silenced so a passing run stays readable.
const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

const PM = "0x9396d36f713302ff39e0ba5b38012656f8e4eacf";
const FACTORY = "0x7dd9e01fd4f96f9b1f875351eaccb5ca6c84c512";
const OLD_FACTORY = "0x6338985c7f689c3e1959bfe1a8bb36e44849ea40";

const FLOOR = 23_302_630;
const HEAD = 33_500_000;

const source = (address, floor = FLOOR) => ({ address, floor, label: address });

/** A backfill row that reached its floor, anchored above where the forward half starts. */
const swept = (floor = FLOOR, coveredFrom = 33_000_000) => ({
  floorBlock: floor,
  coveredFrom,
  coveredTo: floor,
});

/** An indexer_state row that is fresh and has claimed its handoff below the sweep's ceiling. */
const indexed = (lastBlock = 33_499_900, completionFrom = 32_900_000) => ({
  lastBlock,
  updatedAt: new Date().toISOString(),
  completionFrom,
});

// ============================================================================
// CONDITIONS 1-5, PURE
// ============================================================================

describe("unionCovers — the two halves must meet", () => {
  const sources = [source(PM)];

  test("a swept floor that meets the handoff proves the join", () => {
    const out = unionCovers({
      sources,
      coverage: { [PM]: swept() },
      state: { [PM]: indexed() },
    });

    assert.equal(out.proven, true);
    assert.deepEqual(out.joins, [
      { source: PM, floor: FLOOR, coveredFrom: 33_000_000, completionFrom: 32_900_000, indexedTo: 33_499_900 },
    ]);
  });

  test("no sources proves nothing — vacuous truth is not truth", () => {
    const out = unionCovers({ sources: [], coverage: {}, state: {} });
    assert.equal(out.proven, false);
    assert.equal(out.detail, "no_required_sources");
  });

  // --- 1
  test("a source with no backfill row is unproven, not empty", () => {
    const out = unionCovers({ sources, coverage: {}, state: { [PM]: indexed() } });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `no_backfill:${PM}`);
  });

  // --- 2. A floor that moved voids the coverage, in BOTH directions: down means unswept
  // history below what was covered, up means the sweep may have read a different contract.
  test("a floor that no longer matches the configured one voids the row", () => {
    for (const stored of [FLOOR - 1, FLOOR + 1]) {
      const out = unionCovers({
        sources,
        coverage: { [PM]: { floorBlock: stored, coveredFrom: 33_000_000, coveredTo: stored } },
        state: { [PM]: indexed() },
      });
      assert.equal(out.proven, false);
      assert.equal(out.detail, `floor_changed:${PM}`);
    }
  });

  // --- 3. EQUALITY. This is the condition the operator watches as "reached_floor".
  test("a sweep that stopped one block short of the floor is unproven", () => {
    const out = unionCovers({
      sources,
      coverage: { [PM]: { floorBlock: FLOOR, coveredFrom: 33_000_000, coveredTo: FLOOR + 1 } },
      state: { [PM]: indexed() },
    });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `not_at_floor:${PM}`);
  });

  // --- 5. The one the migration is most emphatic about: NULL is not zero.
  test("a null handoff watermark fails closed", () => {
    const out = unionCovers({
      sources,
      coverage: { [PM]: swept() },
      state: { [PM]: { lastBlock: 33_499_900, updatedAt: new Date().toISOString(), completionFrom: null } },
    });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `handoff_unset:${PM}`);
  });

  // --- 4. The hole between the two halves. This is "no_gap".
  test("a sweep whose ceiling sits below the handoff leaves a hole", () => {
    const out = unionCovers({
      sources,
      // covered_from is one block too low: [32_900_000] itself was read by nothing.
      coverage: { [PM]: swept(FLOOR, 32_899_998) },
      state: { [PM]: indexed(33_499_900, 32_900_000) },
    });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `handoff_gap:${PM}`);
  });

  test("the two halves may meet exactly, with no overlap to spare", () => {
    const out = unionCovers({
      sources,
      coverage: { [PM]: swept(FLOOR, 32_899_999) },
      state: { [PM]: indexed(33_499_900, 32_900_000) },
    });
    assert.equal(out.proven, true);
  });

  test("a missing indexer_state row is unproven", () => {
    const out = unionCovers({ sources, coverage: { [PM]: swept() }, state: {} });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `no_indexer_state:${PM}`);
  });

  test("an unreadable backfill row is unproven, not usable", () => {
    const out = unionCovers({
      sources,
      coverage: { [PM]: { floorBlock: FLOOR, coveredFrom: "wat", coveredTo: FLOOR } },
      state: { [PM]: indexed() },
    });
    assert.equal(out.proven, false);
    assert.equal(out.detail, `unreadable_backfill:${PM}`);
  });

  // The multi-source rule, and the reason first_prediction is the interesting quest: one
  // factory swept and the other not must NOT prove a negative, or a wallet whose only bet
  // was on the draining factory is told it never bet.
  test("every source must be swept — one lagging factory blocks the proof", () => {
    const out = unionCovers({
      sources: [source(FACTORY, 32_222_320), source(OLD_FACTORY, 30_665_562)],
      coverage: {
        [FACTORY]: swept(32_222_320),
        [OLD_FACTORY]: { floorBlock: 30_665_562, coveredFrom: 33_000_000, coveredTo: 31_000_000 },
      },
      state: { [FACTORY]: indexed(), [OLD_FACTORY]: indexed() },
    });

    assert.equal(out.proven, false);
    assert.equal(out.detail, `not_at_floor:${OLD_FACTORY}`);
  });

  test("both factories swept proves the join for both", () => {
    const out = unionCovers({
      sources: [source(FACTORY, 32_222_320), source(OLD_FACTORY, 30_665_562)],
      coverage: { [FACTORY]: swept(32_222_320), [OLD_FACTORY]: swept(30_665_562) },
      state: { [FACTORY]: indexed(), [OLD_FACTORY]: indexed() },
    });

    assert.equal(out.proven, true);
    assert.equal(out.joins.length, 2);
  });
});

// ============================================================================
// THE RESOLVER — conditions 6 and 7, and the read failures
// ============================================================================

function build({
  completion = { found: false, checkedThroughBlock: null },
  coverage = new Map([[PM, swept()]]),
  freshness = { fresh: true, reason: null, detail: null, indexedThrough: 33_499_900, sources: [{ sourceKey: PM, ...indexed() }] },
  verifyFloor = async () => true,
  completionThrows = null,
  coverageThrows = null,
} = {}) {
  const calls = { completion: 0, coverage: 0, freshness: 0, floor: 0 };

  const proof = createIndexProof({
    backfill: {
      async readCompletion() {
        calls.completion++;
        if (completionThrows) throw completionThrows;
        return completion;
      },
      async loadBackfill() {
        calls.coverage++;
        if (coverageThrows) throw coverageThrows;
        return coverage;
      },
    },
    indexerState: {
      async readFreshness() {
        calls.freshness++;
        return freshness;
      },
    },
  });

  const resolve = () =>
    proof.resolve({
      chainId: 4441,
      wallet: "0xe9dd9bff0ad5254673daaa77397e84fec2312292",
      quest: "first_trade",
      sources: [source(PM)],
      head: HEAD,
      verifyFloor: async (s) => {
        calls.floor++;
        return verifyFloor(s);
      },
    });

  return { resolve, calls };
}

describe("resolve — what the index is allowed to answer", () => {
  test("a completion row is proof, and reports the block it was proven at", async () => {
    const { resolve } = build({ completion: { found: true, checkedThroughBlock: 31_000_000 } });
    const out = await resolve();

    assert.equal(out.answer, PROOF.COMPLETED);
    assert.equal(out.checkedThroughBlock, 31_000_000);
  });

  // A positive needs no coverage and no currency: the row exists because a log was seen.
  test("a completion is proof even when the index is stale and the sweep unfinished", async () => {
    const { resolve } = build({
      completion: { found: true, checkedThroughBlock: 31_000_000 },
      freshness: { fresh: false, reason: "indexer_stale", detail: "block_lag", indexedThrough: null, sources: null },
      coverage: new Map(),
    });

    assert.equal((await resolve()).answer, PROOF.COMPLETED);
  });

  test("no row plus a complete proof is a confirmed absence at the index watermark", async () => {
    const { resolve, calls } = build();
    const out = await resolve();

    assert.equal(out.answer, PROOF.ABSENT);
    // The MINIMUM watermark, not head — the index has not reached head.
    assert.equal(out.checkedThroughBlock, 33_499_900);
    assert.notEqual(out.checkedThroughBlock, HEAD);
    assert.equal(out.index.sources.length, 1);
    assert.equal(calls.floor, 1, "the floor is validated on every derivation, chunks or no chunks");
  });

  // --- 6
  test("a stale index cannot support an absence, however complete the sweep", async () => {
    const { resolve, calls } = build({
      freshness: { fresh: false, reason: "indexer_stale", detail: "updated_at_stale", indexedThrough: null, sources: null },
    });
    const out = await resolve();

    assert.equal(out.answer, PROOF.UNPROVEN);
    assert.equal(out.detail, "indexer_stale:updated_at_stale");
    assert.equal(calls.floor, 0, "no point paying for a chain read once the answer is already unproven");
  });

  // --- 7. The hazard conditions 1-6 cannot see: a sweep that reached a floor that was
  // never the contract's first block satisfies all of them perfectly.
  test("a floor that does not verify blocks the absence", async () => {
    const { resolve } = build({ verifyFloor: async () => false });
    const out = await resolve();

    assert.equal(out.answer, PROOF.UNPROVEN);
    assert.equal(out.detail, `floor_unverified:${PM}`);
  });

  test("a floor check that throws is treated as a floor that did not verify", async () => {
    const { resolve } = build({
      verifyFloor: async () => {
        throw new Error("rpc down");
      },
    });

    assert.equal((await resolve()).detail, `floor_unverified:${PM}`);
  });

  // THE ONE THAT MATTERS MOST. supabaseCache.js would return this as a miss, and a miss is
  // what becomes a confirmed false.
  test("a completion read that FAILS is never read as an absent row", async () => {
    const { resolve } = build({ completionThrows: new Error("HTTP 500") });
    const out = await resolve();

    assert.equal(out.answer, PROOF.UNPROVEN);
    assert.equal(out.detail, "completion_read_failed");
  });

  test("a backfill read that fails is unproven", async () => {
    const { resolve } = build({ coverageThrows: new Error("HTTP 503") });
    assert.equal((await resolve()).detail, "backfill_read_failed");
  });

  test("an unproven join names the condition that failed", async () => {
    const { resolve } = build({ coverage: new Map() });
    assert.equal((await resolve()).detail, `no_backfill:${PM}`);
  });

  test("a quest with no sources proves nothing", async () => {
    const proof = createIndexProof({ backfill: {}, indexerState: {} });
    const out = await proof.resolve({ chainId: 4441, wallet: "0x" + "1".repeat(40), quest: "x", sources: [], head: HEAD });

    assert.equal(out.answer, PROOF.UNPROVEN);
    assert.equal(out.detail, "no_required_sources");
  });

  // The proof never carries a verdict of its own into the envelope: `unproven` has no block,
  // so a caller that ignored `answer` could not accidentally publish one.
  test("an unproven result carries no checkedThroughBlock", async () => {
    const { resolve } = build({ coverage: new Map() });
    const out = await resolve();

    assert.equal(out.checkedThroughBlock, null);
    assert.equal(out.index, null);
  });
});
