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

  console.log(
    `[indexer] starting — chain ${chain}, ${SOURCES.length} sources, every ${intervalMs}ms, ` +
      `trailing head by ${confirmations()} blocks, ≤${maxRangeBlocks()} blocks/source/run`,
  );

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

    // Job B lands here in sequencing step 5: a bounded settler slice sized to `budgetMs`,
    // run only when the index is healthy. Until then the remainder is slept away.
    fill: null,
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
