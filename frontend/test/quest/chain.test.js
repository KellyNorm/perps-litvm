// Chain-access config and key derivation. No network: everything here is either env
// handling or a pure hash.

import assert from "node:assert/strict";
import test, { afterEach, describe } from "node:test";

import {
  ConfigError,
  addresses,
  chainId,
  marketKey,
  positionKey,
  rpcUrl,
  _resetProvider,
} from "../../api/_lib/quest/chain.js";

const ADDRESS = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";
const PM = "0x9396D36F713302FF39E0bA5b38012656f8E4eACF";

const ENV_KEYS = ["QUEST_POSITION_MANAGER_ADDRESS", "QUEST_CHAIN_ID", "QUEST_RPC_URL"];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetProvider();
});

describe("contract addresses", () => {
  // Same rule the frontend enforces since the fallback removal: an address that defaults
  // is correct only until the next redeploy, and the superseded contract keeps answering.
  test("throws a ConfigError naming the variable when unset", () => {
    assert.throws(() => addresses.positionManager(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /QUEST_POSITION_MANAGER_ADDRESS/);
      return true;
    });
  });

  test("throws on a malformed address rather than passing it to ethers", () => {
    process.env.QUEST_POSITION_MANAGER_ADDRESS = "0xdead";
    assert.throws(() => addresses.positionManager(), /not a valid address/);
  });

  test("returns a configured address, trimmed", () => {
    process.env.QUEST_POSITION_MANAGER_ADDRESS = `  ${PM}  `;
    assert.equal(addresses.positionManager(), PM);
  });

  // ConfigError is a distinct type because the handler maps it to a distinct 503 reason:
  // "we are misconfigured" needs a different fix from "the RPC is down".
  test("ConfigError is distinguishable from an ordinary Error", () => {
    const err = new ConfigError("x");
    assert.ok(err instanceof ConfigError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ConfigError");
  });
});

describe("network config", () => {
  test("chain id defaults to LiteForge and honours an override", () => {
    assert.equal(chainId(), 4441);
    process.env.QUEST_CHAIN_ID = "1";
    assert.equal(chainId(), 1);
  });

  test("a junk chain id falls back rather than yielding NaN", () => {
    process.env.QUEST_CHAIN_ID = "not-a-number";
    assert.equal(chainId(), 4441);
  });

  // Unlike the addresses, the RPC URL DOES default: it carries no contract identity, and
  // a wrong endpoint fails loudly against the pinned chain id instead of answering about
  // the wrong contract.
  test("rpc url defaults to the public LiteForge endpoint", () => {
    assert.match(rpcUrl(), /^https:\/\//);
    process.env.QUEST_RPC_URL = "https://example.invalid/rpc";
    assert.equal(rpcUrl(), "https://example.invalid/rpc");
  });
});

describe("key derivation", () => {
  // bytes32("BTC") — left-aligned, right-zero-padded ASCII, as PositionManager.sol
  // encodes MARKET_BTC.
  test("marketKey matches the contract's bytes32 encoding", () => {
    assert.equal(marketKey("BTC"), "0x4254430000000000000000000000000000000000000000000000000000000000");
    assert.equal(marketKey("ETH"), "0x4554480000000000000000000000000000000000000000000000000000000000");
  });

  // GOLDEN VALUE, verified against the DEPLOYED contract on 2026-07-25:
  //   cast call 0x9396D36F…eACF "getPositionKey(address,bytes32,bool)(bytes32)" \
  //     0xE9Dd…2292 0x4254430000…0000 true
  //   → 0xc371c03ddba3a65883c7803e24f2e0d358b57e534cec8276cf9d8d7a60ca0df9
  // This is the check that matters: the key is derived locally to save a round trip, so a
  // silent disagreement with getPositionKey would read as "no position" — a false
  // negative on a quest, which is exactly the failure mode we refuse to ship.
  test("positionKey matches the live contract's getPositionKey", () => {
    assert.equal(
      positionKey(ADDRESS, marketKey("BTC"), true),
      "0xc371c03ddba3a65883c7803e24f2e0d358b57e534cec8276cf9d8d7a60ca0df9",
    );
  });

  test("long and short are different positions", () => {
    const long = positionKey(ADDRESS, marketKey("BTC"), true);
    const short = positionKey(ADDRESS, marketKey("BTC"), false);
    assert.notEqual(long, short);
  });

  test("markets and owners do not collide", () => {
    const btc = positionKey(ADDRESS, marketKey("BTC"), true);
    const eth = positionKey(ADDRESS, marketKey("ETH"), true);
    const other = positionKey("0x0000000000000000000000000000000000000001", marketKey("BTC"), true);

    assert.notEqual(btc, eth);
    assert.notEqual(btc, other);
  });
});
