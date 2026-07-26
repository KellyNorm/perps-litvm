// The source descriptors, and the two mistakes that would each produce a systematically
// wrong `daily_active` answer:
//
//   1. A filter that constrains a wallet — the index advances its watermark normally while
//      being empty for everyone except one address. Every other user gets a confident false.
//   2. The wrong walletTopic — BetPlaced's `better` is topic 2, not 1, because marketId is
//      indexed first. Reading topic 1 would parse a market id as an address.
//
// Fully offline: no provider, no network.

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ethers } from "ethers";

import {
  ConfigError,
  SOURCES,
  SOURCE_ADDRESS_VARS,
  allWalletsFilter,
  eventTopic,
  sourceAddress,
  walletFilter,
  walletFromLog,
} from "../lib/sources.mjs";

const ADDRESS = "0x9396D36F1B7B4Bd8dC9C0Bd8dC9c0bD8dC9C0bD8";
const WALLET = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";

const byKey = (key) => SOURCES.find((s) => s.key === key);

/** A log whose `topics[at]` carries `wallet`, padded exactly as a real indexed address is. */
function logWith(at, wallet, { blockNumber = 100 } = {}) {
  const topics = new Array(at + 1).fill("0x" + "11".repeat(32));
  topics[0] = "0x" + "aa".repeat(32);
  topics[at] = ethers.utils.hexZeroPad(ethers.utils.getAddress(wallet), 32);
  return { blockNumber, topics };
}

describe("the source list", () => {
  test("covers exactly the four streams daily_active aggregates", () => {
    assert.deepEqual(
      SOURCES.map((s) => s.key),
      ["positionManager", "liquidityPool", "predictionFactory", "predictionFactoryOld"],
    );
  });

  // The superseded factory is indexed on purpose: a bet placed there before the 2026-07-22
  // redeploy is real activity, and dropping it would make a wallet whose only action that
  // day was on the old factory look inactive.
  test("still indexes the draining 24h factory", () => {
    assert.ok(byKey("predictionFactoryOld"));
  });

  test("resolves addresses from the same env var names the read path uses", () => {
    assert.deepEqual(SOURCE_ADDRESS_VARS, [
      "QUEST_POSITION_MANAGER_ADDRESS",
      "QUEST_LIQUIDITY_POOL_ADDRESS",
      "QUEST_PREDICTION_FACTORY_ADDRESS",
      "QUEST_PREDICTION_FACTORY_OLD_ADDRESS",
    ]);
  });
});

describe("wallet topic positions", () => {
  // THE CLASSIC BUG. marketId is BetPlaced's first indexed parameter, so `better` is topic 2.
  test("BetPlaced takes the wallet from topic 2, not topic 1", () => {
    assert.equal(byKey("predictionFactory").walletTopic, 2);
    assert.equal(byKey("predictionFactoryOld").walletTopic, 2);
  });

  test("PositionOpened and Deposit take the wallet from topic 1", () => {
    assert.equal(byKey("positionManager").walletTopic, 1);
    assert.equal(byKey("liquidityPool").walletTopic, 1);
  });

  // Deposit credits `sender` (who paid), not `owner` (who received the shares) — matching
  // provideLiquidityTier2. Depositing on someone else's behalf credits the payer.
  test("Deposit's topic 1 is sender, the payer", () => {
    assert.ok(byKey("liquidityPool").event.startsWith("event Deposit(address indexed sender,"));
  });
});

describe("allWalletsFilter", () => {
  // If this filter ever constrained an indexed parameter, the index would be empty for
  // every wallet but one while reporting itself perfectly fresh.
  test("carries exactly one topic, so it cannot constrain a wallet", () => {
    for (const source of SOURCES) {
      const filter = allWalletsFilter(source, { address: ADDRESS, fromBlock: 1, toBlock: 2 });
      assert.equal(filter.topics.length, 1, `${source.key} filter must be topic0 only`);
      assert.equal(filter.topics[0], eventTopic(source));
    }
  });

  test("takes no wallet argument at all", () => {
    // The signature is (descriptor, {address, fromBlock, toBlock}) — there is nowhere to
    // pass an address even by mistake.
    const filter = allWalletsFilter(byKey("liquidityPool"), { address: ADDRESS, fromBlock: 5, toBlock: 9 });
    assert.deepEqual(Object.keys(filter).sort(), ["address", "fromBlock", "toBlock", "topics"]);
  });

  test("both factories share one topic0 — same event, two addresses", () => {
    assert.equal(eventTopic(byKey("predictionFactory")), eventTopic(byKey("predictionFactoryOld")));
  });

  test("different events have different topic0", () => {
    const topics = new Set(SOURCES.map(eventTopic));
    assert.equal(topics.size, 3, "PositionOpened, Deposit, BetPlaced — the factories share one");
  });
});

