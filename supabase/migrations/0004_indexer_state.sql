-- Phase 2, step 4 — the forward indexer's watermark, and the freshness proof that makes
-- quest_daily safe to read.
--
-- Two jobs, and the second one is the important one:
--
--   1. Tell the cron where to resume, so each run indexes only new blocks.
--   2. Prove the index is CURRENT. quest_daily answers by absence, so a stale index would
--      turn every wallet into a silent `completed: false`. This table is the only thing
--      that can distinguish "indexed, and this wallet did nothing" from "not indexed".
--      Read it BEFORE quest_daily, every time, and answer INDETERMINATE (`indexer_stale`)
--      if any required source is behind — see 0003.
--
-- ONE ROW PER SOURCE CONTRACT, not one per quest. daily_active aggregates four event
-- streams across four addresses:
--
--   PositionOpened  <- PositionManager        0x9396D36F…
--   Deposit         <- LiquidityPool          0x4716a0c9…   (filtered on `sender`, matching
--                                                             provideLiquidityTier2)
--   BetPlaced       <- prediction factory 8h  0x7dd9e01f…   (live)
--   BetPlaced       <- prediction factory 24h 0x6338985C…   (superseded 2026-07-22, still
--                                                             indexed: activity there is
--                                                             real activity)
--
-- They advance independently, so freshness is MIN(last_block) across the required sources,
-- not an average and not any single row. One lagging source makes the whole answer stale —
-- the conservative direction, and the correct one: a wallet whose only activity today was
-- a bet must not be reported inactive because the factory indexer alone fell behind.
--
-- Keyed by address for the same reason as quest_cursor: a redeploy introduces a new
-- address with no row, which reads as "never indexed" rather than silently inheriting a
-- watermark from a different contract.
--
-- REORG SAFETY. last_block must trail the chain head by a small confirmation margin
-- (QUEST_INDEXER_CONFIRMATIONS, ~20 on Nitro). Indexing all the way to head risks writing
-- a participation row for a block that gets reorged away — and since quest_daily has no
-- delete path, a false positive there is permanent. Trailing the head costs at most one
-- cron period of latency on a quest that is measured in days.
--
-- RESTART OVERLAP. On resume, re-index from last_block - QUEST_INDEXER_CONFIRMATIONS
-- rather than last_block + 1. Re-reading a few blocks is free and idempotent (quest_daily
-- upserts with `on conflict do nothing`), whereas a gap is invisible and permanent.

create table if not exists indexer_state (
  chain_id   integer     not null,
  -- Lower-cased contract address. Not a logical name: addresses are what actually change.
  source_key text        not null,

  -- Highest block whose logs are fully indexed, confirmation margin already subtracted.
  last_block bigint      not null,
  -- Wall-clock of the last successful run. Freshness is judged on block lag, but this
  -- makes "the cron has not run at all since Tuesday" legible at a glance.
  updated_at timestamptz not null default now(),

  primary key (chain_id, source_key),

  constraint indexer_state_source_is_lower check (source_key = lower(source_key)),
  constraint indexer_state_block_positive  check (last_block >= 0)
);

alter table indexer_state enable row level security;

revoke all on table indexer_state from anon, authenticated;
