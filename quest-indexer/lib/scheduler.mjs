// The loop that shares one process between the two jobs.
//
// ============================================================================
// THE FORWARD INDEXER HAS ABSOLUTE PRIORITY. THIS IS NOT A TUNING CHOICE.
// ============================================================================
// The two jobs fail in categorically different ways:
//
//   Job A (forward index) falling behind → the freshness gate trips → `daily_active`
//       answers indeterminate. Recoverable, honest, and briefly annoying.
//   ...but Job A falling behind SILENTLY, or being starved by Job B, is how the watermark
//       ages out. And the whole reason the gate exists is that quest_daily's absence is an
//       answer.
//   Job B (backward settler) falling behind → deep one-time quests take longer to settle.
//       Nobody is told anything false; they are just told "not yet" for longer.
//
// So Job A runs first, every tick, unconditionally, and Job B only gets whatever time is
// left over. Job B can never be the reason Job A is late.
//
// THE FILL IS BOUNDED AND YIELDS. Job B works in slices sized to the time remaining before
// the next tick, minus a margin. It uses scanForEvent's existing timeBudgetMs rather than
// any new budgeting code — and because that scanner never abandons an in-flight chunk, the
// worst-case overrun is one chunk (~3.5s), which is what the margin absorbs.
//
// ERRORS ARE CONTAINED. A failed tick logs and the loop continues. Crashing would hand the
// problem to Railway's restart policy, which is the right backstop for a corrupt process
// but the wrong response to one throttled RPC call: a restart re-reads all state, re-does
// the work, and buys nothing. Config errors are different and are thrown at STARTUP, before
// the loop begins, so a misconfigured service dies loudly instead of running forever doing
// nothing.

/** One minute. Well inside the 15-minute freshness threshold — 15 missed ticks of slack. */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Reserved at the end of every interval. Covers scanForEvent's documented one-chunk
 * overrun plus the writes that follow it, so the next tick starts on time.
 */
export const TICK_MARGIN_MS = 5_000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} args
 * @param {(ctx: {deadline: number}) => Promise<any>} args.tick   Job A. Gets a deadline so
 *   it can stop starting new sources rather than overrun the interval.
 * @param {(ctx: {budgetMs: number, healthy: boolean}) => Promise<any>} [args.fill]  Job B.
 *   Defaults to sleeping out the remainder. `healthy` is false after a failed tick, which
 *   is the priority-inversion guard: the settler must not consume time while the index is
 *   in trouble.
 * @param {() => boolean} args.shouldStop
 */
export async function runScheduler({
  tick,
  fill = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  marginMs = TICK_MARGIN_MS,
  now = () => Date.now(),
  sleep = realSleep,
  shouldStop = () => false,
  onError = (err) => console.error("[scheduler] tick failed, continuing:", err?.message),
  onTick = () => {},
} = {}) {
  let ticks = 0;

  while (!shouldStop()) {
    const started = now();
    let healthy = true;

    try {
      // The deadline leaves the margin AND whatever the fill will want; Job A is small in
      // the steady state (a few thousand blocks across four sources) and only approaches
      // this while catching up.
      const result = await tick({ deadline: started + Math.max(0, intervalMs - marginMs) });
      healthy = !result || result.failed === 0;
      onTick(result);
    } catch (err) {
      healthy = false;
      onError(err);
    }

    ticks++;
    if (shouldStop()) break;

    const remaining = intervalMs - (now() - started) - marginMs;
    if (remaining <= 0) continue; // the tick used the whole interval; go straight round again

    // PRIORITY INVERSION GUARD. While the index is unhealthy, the leftover time is spent
    // waiting rather than settling: an unhealthy index is the one thing that can make the
    // endpoint lie, and Job B must never compete with fixing it.
    if (fill && healthy) await fill({ budgetMs: remaining, healthy });
    else await sleep(remaining);
  }

  return { ticks };
}