describe("walletFilter — the per-wallet form of the same descriptor", () => {
  test("BetPlaced produces [topic0, null, wallet], matching the read path's filter", () => {
    const filter = walletFilter(byKey("predictionFactory"), {
      address: ADDRESS,
      wallet: WALLET,
      fromBlock: 1,
      toBlock: 2,
    });

    assert.equal(filter.topics.length, 3);
    assert.equal(filter.topics[0], eventTopic(byKey("predictionFactory")));
    assert.equal(filter.topics[1], null, "marketId must stay unconstrained");
    assert.equal(filter.topics[2], ethers.utils.hexZeroPad(ethers.utils.getAddress(WALLET), 32));
  });

  test("Deposit produces [topic0, wallet]", () => {
    const filter = walletFilter(byKey("liquidityPool"), { address: ADDRESS, wallet: WALLET, fromBlock: 1, toBlock: 2 });
    assert.equal(filter.topics.length, 2);
    assert.equal(filter.topics[1], ethers.utils.hexZeroPad(ethers.utils.getAddress(WALLET), 32));
  });

  // Both filters come from ONE descriptor, so the index and the tail scan cannot end up
  // crediting different events or different fields.
  test("shares topic0 with the all-wallets form", () => {
    for (const source of SOURCES) {
      const all = allWalletsFilter(source, { address: ADDRESS, fromBlock: 1, toBlock: 2 });
      const one = walletFilter(source, { address: ADDRESS, wallet: WALLET, fromBlock: 1, toBlock: 2 });
      assert.equal(all.topics[0], one.topics[0], source.key);
    }
  });
});

describe("walletFromLog", () => {
  test("extracts the wallet from the descriptor's topic", () => {
    for (const source of SOURCES) {
      const log = logWith(source.walletTopic, WALLET);
      assert.equal(walletFromLog(source, log), WALLET.toLowerCase(), source.key);
    }
  });

  // quest_daily's `wallet = lower(wallet)` CHECK would 400 the ENTIRE batch on one
  // checksummed value, taking every other wallet's row in the range with it.
  test("lower-cases, because the table CHECK would reject the whole batch otherwise", () => {
    const out = walletFromLog(byKey("positionManager"), logWith(1, WALLET));
    assert.equal(out, out.toLowerCase());
    assert.notEqual(WALLET, WALLET.toLowerCase(), "the fixture must actually be checksummed");
  });

  // Reading BetPlaced's marketId as a wallet is exactly what a wrong walletTopic does. A
  // small integer in a topic has a non-zero-prefixed... no: it has a ZERO prefix and a tiny
  // value, so the shape check alone would pass it. A LARGE indexed value is what this
  // catches — and the topic-position tests above are what catch the small-id case.
  test("refuses a topic that is not address-shaped", () => {
    const source = byKey("predictionFactory");
    const log = { blockNumber: 7, topics: ["0x" + "aa".repeat(32), null, "0x" + "ff".repeat(32)] };
    assert.throws(() => walletFromLog(source, log), /not address-shaped/);
  });

  // THROWS, never returns null. A log we cannot resolve must fail the run: skipping it while
  // advancing the watermark leaves a permanent hole under a watermark claiming to cover it.
  test("throws on a missing or malformed topic rather than returning null", () => {
    const source = byKey("positionManager");
    assert.throws(() => walletFromLog(source, { blockNumber: 1, topics: ["0xaa"] }), /no usable topic/);
    assert.throws(() => walletFromLog(source, { blockNumber: 1, topics: [] }), /no usable topic/);
    assert.throws(() => walletFromLog(source, { blockNumber: 1 }), /no usable topic/);
    assert.throws(() => walletFromLog(source, null), /no usable topic/);
    assert.throws(() => walletFromLog(source, { blockNumber: 1, topics: ["0xaa", "0xdeadbeef"] }), /no usable topic/);
  });

  test("names the source and block, so a bad run is diagnosable from one log line", () => {
    assert.throws(() => walletFromLog(byKey("liquidityPool"), { blockNumber: 4242, topics: ["0xaa"] }), /LiquidityPool.*4242/s);
  });
});

describe("sourceAddress", () => {
  test("reads the descriptor's env var and lower-cases it", () => {
    const env = { QUEST_LIQUIDITY_POOL_ADDRESS: ADDRESS };
    assert.equal(sourceAddress(byKey("liquidityPool"), env), ADDRESS.toLowerCase());
  });

  // No defaults, deliberately: a hardcoded address is correct only until the next redeploy,
  // and a superseded contract keeps answering calls — the indexer would report itself fresh
  // while indexing a contract nobody uses.
  test("throws rather than defaulting when unset", () => {
    assert.throws(() => sourceAddress(byKey("positionManager"), {}), ConfigError);
    assert.throws(() => sourceAddress(byKey("positionManager"), { QUEST_POSITION_MANAGER_ADDRESS: "  " }), ConfigError);
  });

  test("throws on a malformed address rather than indexing nothing", () => {
    assert.throws(() => sourceAddress(byKey("positionManager"), { QUEST_POSITION_MANAGER_ADDRESS: "0xdead" }), ConfigError);
  });
});
