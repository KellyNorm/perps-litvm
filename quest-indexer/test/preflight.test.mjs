// The startup contract check.
//
// This closes the one failure the rest of the service cannot detect: a WELL-FORMED but
// WRONG address. It passes every validation, returns no logs forever, advances its
// watermark normally, reports itself perfectly fresh, and makes daily_active answer a
// confident false for every wallet. Nothing downstream can spot it, because a wrong
// address and a genuinely inactive chain produce identical data.
//
// So the only question these tests ask is: does the service ever start against an address
// it could not confirm holds contract code?

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { ConfigError, SOURCES } from "../lib/sources.mjs";
import { verifySourceContracts } from "../lib/preflight.mjs";

const ENV = {
  QUEST_POSITION_MANAGER_ADDRESS: "0x9396D36F713302FF39E0bA5b38012656f8E4eACF",
  QUEST_LIQUIDITY_POOL_ADDRESS: "0x4716a0c9c504F83918002A3086590f1ed192560B",
  QUEST_PREDICTION_FACTORY_ADDRESS: "0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512",
  QUEST_PREDICTION_FACTORY_OLD_ADDRESS: "0x6338985C7f689C3e1959bfe1a8bb36E44849EA40",
};

/** Every address has code unless it appears in `empty`. */
function codeFor({ empty = new Set(), throwsFor = new Set() } = {}) {
  const asked = [];
  const fn = async (address) => {
    asked.push(address);
    if (throwsFor.has(address.toLowerCase())) throw new Error("rpc unreachable");
    return empty.has(address.toLowerCase()) ? "0x" : "0x60806040" + "ab".repeat(100);
  };
  fn.asked = asked;
  return fn;
}

const verify = (over = {}) =>
  verifySourceContracts({ sources: SOURCES, env: ENV, getCode: codeFor(), ...over });

describe("the happy path", () => {
  test("passes when every address holds code, and reports the sizes", async () => {
    const out = await verify();

    assert.equal(out.length, 4);
    for (const entry of out) assert.ok(entry.bytes > 0, `${entry.source.key} should report a size`);
  });

  test("checks every source, once each, lower-cased", async () => {
    const getCode = codeFor();
    await verify({ getCode });

    assert.equal(getCode.asked.length, 4);
    assert.deepEqual(
      [...getCode.asked].sort(),
      Object.values(ENV).map((a) => a.toLowerCase()).sort(),
    );
  });
});

// ============================================================================
// THE POINT OF THE FILE.
// ============================================================================
describe("refuses to start", () => {
  test("when an address has NO CODE", async () => {
    const empty = new Set([ENV.QUEST_PREDICTION_FACTORY_ADDRESS.toLowerCase()]);

    await assert.rejects(() => verify({ getCode: codeFor({ empty }) }), /NO CONTRACT CODE/);
  });

  test("naming the env var and the address, so it is fixable from one log line", async () => {
    const empty = new Set([ENV.QUEST_LIQUIDITY_POOL_ADDRESS.toLowerCase()]);

    await assert.rejects(
      () => verify({ getCode: codeFor({ empty }) }),
      (err) => {
        assert.match(err.message, /QUEST_LIQUIDITY_POOL_ADDRESS/);
        assert.match(err.message, new RegExp(ENV.QUEST_LIQUIDITY_POOL_ADDRESS.toLowerCase()));
        return true;
      },
    );
  });

  // The message says WHY this matters, because "no code at address" alone does not convey
  // that the consequence is a confident false for every wallet.
  test("explaining the consequence, not just the fact", async () => {
    const empty = new Set([ENV.QUEST_POSITION_MANAGER_ADDRESS.toLowerCase()]);
    await assert.rejects(() => verify({ getCode: codeFor({ empty }) }), /confident false/);
  });

  test("for a null code response, not just the '0x' one", async () => {
    await assert.rejects(() => verify({ getCode: async () => null }), /NO CONTRACT CODE/);
  });

  // An operator who has just pasted four env vars should learn about all four mistakes in
  // one restart, not discover them serially across four crash loops.
  test("reporting EVERY bad address at once, not just the first", async () => {
    const empty = new Set([
      ENV.QUEST_LIQUIDITY_POOL_ADDRESS.toLowerCase(),
      ENV.QUEST_PREDICTION_FACTORY_OLD_ADDRESS.toLowerCase(),
    ]);

    await assert.rejects(
      () => verify({ getCode: codeFor({ empty }) }),
      (err) => {
        assert.match(err.message, /failed for 2 of 4 sources/);
        assert.match(err.message, /QUEST_LIQUIDITY_POOL_ADDRESS/);
        assert.match(err.message, /QUEST_PREDICTION_FACTORY_OLD_ADDRESS/);
        return true;
      },
    );
  });

  // A wrong address and an unreachable node are indistinguishable from here, and a service
  // that cannot reach its RPC has nothing to do anyway — so refusing loses nothing.
  test("when the check itself could not be completed", async () => {
    const throwsFor = new Set([ENV.QUEST_PREDICTION_FACTORY_ADDRESS.toLowerCase()]);

    await assert.rejects(() => verify({ getCode: codeFor({ throwsFor }) }), /could not verify/);
  });

  test("when the RPC is down entirely", async () => {
    await assert.rejects(
      () =>
        verify({
          getCode: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
      /failed for 4 of 4 sources/,
    );
  });
});

describe("ordering", () => {
  // No point probing the chain for something already known to be unusable — and the
  // ConfigError is the more actionable message.
  test("a malformed address fails before any RPC call is made", async () => {
    const getCode = codeFor();

    await assert.rejects(
      () => verify({ env: { ...ENV, QUEST_POSITION_MANAGER_ADDRESS: "0xdead" }, getCode }),
      ConfigError,
    );
    assert.equal(getCode.asked.length, 0, "config errors must short-circuit the probe");
  });

  test("a missing address fails before any RPC call is made", async () => {
    const getCode = codeFor();

    await assert.rejects(() => verify({ env: { ...ENV, QUEST_LIQUIDITY_POOL_ADDRESS: "" }, getCode }), ConfigError);
    assert.equal(getCode.asked.length, 0);
  });
});
