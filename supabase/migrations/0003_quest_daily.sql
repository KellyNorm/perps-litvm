-- Phase 2, step 4 — participation index behind the `daily_active` quest.
--
-- WHY AN INDEX AND NOT A SCAN. "Active in the last 24h" spans ~345,600 blocks. At the
-- measured ~0.3ms/block that is ~104 seconds of eth_getLogs against a 30s function ceiling,
-- and unlike the one-time quests there is no Tier 1 shortcut — no current-state read means
-- "did something today". So daily_active currently answers INDETERMINATE every time, on
-- purpose (quests.js: `available: false`, reason `needs_indexer`). A forward indexer turns
-- it into an O(1) "is there a row for this wallet today" lookup.
--
-- Forward is cheap where backward is not: a 5-minute cron covers ~1,200 blocks per run,
-- comfortably inside one invocation, and the daily total (~105s of getLogs) is spread
-- across 288 runs instead of crammed into one request.
--
-- ============================================================================
-- THE DANGEROUS PART: HERE, ABSENCE MEANS "NO".
-- ============================================================================
-- Every other table in this schema is safe by construction — a missing row yields
-- indeterminate, never a false. This one is different and must be handled with care:
-- answering daily_active means reading "no row for (wallet, today)" as "not active today".
-- If the cron dies, every wallet silently becomes `completed: false`. That is precisely
-- the failure this endpoint was built to prevent, arrived at from a new direction.
--
-- THE RULE, enforced in the check and not merely documented: absence is only an answer
-- when the indexer is PROVABLY CURRENT. Read indexer_state first (see 0004); if the
-- watermark for any required source is more than QUEST_INDEXER_MAX_LAG_MS behind head
-- (default 15 minutes ~= 3 cron periods, so one missed run does not trip it), return
-- INDETERMINATE with reason `indexer_stale` and do not look at this table at all.
--
-- A row's existence is the fact, as everywhere else in this schema: there is no `active`
-- boolean, so "indexed and inactive" and "not indexed" cannot be conflated in storage —
-- the difference lives in indexer_state, which is the only thing that can tell them apart.

create table if not exists quest_daily (
  chain_id         integer     not null,
  wallet           text        not null,
  -- UTC day. Matches utcDay() in cache.js, which stamps YYYY-MM-DD off toISOString() —
  -- the boundary must be UTC or two regions disagree about "today" and a wallet's quest
  -- flips depending on which instance answers.
  day              date        not null,

  -- Debug only: where the first sighting that day came from. Never read for a verdict.
  first_seen_block bigint,
  first_seen_via   text,

  indexed_at       timestamptz not null default now(),

  primary key (chain_id, wallet, day),
  constraint quest_daily_wallet_is_lower check (wallet = lower(wallet))
);

-- Writes are `on conflict do nothing`: the cron is at-least-once, so re-processing a block
-- range after a retry or an overlapping run must be a no-op rather than a duplicate-key
-- error. That idempotence is what makes the overlap-on-restart strategy in 0004 safe.

-- RETENTION: none, deliberately. One row per wallet per active day on a testnet is a few
-- thousand rows; a prune job would be machinery to maintain, schedule, and debug in
-- exchange for nothing. Revisit only if this table ever gets large enough to notice.

alter table quest_daily enable row level security;

revoke all on table quest_daily from anon, authenticated;
