// quest-indexer entrypoint.
//
// A THIRD Railway service, deliberately separate from the perp keeper and the prediction
// keeper. It exists as its own process so that a crash, hang or OOM here cannot touch the
// services that run the live money path — a shared process could not guarantee that.
//
// READ-ONLY ON CHAIN, writes only to Supabase. There is no signer anywhere in this service
// and it must never acquire one; test/isolation.test.mjs enforces that over the shipped
// code, along with the full list of env vars it is allowed to read.
//
// Two jobs, one loop, forward index first — see lib/scheduler.mjs for why that ordering is
// a correctness property rather than a preference. Job B (the backward settler) is not
// wired yet; until it is, the leftover time in each interval is simply slept away.
//
// CONFIG ERRORS KILL THE PROCESS AT STARTUP, before the loop begins. A service that runs
// forever indexing nothing is worse than one that is visibly dead: the watermark it never
// advances eventually reads as stale, which is safe, but nothing says why.

import { chainId, getBlock, getCode, getLogs, headBlock } from "./lib/chain.mjs";
import { runIndexer, confirmations, maxRangeBlocks } from "./lib/indexer.mjs";
import { backfillChunkBlocks, runBackfill } from "./lib/backfill.mjs";
import { runSettler } from "./lib/settler.mjs";
import { DEFAULT_INTERVAL_MS, runScheduler } from "./lib/scheduler.mjs";
import { verifySourceContracts } from "./lib/preflight.mjs";
import { SOURCES, sourceAddress } from "./lib/sources.mjs";
import { createSupabaseWriter } from "./lib/supabase.mjs";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const chain = chainId();

  // Fail fast and loudly. Both of these throw on misconfiguration: the writer if the
  // Supabase env is incomplete, sourceAddress if any contract address is missing or
  // malformed. Doing it here means the process never reaches the loop in a state where it
  // would silently index nothing.
  const writer = createSupabaseWriter();
  for (const source of SOURCES) sourceAddress(source);

  // The last thing that can still be wrong after config parses: a well-formed address
  // pointing at nothing. Indexing it would return no logs forever while the watermark
  // advanced normally — a fresh-looking, permanently empty index handing out confident
  // falses. One eth_getCode per source settles it, and refusing to start is the safe
  // outcome: a dead indexer reads as stale, which reads as indeterminate.
  await verifySourceContracts({ sources: SOURCES, getCode, log: (m) => console.log(m) });

  const intervalMs = positiveInt(process.env.QUEST_INDEXER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  // Kill switch. Turning the settler off costs only settlement speed — deep quests go back
  // to needing user polls — and can never affect correctness.
  const settlerEnabled = (process.env.QUEST_SETTLER_ENABLED ?? "true").trim() !== "false";
  // Likewise a speed-only switch, and the reason it is safe is worth stating: the backfill
  // writes positives and coverage, and the read path refuses to derive a negative until the
  // coverage reaches the floor. Turning this off leaves one-time quests answering exactly as
  // they do today — via the settler and user polls — and can never produce a wrong answer.
  //
  // NOTE the contrast with the forward COMPLETION write in indexer.mjs, which has no switch
  // at all: that one is inside the contiguous range [completion_from .. last_block], so
  // toggling it would punch an undetectable hole. This one is a whole separate interval, so
  // stopping it simply leaves the interval short.
  const backfillEnabled = (process.env.QUEST_BACKFILL_ENABLED ?? "true").trim() !== "false";

  console.log(
    `[indexer] starting — chain ${chain}, ${SOURCES.length} sources, every ${intervalMs}ms, ` +
      `trailing head by ${confirmations()} blocks, ≤${maxRangeBlocks()} blocks/source/run, ` +
      `backfill ${backfillEnabled ? `on (${backfillChunkBlocks()} blocks/chunk)` : "off"}, ` +
      `settler ${settlerEnabled ? "on" : "off"}`,
  );

  // Once every source has reached its floor there is nothing left to sweep, and re-planning
  // it every tick would be one Supabase read a minute forever. Memoised in the PROCESS, not
  // in the database, so a redeploy re-checks — which is what makes a changed floor (a
  // contract redeploy, which changes env and therefore restarts this service anyway) start a
  // fresh pass rather than being masked by the memo.
  let backfillComplete = false;

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    // Graceful: the in-flight tick finishes, so a shutdown never lands between the rows
    // write and the watermark advance. That ordering is the whole safety story (indexer.mjs)
    // and it must survive a deploy.
    console.log(`[indexer] ${signal} received, finishing the current tick then exiting`);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await runScheduler({
    intervalMs,
    shouldStop: () => stopping,

    async tick({ deadline }) {
      const head = await headBlock();
      const report = await runIndexer({ writer, sources: SOURCES, chainId: chain, head, getLogs, getBlock, deadline });

      const summary = report.sources
        .map((s) => (s.error ? `${s.key}:ERR` : s.idle ? `${s.key}:idle` : s.skipped ? `${s.key}:skip` : `${s.key}:${s.to}(+${s.rows})`))
        .join(" ");
      console.log(`[indexer] head ${head} — ${summary}`);

      return report;
    },

    // JOBS C AND B, in that order. The scheduler only calls this when the forward index is
    // both error-free and caught up to the safe head — see lib/scheduler.mjs. Job A can
    // never be late because of anything in here.
    //
    // C BEFORE B, and it takes the WHOLE slice while it has work. The backfill is what makes
    // the settler redundant: one unfiltered pass settles every wallet at once, where the
    // settler walks one wallet at a time. Splitting the budget between them would slow the
    // thing that ends the problem in order to speed up the thing it replaces.
    fill:
      backfillEnabled || settlerEnabled
        ? async ({ budgetMs }) => {
            const startedAt = Date.now();

            if (backfillEnabled && !backfillComplete) {
              try {
                const head = await headBlock();
                const out = await runBackfill({ writer, sources: SOURCES, chainId: chain, head, budgetMs, getLogs });

                if (out.complete) {
                  backfillComplete = true;
                  console.log(
                    "[backfill] COMPLETE — every source swept to its floor. The read path can " +
                      "derive a proven negative once the watermarks are verified.",
                  );
                } else if (out.chunks > 0) {
                  console.log(
                    `[backfill] ${out.chunks} chunks, ${out.completions} completions, reason=${out.reason}`,
                  );
                }

                // The slice is spent unless the sweep finished early; fall through to the
                // settler only with what is genuinely left.
                if (!out.complete) return;
              } catch (err) {
                // Contained, like the settler: this is opportunistic background work and must
                // never take down the loop that keeps daily_active honest.
                console.error("[backfill] slice failed, continuing:", err?.message);
                return;
              }
            }

            if (!settlerEnabled) return;

            const remaining = budgetMs - (Date.now() - startedAt);
            if (remaining <= 0) return;

            try {
              const out = await runSettler({ writer, chainId: chain, budgetMs: remaining, getLogs });
              if (out.worked || out.found || out.extended) {
                console.log(`[settler] ${JSON.stringify(out)}`);
              }
            } catch (err) {
              console.error("[settler] slice failed, continuing:", err?.message);
            }
          }
        : null,
  });

  console.log("[indexer] stopped cleanly");
}

main().catch((err) => {
  // Startup failures and anything the scheduler could not contain. Exit non-zero so
  // Railway's ON_FAILURE policy restarts us — and so a config error is visible as a crash
  // loop rather than as a service that is up and doing nothing.
  console.error("[indexer] fatal:", err?.stack || err?.message || err);
  process.exit(1);
});
