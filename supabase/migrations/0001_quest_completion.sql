-- Phase 2, step 1 — durable verification cache for /api/quest/verify.
--
-- APPLY THIS BY HAND. The Supabase project for this lives in an org the tooling here
-- cannot reach, so migrations are checked in and applied by the operator (SQL editor or
-- `supabase db push`). Nothing in CI applies them.
--
-- THE SCHEMA IS THE POLICY. There is deliberately no `completed` and no `status` column:
-- a row's EXISTENCE is the proven completion, so a stored negative is not merely
-- discouraged, it is unrepresentable. api/_lib/quest/cache.js enforces the same rule in
-- code (`isCacheable`); this enforces it in storage, where no future caller can forget it.
--
-- The bug being designed against: a wallet told "not completed" forever because one scan
-- timed out. An indeterminate result must never harden into a permanent false.

create table if not exists quest_completion (
  -- Namespaced by chain: the same wallet exists on testnet and mainnet, and a testnet
  -- answer must never satisfy a mainnet quest.
  chain_id              integer     not null,
  -- Lower-cased at the boundary so checksum casing cannot split a wallet across two rows.
  wallet                text        not null,
  quest                 text        not null,
  -- UTC day (YYYY-MM-DD) for daily quests; '-' for one-time ones. Carrying the day in the
  -- key is what makes yesterday's `true` expire without any TTL machinery to run or fail.
  bucket                text        not null default '-',
  -- Informational: the block we verified through, and which tier proved it. Neither is a
  -- verdict — the verdict is the row.
  checked_through_block bigint,
  source                text,
  verified_at           timestamptz not null default now(),

  primary key (chain_id, wallet, quest, bucket),
  constraint quest_completion_wallet_is_lower check (wallet = lower(wallet)),
  constraint quest_completion_bucket_not_empty check (bucket <> '')
);

-- RLS on, no policies. `service_role` bypasses RLS, so this is defence-in-depth against a
-- leaked anon key rather than the primary control; the primary control is that the anon
-- key is never used by this endpoint and the service-role key never reaches the browser
-- bundle (never give it a VITE_ prefix — Vite would inline it).
alter table quest_completion enable row level security;

revoke all on table quest_completion from anon, authenticated;
