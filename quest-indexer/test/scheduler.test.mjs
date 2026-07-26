// The loop, and the one property that makes sharing a process safe: the backward settler
// can never be the reason the forward index is late or stale.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { DEFAULT_INTERVAL_MS, TICK_MARGIN_MS, runScheduler } from "../lib/scheduler.mjs";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

/** A clock that advances only when something asks it to, so tests never actually wait. */
function harness({ tickCost = 0 } = {}) {
  let t = 0;
  const slept = [];
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    spendTick: () => (t += tickCost),
  };
}

/** Stops after `n` ticks, so the loop terminates. */
function stopAfter(n) {
  let seen = 0;
  return { shouldStop: () => seen >= n, count: () => seen, bump: () => seen++ };
}

describe("the loop", () => {
  test("runs the tick each interval and stops when asked", async () => {
    const h = harness();
    const stop = stopAfter(3);

    const out = await runScheduler({
      tick: async () => {
        stop.bump();
        return { failed: 0 };
      },
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(out.ticks, 3);
  });

  // A throttled RPC call must not become a process restart: a restart re-reads all state
  // and re-does the work for nothing. Railway's policy is the backstop for a corrupt
  // process, not for one bad request.
  test("a throwing tick does not stop the loop", async () => {
    const h = harness();
    const stop = stopAfter(3);
    let attempts = 0;

    const out = await runScheduler({
      tick: async () => {
        stop.bump();
        attempts++;
        throw new Error("rpc down");
      },
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(attempts, 3, "kept ticking through the failures");
    assert.equal(out.ticks, 3);
  });

  test("gives the tick a deadline inside the interval", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);
    let seen;

    await runScheduler({
      tick: async ({ deadline }) => {
        stop.bump();
        // First tick only — later ones are offset by the intervals already elapsed.
        if (seen === undefined) seen = deadline;
        return { failed: 0 };
      },
      intervalMs: 60_000,
      marginMs: 5_000,
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(seen, 55_000, "the tick must be told to stop before the next one is due");
  });

  test("sleeps out the remainder of the interval", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);

    await runScheduler({
      tick: async () => {
        stop.bump();
        h.advance(10_000);
        return { failed: 0 };
      },
      intervalMs: 60_000,
      marginMs: 5_000,
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.deepEqual(h.slept, [45_000], "60s interval − 10s spent − 5s margin");
  });

  test("does not sleep when the tick used the whole interval", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);

    await runScheduler({
      tick: async () => {
        stop.bump();
        h.advance(90_000);
        return { failed: 0 };
      },
      intervalMs: 60_000,
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.deepEqual(h.slept, [], "a catching-up indexer goes straight round again");
  });

  test("checks for shutdown before starting the fill, so a stop is not delayed a full interval", async () => {
    const h = harness();
    let stopped = false;
    let filled = 0;

    await runScheduler({
      tick: async () => {
        stopped = true;
        return { failed: 0 };
      },
      fill: async () => {
        filled++;
      },
      shouldStop: () => stopped,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(filled, 0, "shutdown must not wait for a settler slice to finish");
  });
});

// ============================================================================
// THE PRIORITY PROPERTY. Job B never competes with Job A.
// ============================================================================
describe("forward index has priority", () => {
  test("the fill gets only the time left after the tick and the margin", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);
    let budget;

    await runScheduler({
      tick: async () => {
        stop.bump();
        h.advance(12_000);
        return { failed: 0 };
      },
      fill: async (ctx) => {
        budget = ctx.budgetMs;
      },
      intervalMs: 60_000,
      marginMs: 5_000,
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(budget, 43_000, "the settler is a leftover-time job, not a scheduled one");
  });

  // An unhealthy index is the one thing that can make the endpoint lie. The settler must
  // not spend the recovery window walking deep history.
  test("the fill is SKIPPED while the index is unhealthy", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);
    let filled = 0;

    await runScheduler({
      tick: async () => {
        stop.bump();
        return { failed: 1 }; // one source could not be indexed
      },
      fill: async () => {
        filled++;
      },
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(filled, 0, "the settler must not compete with fixing a stale index");
    assert.equal(h.slept.length, 1, "the time is waited out instead");
  });

  test("the fill is skipped after a THROWN tick too", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);
    let filled = 0;

    await runScheduler({
      tick: async () => {
        stop.bump();
        throw new Error("rpc down");
      },
      fill: async () => {
        filled++;
      },
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(filled, 0);
  });

  test("the fill runs when every source indexed cleanly", async () => {
    const h = harness();
    // Two ticks, not one: the loop checks for shutdown BEFORE the fill (asserted separately
    // below), so stopping after the first tick would skip the very thing under test.
    const stop = stopAfter(2);
    let filled = 0;

    await runScheduler({
      tick: async () => {
        stop.bump();
        return { failed: 0 };
      },
      fill: async () => {
        filled++;
      },
      shouldStop: stop.shouldStop,
      now: h.now,
      sleep: h.sleep,
    });

    assert.equal(filled, 1);
  });
});

describe("defaults", () => {
  // 15 missed ticks of slack against the read path's 15-minute freshness threshold.
  test("ticks every minute, well inside the freshness threshold", () => {
    assert.equal(DEFAULT_INTERVAL_MS, 60_000);
    assert.ok(DEFAULT_INTERVAL_MS * 3 < 15 * 60_000, "one missed tick must not trip the gate");
  });

  // Absorbs scanForEvent's documented one-chunk (~3.5s) overrun plus the writes after it.
  test("the margin covers a chunk overrun", () => {
    assert.ok(TICK_MARGIN_MS >= 3_500);
  });
});
