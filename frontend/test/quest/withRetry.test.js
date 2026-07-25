// The ported retry helper. The classifier is the part that matters: a transport blip must
// be retried, and a genuine contract revert must NOT be — retrying a revert just repeats
// it, slower, and burns the invocation's time budget.
//
// Sleeps are injected, so this suite never actually waits.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isTransientRpcError, withRetry } from "../../api/_lib/chain/withRetry.js";

const noSleep = async () => {};

describe("transient classification", () => {
  test("treats transport failures as transient", () => {
    assert.equal(isTransientRpcError({ code: "NETWORK_ERROR" }), true);
    assert.equal(isTransientRpcError({ code: "SERVER_ERROR" }), true);
    assert.equal(isTransientRpcError({ code: "TIMEOUT" }), true);
    assert.equal(isTransientRpcError({ error: { code: "SERVER_ERROR" } }), true);
    assert.equal(isTransientRpcError({ message: "missing response" }), true);
    assert.equal(isTransientRpcError({ message: "could not detect network" }), true);
  });

  // ethers v5 dresses a dropped eth_call up as a CALL_EXCEPTION. The distinguishing
  // feature is that a REAL revert carries a reason or non-empty data.
  test("a CALL_EXCEPTION with no reason and empty data is a dropped call", () => {
    assert.equal(isTransientRpcError({ code: "CALL_EXCEPTION", data: "0x" }), true);
    assert.equal(isTransientRpcError({ code: "CALL_EXCEPTION", reason: "missing revert data" }), true);
  });

  test("a CALL_EXCEPTION carrying a real revert is NOT retried", () => {
    assert.equal(isTransientRpcError({ code: "CALL_EXCEPTION", reason: "BelowMinBet" }), false);
    assert.equal(isTransientRpcError({ code: "CALL_EXCEPTION", data: "0x08c379a0" }), false);
  });

  test("null and ordinary errors are not transient", () => {
    assert.equal(isTransientRpcError(null), false);
    assert.equal(isTransientRpcError(new Error("boom")), false);
  });
});

describe("retry behaviour", () => {
  test("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { sleepFn: noSleep },
    );

    assert.equal(out, "ok");
    assert.equal(calls, 1);
  });

  test("retries a transient failure and returns the eventual success", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw { code: "SERVER_ERROR" };
        return "recovered";
      },
      { sleepFn: noSleep },
    );

    assert.equal(out, "recovered");
    assert.equal(calls, 3);
  });

  test("gives up after `attempts` and rethrows the last error", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw { code: "TIMEOUT" };
        },
        { attempts: 3, sleepFn: noSleep },
      ),
      (err) => err.code === "TIMEOUT",
    );

    assert.equal(calls, 3);
  });

  test("throws a non-transient error on the first attempt", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("BelowMinBet");
        },
        { sleepFn: noSleep },
      ),
      /BelowMinBet/,
    );

    assert.equal(calls, 1, "a real revert must not be retried");
  });

  test("backs off exponentially", async () => {
    const waits = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw { code: "TIMEOUT" };
        },
        { attempts: 4, baseMs: 100, sleepFn: async (ms) => waits.push(ms) },
      ),
    );

    assert.deepEqual(waits, [100, 200, 400]);
  });
});
