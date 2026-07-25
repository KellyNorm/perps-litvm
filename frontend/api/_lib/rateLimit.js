// Rate limiter, sitting in front of the Gemini call to protect the API quota.
//
// PRE-MAINNET TODO — KNOWN LIMITATION OF THE MEMORY DRIVER:
// Vercel functions are stateless and horizontally scaled, so `memoryDriver` counts hits
// per lambda INSTANCE, not globally. Under concurrent instances a determined abuser
// gets roughly N× the nominal limit. That is an accepted v1 trade-off: the goal here is
// stopping casual spam and runaway client loops on a testnet app with no money path,
// not defending funds. Before any real-money surface, swap in a durable driver.
//
// The swap is why `driver` is an injected interface and why `check()` is async even
// though the memory driver is synchronous — a Redis/KV driver is one new file
// implementing { read, write }, with no change to this module or the handler.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Bounds memory for the in-process driver. Well above any plausible warm-instance
// working set; exists so a burst of unique IPs can't grow the Map without limit.
const MAX_TRACKED_KEYS = 10_000;

export function memoryDriver() {
  const hits = new Map(); // key -> number[] of request timestamps (ms)

  return {
    async read(key) {
      return hits.get(key) ?? [];
    },

    async write(key, timestamps) {
      hits.set(key, timestamps);

      if (hits.size > MAX_TRACKED_KEYS) {
        // Drop keys whose most recent hit has aged out of the longest window; they can
        // no longer affect any decision.
        const cutoff = Date.now() - HOUR_MS;
        for (const [k, stamps] of hits) {
          if (!stamps.length || stamps[stamps.length - 1] < cutoff) hits.delete(k);
        }
      }
    },

    // Test seam.
    _size: () => hits.size,
  };
}

// `now` is injectable so window-expiry can be tested deterministically instead of with
// a sleep.
export function createLimiter({ driver, perMinute, perHour, now = () => Date.now() }) {
  return {
    async check(key) {
      const t = now();

      // Anything older than the longest window is irrelevant; dropping it here is also
      // what keeps a single key's array bounded.
      const stamps = (await driver.read(key)).filter((s) => t - s < HOUR_MS);

      const minuteStamps = stamps.filter((s) => t - s < MINUTE_MS);

      if (minuteStamps.length >= perMinute) {
        return {
          allowed: false,
          scope: "minute",
          retryAfter: secondsUntilFree(minuteStamps[0], t, MINUTE_MS),
        };
      }

      if (stamps.length >= perHour) {
        return {
          allowed: false,
          scope: "hour",
          retryAfter: secondsUntilFree(stamps[0], t, HOUR_MS),
        };
      }

      // Recorded only on the allowed path, so a blocked caller can't extend their own
      // penalty by hammering — the window still drains on schedule.
      stamps.push(t);
      await driver.write(key, stamps);

      return {
        allowed: true,
        remainingMinute: perMinute - minuteStamps.length - 1,
        remainingHour: perHour - stamps.length,
      };
    },
  };
}

// When the oldest hit in the window ages out, a slot frees. Always >= 1 so a
// Retry-After header is never 0.
function secondsUntilFree(oldest, now, windowMs) {
  return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
}
