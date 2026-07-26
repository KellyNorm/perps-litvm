# Supabase schema — quest API phase 2

Durable storage for `POST /api/quest/verify`. Four tables, all server-only.

**Nothing here is applied automatically.** The project lives in an org the repo tooling
cannot reach, and no CI job touches Supabase. Migrations are checked in and applied by
hand, in numeric order.

## Apply

Paste each file into the Supabase SQL editor in order, or apply them in one pass:

```bash
cat supabase/migrations/*.sql          # review, then paste
# or, with the CLI linked to the project:
supabase db push
```

All four are idempotent (`create table if not exists`), so re-running is safe.

| File | Table | Used by |
|---|---|---|
| `0001_quest_completion.sql` | `quest_completion` | step 1 — durable verdict cache (shipped) |
| `0002_quest_cursor.sql` | `quest_cursor` | step 3 — resumable deep-history cursor |
| `0003_quest_daily.sql` | `quest_daily` | step 4 — `daily_active` participation index |
| `0004_indexer_state.sql` | `indexer_state` | step 4 — indexer watermark + freshness proof |

Applying all four before any of steps 3–4 ship is harmless: unused tables sit empty, and
each step's code creates its own rows.

## Then

Set these in the Vercel project (**server-side, no `VITE_` prefix**):

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>
QUEST_CACHE=supabase
```

Until `QUEST_CACHE=supabase` is set, the endpoint uses the in-process memory driver and
none of these tables are read or written. Setting it before applying the migrations is not
dangerous either — every read simply misses and every write is swallowed, so the endpoint
degrades to verifying from chain.

## The rule the whole schema is built around

**A negative is never stored.**

`quest_completion` and `quest_daily` have no `completed`/`active` column — a row's
existence *is* the fact. `quest_cursor` stores *coverage* (which blocks were walked), and
the verdict is derived from it on read, so a proven false is computed rather than
remembered. If a row is missing, stale, or short of its floor, every derivation yields
`indeterminate`, which is the safe direction.

The one place absence means "no" is `quest_daily`, and it is only allowed to mean that
when `indexer_state` proves the index is current. See the header comment in
`0003_quest_daily.sql`.

## Access

RLS is on for every table with **no policies**, and `anon`/`authenticated` are revoked.
`service_role` bypasses RLS, so this is defence-in-depth against a leaked anon key — the
primary control is that the anon key is never used here and the service-role key never
reaches the browser bundle. Two tests enforce the latter (`frontend/test/quest/env.test.js`).
