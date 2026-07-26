# Running services — what they are, what they need, how to tell if they're sick

Written for whoever is looking at this at 2am. Chain 4441 (LitVM LiteForge) throughout.

There are **three always-on services** plus Vercel and Supabase. They are separate processes
on purpose: the quest indexer can crash, hang or OOM without touching the two keepers that
run the money path.

| # | Service | Code | Holds a key? | If it dies |
|---|---------|------|--------------|------------|
| 1 | Perp keeper | `keeper/` | **YES** — `KEEPER_PRIVATE_KEY` | Requests stop being filled. Money path stalls. **Highest priority.** |
| 2 | Prediction keeper | ⚠️ **not in this repo** — see below | presumably yes | Markets stop settling |
| 3 | Quest indexer + settler | `quest-indexer/` | **NO, ever** | `daily_active` degrades to indeterminate. No wrong answers. |
| — | Frontend + `/api/quest/verify` | `frontend/` (Vercel) | no | Quest verification 503s |
| — | Postgres | `supabase/migrations/` | — | Quest cache/index unavailable → indeterminate |

> ⚠️ **`prediction-keeper/` contains no tracked files.** The directory exists locally with a
> `node_modules` only; its source is not in this repository and nothing here references it.
> If it is a live Railway service, **its code lives somewhere else and is not version
> controlled here.** Worth fixing — it is the one service nobody can diagnose from this repo.

---

## 1. Perp keeper — `keeper/`

Watches PositionManager over a WebSocket and fills `executeRequest` with a fresh signed
RedStone price, earning the per-fill fee. Railway, `node keeper.mjs`, restart `ON_FAILURE`.

Runbook: **`docs/TESTNET_LAUNCH.md`** (hosting, funding, the fee economics).

Env: `KEEPER_PRIVATE_KEY` (secret store only, never a file), `LITVM_RPC_URL`,
`KEEPER_WS_URL`, `POSITION_MANAGER_ADDRESS`, `MUSD_ADDRESS`, `REDSTONE_DATA_SERVICE`,
`START_BLOCK`, plus `KEEPER_*` tuning (`LOOP_MS`, `BATCH_SIZE`, `MAX_ACTIVE`,
`CATCHUP_MS`, `RPC_RETRIES`, `RPC_RETRY_BASE_MS`, `RPC_RETRY_CAP_MS`, `WS_FALLBACK`,
`PKG_CACHE_MS`).

**This is the one that holds funds.** Treat its key accordingly.

---

## 2. Prediction keeper

Settles prediction markets. **Source not in this repo** — see the warning above.

---

## 3. Quest indexer + settler — `quest-indexer/`

One process, two jobs, `node index.mjs`, restart `ON_FAILURE`.

**Forward indexer** (every 60s): reads `PositionOpened` / `Deposit` / `BetPlaced`×2 into
`quest_daily`, advances `indexer_state`. This is what makes `daily_active` answerable.

**Backward settler** (leftover time only): walks `quest_cursor` downward so deep one-time
quests settle in the background instead of needing ~200 user polls each.

**The forward indexer has absolute priority.** The settler runs only when the index is both
error-free *and* caught up to the safe head. Rationale: a lagging index is the only thing
that could make the endpoint lie; a lagging settler just means "not yet" for longer.

### It is read-only, always

No signer, no key, no money path. `test/isolation.test.mjs` enforces this in CI: the shipped
code contains no signer construction, reads no key-shaped variable, imports nothing from
`keeper/` or `frontend/`, and **its entire env surface is an allow-list**. Adding a variable
means editing that test — deliberately.

### Env

Required (no defaults — a missing or malformed value exits 1 at startup):

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
QUEST_POSITION_MANAGER_ADDRESS        0x9396D36F713302FF39E0bA5b38012656f8E4eACF
QUEST_LIQUIDITY_POOL_ADDRESS          0x4716a0c9c504F83918002A3086590f1ed192560B
QUEST_PREDICTION_FACTORY_ADDRESS      0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512   (8h, live)
QUEST_PREDICTION_FACTORY_OLD_ADDRESS  0x6338985C7f689C3e1959bfe1a8bb36E44849EA40   (24h, draining)
```

Optional, defaults fine: `QUEST_RPC_URL`, `QUEST_CHAIN_ID`, `QUEST_INDEXER_INTERVAL_MS`,
`QUEST_INDEXER_CONFIRMATIONS`, `QUEST_INDEXER_MAX_RANGE`, `QUEST_SETTLER_ENABLED`,
`QUEST_*_DEPLOY_BLOCK`. Full reasoning in `quest-indexer/.env.example`.

**The addresses must match Vercel's** — the same variable names are set in both places. The
indexer writes `quest_daily`; the read path refuses to trust it unless those same sources are
fresh. Point them at different contracts and a wallet active only on the odd one out gets a
confident wrong answer. A parity test pins the *list*; the *values* are yours to keep in step.

---

## Is the quest index healthy?

Four checks, cheapest first.

### 1. The watermarks are moving

```sql
select source_key, last_block, updated_at,
       now() - updated_at as age
