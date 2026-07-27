-- Phase 2, step 5 — the one-time-quest backfill, and the handoff that makes a proven
-- negative possible without a per-wallet walk.
--
-- APPLY THIS BY HAND, like every migration here. The Supabase project lives in an org the
-- tooling cannot reach; nothing in CI applies them.
--
-- ============================================================================
-- WHAT PROBLEM THIS SOLVES
-- ============================================================================
-- Proving "this wallet NEVER traded" currently means walking PositionManager from head to
-- its deploy block for THAT WALLET: ~10.6M blocks, ~1,060 chunks, per wallet, forever, once
-- per wallet that asks. quest_cursor and the backward settler make that converge, but the
-- cost is per-wallet and it never goes away.
--
-- One UNFILTERED pass over the same range answers it for EVERY wallet at once. The filter
-- is `address + topic0` with no wallet topic — the same `allWalletsFilter()` the forward
-- indexer already uses — so 426 chunks (at 25k blocks) covers every trader that has ever
-- existed instead of 1,060 chunks covering one. Every wallet that appears gets a
-- quest_completion row; every wallet that does not appear is, once the pass is complete,
-- provably a non-trader.
--
-- ============================================================================
-- THE INVARIANT IS UNCHANGED: THIS TABLE CANNOT HOLD A FALSE.
-- ============================================================================
-- Exactly like quest_cursor, and for exactly the same reason. There is no `complete`
-- column, no `status`, no verdict of any kind. A row says only:
--
--     "for this contract, blocks [covered_to .. covered_from] have been read in full,
--      and every wallet found in them has a quest_completion row"
--
-- which is a FACT ABOUT WORK DONE. The negative is DERIVED on every read, on the read path,
-- from this coverage plus the forward index's — never stored. A missing row, a stale floor,
-- a pass that stopped short: all of them simply fail the derivation and the answer degrades
-- to INDETERMINATE, which is the safe direction.
--
-- The positives go to quest_completion, which by its own schema (0001) can only express a
-- completion. So neither half of this mechanism has a representation for "did not do it".
--
-- ============================================================================
-- THE UNION PROOF, AND THE GAP IT HAS TO CLOSE
-- ============================================================================
-- This table covers [floor .. covered_from]. The FORWARD indexer covers everything from
-- where it started up to its watermark. A negative needs the two to meet with no hole
-- between them, so the read path checks all of:
--
--   1. a row exists for every source the quest requires   (missing -> indeterminate)
--   2. floor_block  = the configured floor                 (floor coupling, as quest_cursor)
--   3. covered_to   = floor_block                          (EQUALITY — reached the floor)
--   4. covered_from >= indexer_state.completion_from - 1    (the two intervals touch)
--   5. indexer_state.completion_from is not null            (see below)
--   6. the existing six-way freshness gate passes           (the forward half is current)
--
-- Only all six together turn "no quest_completion row" into a confirmed false, reported
-- `checkedThroughBlock = min(last_block)` — never head, which nothing has reached.
--
-- ============================================================================
-- WHY completion_from EXISTS, AND WHY NULL MUST FAIL CLOSED
-- ============================================================================
-- The forward indexer has been writing quest_daily since 2026-07-26. It has NEVER written
-- quest_completion rows. So the day that write is switched on, the blocks between the
-- indexer_state row's creation and that deploy are indexed for daily_active and NOT for
-- completions — a hole, invisible in last_block, that would read as "this wallet never
-- traded" for anyone whose only trade fell inside it.
--
-- last_block cannot answer "from where have completions been written", so a second
-- watermark records it. It is set ONCE by the indexer itself, to the first block of the
-- first range whose completions actually landed, and never moves afterwards.
--
-- NULL IS NOT ZERO AND NOT "SINCE ALWAYS". It means the indexer has not yet told us, and
-- the read path must treat it as unprovable — INDETERMINATE. Defaulting it to anything
-- would invent coverage nobody performed, which is the one failure this whole subsystem
-- exists to prevent. There is deliberately NO default and NO backfill of this column:
-- guessing it is precisely the mistake.
--
-- A CONSEQUENCE, ENFORCED IN CODE RATHER THAN HERE: the completion write has no kill
-- switch. Turning it off and on again would leave a hole inside [completion_from ..
-- last_block] that nothing in this schema could detect.

