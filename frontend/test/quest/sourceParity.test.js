// The two halves of the source list must not diverge.
//
// quest-indexer/ WRITES quest_daily for a set of sources; this endpoint REQUIRES that same
// set to be fresh before it will read the table. They are duplicated at runtime on purpose
// — quest-indexer is a separate Railway deployable, and importing across that boundary
// would defeat the isolation it exists for. This test is the thing that makes the
// duplication safe.
//
// A divergence is a wrong-answer generator in both directions:
//
//   indexed but not required  → the freshness gate never waits on that source, so a wallet
//                               whose only activity today was there is told `completed:
//                               false` while its rows lag behind.
//   required but not indexed  → the gate waits forever on a watermark nobody writes, and
//                               daily_active is permanently stale. Safe, but useless.
//
// This is the ONLY test that imports across the deployable boundary, and only as a test —
// quest-indexer's own isolation suite asserts that no SHIPPED file does.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { DAILY_SOURCES, DAILY_SOURCE_ADDRESS_VARS } from "../../api/_lib/quest/dailySources.js";
// definitions.mjs, NOT sources.mjs: the latter imports ethers, which the frontend's test
// job does not install. Reaching for it here would make this suite un-runnable without the
// indexer's node_modules — the exact coupling two separate deployables should not have.
import { SOURCES, SOURCE_ADDRESS_VARS } from "../../../quest-indexer/lib/definitions.mjs";

describe("indexer and reader agree on the sources", () => {
  // Configuration is shared through the ENVIRONMENT rather than through code: both sides
  // resolve the same variable names, so a redeploy is one env change and both follow it.
  // If these sets drift, that mechanism is silently broken.
  test("the same env var names, in the same order", () => {
    assert.deepEqual(DAILY_SOURCE_ADDRESS_VARS, SOURCE_ADDRESS_VARS);
  });

  test("the same logical keys", () => {
    assert.deepEqual(
      DAILY_SOURCES.map((s) => s.key),
      SOURCES.map((s) => s.key),
    );
  });

  test("neither side has a source the other lacks", () => {
    const reader = new Set(DAILY_SOURCE_ADDRESS_VARS);
    const writer = new Set(SOURCE_ADDRESS_VARS);

    for (const v of writer) assert.ok(reader.has(v), `${v} is indexed but not required — its lag would go unnoticed`);
    for (const v of reader) assert.ok(writer.has(v), `${v} is required but never indexed — daily_active would never go fresh`);
  });

  test("no duplicates, which would make the required-count check meaningless", () => {
    assert.equal(new Set(DAILY_SOURCE_ADDRESS_VARS).size, DAILY_SOURCE_ADDRESS_VARS.length);
    assert.equal(new Set(SOURCE_ADDRESS_VARS).size, SOURCE_ADDRESS_VARS.length);
  });

  // Both factories are present on both sides. The superseded one is the likeliest to be
  // dropped by mistake — it is "draining" — and dropping it from either side is a wrong
  // answer for anyone who bet there today.
  test("both prediction factories are on both sides", () => {
    for (const list of [DAILY_SOURCE_ADDRESS_VARS, SOURCE_ADDRESS_VARS]) {
      assert.ok(list.includes("QUEST_PREDICTION_FACTORY_ADDRESS"));
      assert.ok(list.includes("QUEST_PREDICTION_FACTORY_OLD_ADDRESS"));
    }
  });
});

describe("the wallet field agrees on both sides", () => {
  // The indexer reads an indexed topic by position; the reader builds an ethers filter that
  // constrains the same parameter. If they picked different fields, the same wallet would
  // read active through one path and inactive through the other, depending only on how
  // recently it acted.
  const EXPECTED_TOPIC = {
    positionManager: 1, // PositionOpened(owner, ...)
    liquidityPool: 1, // Deposit(sender, owner, ...) — the payer
    predictionFactory: 2, // BetPlaced(marketId, better, ...) — marketId is indexed first
    predictionFactoryOld: 2,
  };

  test("the indexer's walletTopic matches the parameter the reader filters on", () => {
    for (const source of SOURCES) {
      assert.equal(source.walletTopic, EXPECTED_TOPIC[source.key], `${source.key} walletTopic`);
    }
  });

  // A filter's argument position is what determines which topic it constrains. Deposit and
  // PositionOpened take the wallet first; BetPlaced takes null then the wallet.
  test("the reader's filters constrain that same position", () => {
    const calls = [];
    const recorder = {
      filters: {
        PositionOpened: (...args) => calls.push(["positionManager", args]),
        Deposit: (...args) => calls.push(["liquidityPool", args]),
        BetPlaced: (...args) => calls.push(["betPlaced", args]),
      },
    };

    for (const source of DAILY_SOURCES) source.filter(recorder, "0xWALLET");

    // Index of the first non-null argument == the indexed-parameter slot being constrained.
    for (const [key, args] of calls) {
      const slot = args.findIndex((a) => a != null) + 1;
      const expected = key === "betPlaced" ? 2 : EXPECTED_TOPIC[key];
      assert.equal(slot, expected, `${key} filter constrains topic ${slot}, indexer reads ${expected}`);
    }
  });
});