from indexer_state where chain_id = 4441;
```

Expect **4 rows**, `age` under ~2 minutes, `last_block` climbing between two runs a minute
apart. This is the single most informative query; everything below is elaboration.

- **0 rows** → the service has never successfully indexed. Check it is running at all.
- **Fewer than 4** → one source is missing. Usually a changed address: the row is keyed by
  address, so a redeploy self-invalidates and starts fresh. Correct, but it reads as stale
  until it catches up.
- **`age` growing** → the process is down, crash-looping, or wedged.
- **`last_block` static while `age` stays small** → it is running and *finding no new blocks*.
  Fine on a quiet chain; the guarded `lte` write refreshes `updated_at` without moving the
  watermark, which is exactly why `age` alone is not enough.

### 2. The logs say what it did

Every tick:

```
[indexer] head 33421655 — positionManager:33421635(+0) liquidityPool:33421635(+0) …
```

`(+n)` is rows written. Settler lines appear only when there is work and the index is caught
up:

```
[settler] first_trade 0xe9dd… positionManager — 33000000 → 32960000 (40000 blocks, 9657370 to go)
[settler] first_prediction 0xe9dd… — FOUND at block 32245111, completion written
```

Worth reacting to:

| Log | Means |
|---|---|
| `contract preflight failed … NO CONTRACT CODE` | A configured address is wrong. Startup refused — fix the env var. |
| `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required` | Missing config. Startup refused. |
| `… failed, watermark held` | A range failed; it will be retried. Occasional is normal, persistent is not. |
| `candidate page full at 200 rows` | More settler work than one page. Harmless — the page rotates. |
| `settler slice failed, continuing` | The settler hit an error. Contained; the index is unaffected. |
| *no `[indexer]` line for minutes* | The tick is hung. Restart. |

### 3. What the endpoint says

```bash
curl -sX POST https://app.tachyonfi.xyz/api/quest/verify \
  -H 'content-type: application/json' \
  -d '{"address":"0x…","quest":"daily_active"}'
```

> **Note:** `daily_active` is not live yet — it goes live with the read-path deploy, which is
> gated on the index having a **full UTC day** of coverage. Until then it answers
> indeterminate by registration, not by staleness.

Once live:

| `reason` | Meaning |
|---|---|
| *(none)*, `status: confirmed` | Answered. `completed` is trustworthy. |
| `indexer_stale` | The freshness gate refused. **See below.** |
| `day_boundary` | Within ~15 min after 00:00 UTC. Expected, self-clearing. |
| `index_unreadable` | `quest_daily` could not be read. Supabase problem. |

### 4. Which staleness condition tripped

The API reports `indexer_stale` without saying which of the six conditions fired — the
`detail` is logged server-side but not returned. Diagnose from the table instead:

| Condition | How you see it |
|---|---|
| A required source has no row | fewer than 4 rows in query 1 |
| The read failed | Supabase down / bad key |
| Wall-clock age | `age` > 15 min in query 1 |
| Block lag | `head − min(last_block)` > ~2,800 blocks |
| **`head < last_block`** | watermark **above** current head — a chain reset. See below. |
| Row present but unreadable | a null/garbage `last_block` or `updated_at` |

**The chain-reset case is the nasty one.** After a testnet re-genesis the watermark sits above
the new head, so the lag subtraction goes negative and *looks like zero lag*. The guard
catches it explicitly. The fix is to delete the stale rows and let the indexer start fresh:

```sql
delete from indexer_state where chain_id = 4441;   -- then restart the service
```

---

## The one rule behind all of it

Everything above exists to protect a single property:

> **A missing row never means "no". It only means "no" when the index is provably current.**

`quest_daily` is the only table in this schema where absence is an answer, which is why the
freshness gate is read *before* it, every time, and fails closed six ways. If you are ever
unsure whether the index is trustworthy, the safe state is the one it already defaults to:
`indeterminate`. Nothing here is allowed to guess.

**Turning the quest indexer off is safe.** `daily_active` degrades to indeterminate and deep
quests go back to needing user polls. Turning off a *keeper* is not safe.