-- ============================================================================
-- 1. THE BACKFILL'S COVERAGE
-- ============================================================================

create table if not exists quest_backfill (
  chain_id     integer     not null,
  -- The contract this coverage is about, lower-cased hex. In the key for the same reason as
  -- quest_cursor and indexer_state: a redeploy finds no row and starts a fresh pass rather
  -- than inheriting coverage of a different contract. Address changes self-invalidate.
  source_key   text        not null,

  -- The floor this pass was computed against. A mismatch with the configured floor voids
  -- the row — a floor moved DOWN means there is unread history below what we covered; a
  -- floor moved UP means the pass may have been reading a different contract.
  floor_block  bigint      not null,
  -- Highest block covered (inclusive). Set ONCE when the pass starts, to the chain head at
  -- that moment, and never moved: it is the handoff point against which condition 4 above
  -- is checked. Moving it later would be claiming coverage of blocks read by nothing.
  covered_from bigint      not null,
  -- Lowest block covered (inclusive), descending toward floor_block as the pass proceeds.
  -- The pass is COMPLETE for this source when this EQUALS floor_block; the CHECK below
  -- makes lower impossible, so equality is exactly "reached the floor".
  covered_to   bigint      not null,

  updated_at   timestamptz not null default now(),

  primary key (chain_id, source_key),

  constraint quest_backfill_source_is_lower  check (source_key = lower(source_key)),
  -- An interval, not two unrelated numbers.
  constraint quest_backfill_interval_ordered check (covered_to <= covered_from),
  constraint quest_backfill_blocks_positive  check (covered_to >= 0 and floor_block >= 0),
  -- Coverage below the floor is meaningless: the contract did not exist there. Catching it
  -- here turns a floor/address mix-up into a failed write rather than a bogus proven false.
  constraint quest_backfill_not_below_floor  check (covered_to >= floor_block)
);

-- CONTIGUITY IS THE WRITER'S JOB, and the CHECKs above cannot enforce it — the same
-- situation as quest_cursor, so the same rule is written down rather than left to be
-- inferred: covered_to may only ever be moved DOWN, to the lowest block of an unbroken run
-- of successful chunks. Never past a chunk that failed. The walker in
-- quest-indexer/lib/walk.mjs gets this by construction (it returns on the first error and
-- advances its frontier only after a chunk that succeeded), and the write is guarded
-- `covered_to=gte.N` so a concurrent or replayed slice can never drag coverage back up.

alter table quest_backfill enable row level security;

revoke all on table quest_backfill from anon, authenticated;

-- ============================================================================
-- 2. THE FORWARD HALF'S HANDOFF WATERMARK
-- ============================================================================
-- Nullable, no default, never backfilled — see the reasoning above. Existing rows keep
-- NULL until the indexer sets it, and until then every one-time quest for an un-completed
-- wallet answers INDETERMINATE exactly as it does today. That is the intended behaviour of
-- applying this migration: nothing changes until the indexer proves the coverage itself.

alter table indexer_state add column if not exists completion_from bigint;

comment on column indexer_state.completion_from is
  'First block from which quest_completion rows have been written for this source, set once '
  'by the indexer and never moved. NULL means "not yet proven" and MUST fail closed on the '
  'read path — it is not zero and not "since always". See 0005_quest_backfill.sql.';

-- Wrapped because ADD CONSTRAINT has no IF NOT EXISTS, and this file is applied BY HAND —
-- so it will be pasted twice by someone who is not sure whether the first paste took. A
-- migration that errors on a re-run teaches the operator to ignore errors, which is a far
-- worse habit than the four extra lines.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'indexer_state_completion_from_positive'
  ) then
    alter table indexer_state add constraint indexer_state_completion_from_positive
      check (completion_from is null or completion_from >= 0);
  end if;
end $$;
