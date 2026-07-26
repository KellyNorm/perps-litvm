-- Phase 2, step 3 — resumable deep-history cursor for /api/quest/verify.
--
-- THE PROBLEM THIS SOLVES. A Tier 2 scan walks backward from head under a ~10s budget,
-- covering ~50k blocks per invocation. The perps contracts sit ~10M blocks below head, so
-- a wallet whose activity is older than a few hours can never be settled in one request:
-- it returns INDETERMINATE forever, no matter how many times it is polled, because every
-- poll restarts from head. This table makes polls CONVERGE by remembering what was walked.
--
-- ============================================================================
-- THE INVARIANT: THIS TABLE STORES COVERAGE, NEVER A VERDICT.
-- ============================================================================
-- There is no `completed` column and no `status` column here, exactly as in
-- quest_completion, and for a stronger reason. A row says only:
--
--     "for this wallet, quest and contract, blocks [scanned_to .. scanned_from]
--      have been walked and contained no matching event"
--
-- which is a FACT ABOUT WORK DONE, not an answer. The verdict is DERIVED on every read:
--
--   found a matching event        -> confirmed true   (recorded in quest_completion;
--                                                      this table is not consulted)
--   every source row has
--     scanned_to = floor_block    -> confirmed FALSE  (a proven negative: every source
--                                                      walked to its validated floor)
--   anything else                 -> indeterminate
--
-- Equality, not <=: scanForEvent() clamps each chunk with max(floor, …) so a walk never
-- goes below its floor, and the CHECK below refuses to store coverage that claims it did.
-- "Reached the floor" is therefore exactly scanned_to = floor_block.
--
-- So a false is COMPUTED from coverage, never stored. That is what keeps the "never
-- persist a negative" rule intact while still letting a negative eventually be proven:
-- if a row is missing, stale, or short of its floor, the derivation yields indeterminate,
-- which is the safe direction. There is no way to write a row that ASSERTS a wallet did
-- nothing — only rows asserting which blocks were read.
--
-- ============================================================================
-- WHY ONE ROW PER SOURCE, NOT ONE PER QUEST
-- ============================================================================
-- The original sketch had one (scanned_from, scanned_to) pair per (wallet, quest) plus a
-- `sources_hash` column. That is WRONG for any multi-source quest, and first_prediction is
-- one: it scans the live 8h factory (0x7dd9e01f…, floor 32,222,320) AND the superseded 24h
-- factory (0x6338985C…, floor 30,665,562), because bets placed before the 2026-07-22
-- redeploy are real bets. Those sources have different floors and are walked in sequence
-- under a shared budget, so mid-scan the true state is routinely "live factory fully
-- walked, old factory barely started". A single interval cannot express that. It would
-- either under-claim (discarding good work every poll — no convergence) or over-claim
-- (reporting a proven false while an entire contract went unread — a wrong answer).
--
-- One row per source expresses it exactly, and two nice properties fall out:
--
--   1. `sources_hash` becomes unnecessary. The contract address is IN THE PRIMARY KEY, so
--      a redeploy or an env override simply finds no row for the new address and starts a
--      fresh walk. Address changes are self-invalidating; no fingerprint to compute, keep
--      in sync, or get wrong. Orphaned rows for retired addresses are harmless and ignored.
--
--   2. `floor_reached` becomes unnecessary. It is derived as `scanned_to = floor_block`
--      rather than stored, so a boolean can never drift out of agreement with the numbers
--      it summarises. Storing both would create a state where they disagree and no rule
--      for which one wins.
--
-- `floor_block` is stored per row precisely so a CHANGED floor invalidates the coverage:
-- chain.js warns that a floor is coupled to its address, and coverage computed against a
-- stale floor must not be trusted. Compare the configured floor to this column; on a
-- mismatch, discard the row and re-walk. (A floor moved DOWN means there is history below
-- what we walked; a floor moved UP means the old walk may have read the wrong contract.)
--
-- ============================================================================
-- THE CONTIGUITY RULE — READ BEFORE WRITING TO THIS TABLE
-- ============================================================================
-- [scanned_to .. scanned_from] MUST be a hole-free interval. Everything above depends on
-- it: "scanned_to <= floor_block" only means "walked to the floor" if nothing inside the
-- interval was skipped. Two ways a hole can appear, and the write rule for each:
--
--   * A LOST CHUNK. scanForEvent() marks the whole scan `exhausted` when a chunk errors,
--     but the blocks below that chunk may still have been read. Only ever advance
--     scanned_to to the lowest CONTIGUOUSLY covered block — never past a failed chunk.
--
--   * A GAP AT THE TOP. head moves between polls, so poll N+1 must first close
--     [scanned_from + 1 .. new head] before descending further. If the budget runs out
--     mid-gap, DO NOT advance scanned_from: discard that partial work and leave the row
--     alone. The gap is normally a few thousand blocks (minutes of chain) and closes in
--     one invocation, so this is rare, and correctness is worth more than the wasted
--     chunk. Advancing scanned_from over an unclosed gap would silently create a hole
--     that later reads would count as covered.
--
-- The CHECK below enforces the interval's shape. It cannot enforce hole-freeness — that is
-- the writer's job, which is why the rule is written here rather than left to be inferred.

create table if not exists quest_cursor (
  chain_id     integer     not null,
  -- Lower-cased at the boundary, as everywhere else, so checksum casing cannot split one
  -- wallet's coverage across two rows and make a completed walk look partial.
  wallet       text        not null,
  quest        text        not null,
  -- The contract this coverage is about, lower-cased hex. In the key so that an address
  -- change starts a fresh walk instead of inheriting coverage of a different contract.
  source_key   text        not null,

  -- The floor this coverage was computed against. A mismatch with the configured floor
  -- invalidates the row — see above.
  floor_block  bigint      not null,
  -- Highest block covered (inclusive).
  scanned_from bigint      not null,
  -- Lowest block covered (inclusive). Coverage is complete for this source when this
  -- EQUALS floor_block — the CHECK below makes lower impossible.
  scanned_to   bigint      not null,

  updated_at   timestamptz not null default now(),

  primary key (chain_id, wallet, quest, source_key),

  constraint quest_cursor_wallet_is_lower   check (wallet = lower(wallet)),
  constraint quest_cursor_source_is_lower   check (source_key = lower(source_key)),
  -- An interval, not a pair of unrelated numbers.
  constraint quest_cursor_interval_ordered  check (scanned_to <= scanned_from),
  constraint quest_cursor_blocks_positive   check (scanned_to >= 0 and floor_block >= 0),
  -- Coverage below the floor is meaningless: the contract did not exist there. Catching it
  -- here turns a floor/address mix-up into a failed write rather than a bogus proven false.
  constraint quest_cursor_not_below_floor   check (scanned_to >= floor_block)
);

-- Reads are always by the full key or by its (chain_id, wallet, quest) prefix — both
-- served by the primary key index, so no secondary index is needed.

alter table quest_cursor enable row level security;

revoke all on table quest_cursor from anon, authenticated;
