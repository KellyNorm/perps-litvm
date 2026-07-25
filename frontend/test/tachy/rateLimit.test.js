import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createLimiter, memoryDriver } from "../../api/_lib/rateLimit.js";

// Time is injected so window expiry is tested deterministically rather than with sleeps.
function limiterAt(clock, { perMinute = 3, perHour = 10 } = {}) {
  return createLimiter({ driver: memoryDriver(), perMinute, perHour, now: () => clock.t });
}

describe("rate limiter", () => {
  test("allows up to the per-minute cap, then blocks", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 3; i++) {
      const v = await limiter.check("1.1.1.1");
      assert.equal(v.allowed, true, `request ${i + 1} should be allowed`);
    }

    const blocked = await limiter.check("1.1.1.1");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.scope, "minute");
    assert.ok(blocked.retryAfter >= 1, "Retry-After is never zero");
  });

  test("frees a slot once the minute window slides past", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 3; i++) await limiter.check("2.2.2.2");
    assert.equal((await limiter.check("2.2.2.2")).allowed, false);

    clock.t = 60_001; // oldest hit has aged out
    assert.equal((await limiter.check("2.2.2.2")).allowed, true);
  });

  test("keys are independent — one caller cannot limit another", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 3; i++) await limiter.check("3.3.3.3");
    assert.equal((await limiter.check("3.3.3.3")).allowed, false);
    assert.equal((await limiter.check("4.4.4.4")).allowed, true, "different IP unaffected");
  });

  test("enforces the hourly cap even when minute windows keep resetting", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock, { perMinute: 2, perHour: 5 });

    let allowed = 0;
    // Step a minute at a time so the per-minute window is never the binding constraint.
    for (let minute = 0; minute < 10; minute++) {
      clock.t = minute * 60_001;
      for (let i = 0; i < 2; i++) {
        if ((await limiter.check("5.5.5.5")).allowed) allowed++;
      }
    }

    assert.equal(allowed, 5, "hourly cap holds across minute resets");
    const v = await limiter.check("5.5.5.5");
    assert.equal(v.allowed, false);
    assert.equal(v.scope, "hour");
  });

  test("blocked requests do not extend the penalty window", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 3; i++) await limiter.check("6.6.6.6");
    // Hammer while blocked. If these were recorded, the window would keep sliding
    // forward and the caller could never recover.
    clock.t = 30_000;
    for (let i = 0; i < 20; i++) await limiter.check("6.6.6.6");

    clock.t = 60_001;
    assert.equal((await limiter.check("6.6.6.6")).allowed, true, "drains on schedule");
  });

  test("retryAfter shrinks as the window drains", async () => {
    const clock = { t: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i++) await limiter.check("7.7.7.7");

    const early = await limiter.check("7.7.7.7");
    clock.t = 45_000;
    const late = await limiter.check("7.7.7.7");

    assert.ok(late.retryAfter < early.retryAfter, "counts down toward the window edge");
  });
});
