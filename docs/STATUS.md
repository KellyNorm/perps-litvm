# STATUS — the map for whoever picks this up next

Written 2026-07-26. Chain **4441** (LitVM LiteForge) throughout. Everything here is testnet,
unaudited, test mUSD only.

Read this first, then `CLAUDE.md` (constitution), `TASK.md` (roadmap + known gaps), and
`docs/services.md` (the 2am operator runbook).

---

## 1. WHAT'S LIVE

Three products plus one API, all in one repo, all deploying independently.

| Product | Surface | State |
|---|---|---|
| **Perps** | `app.tachyonfi.xyz` | Live. Leveraged BTC/ETH vs a shared mUSD pool, two-step request/execute, keeper-filled. |
| **Predictions** | `app.tachyonfi.xyz` (same app) | Live. Parimutuel binary up/down, 11 assets, 15m/30m/1h/8h frames. |
| **Tachy** (AI assistant) | `POST /api/tachy` + mascot UI | Live. v1 — education only, places no trades. |
| **Quest API** | `POST /api/quest/verify` | Live. 4 of 5 quests answerable; `daily_active` still gated (§3). |

### Contracts (chain 4441)

Perps stack, redeployed 2026-06-26 (`docs/stack-redeploy-runbook.md`):

| | Address |
|---|---|
| Governance | `0x90365332B2642DCCd3ebC9a976702bA79824970A` |
| PositionManager | `0x9396D36F713302FF39E0bA5b38012656f8E4eACF` |
| LiquidityPool | `0x4716a0c9c504F83918002A3086590f1ed192560B` |
| mUSD (shared with predictions) | `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF` |

Prediction market, redeployed 2026-07-22:

| | Address |
|---|---|
| **PredictionMarketFactory (LIVE, 8h)** | `0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512` |
| Old factory (24h, **DRAINING** — immutable, still answers calls) | `0x6338985C7f689C3e1959bfe1a8bb36E44849EA40` |
| DIA oracle | `0x49c39225Dbc64700936bb641d1E81113DbadD2DF` |
| 11 `DIAAggregatorV3Adapter`s | reused from the prior deploy — table in `docs/prediction-deploy.md` on `feat/prediction-8h-window` |

Keeper key (perps): `0xCCd143E9Ae97E82a178A9E99799c4EA52ff35748` — dedicated, **not** the deployer.
Deployer/treasury/owner: `0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292`.

Oracles: perps use **RedStone pull** (`redstone-primary-prod`, 3-of-N signers) cross-checked
against DIA by the on-chain circuit-breaker; predictions settle off a **DIA TWAP**.

### Railway (3 always-on services)

| Service | Railway project | Code | Key? |
|---|---|---|---|
| Perp keeper | `poetic-determination` | root `railway.json` → `node keeper/keeper.mjs` | **YES** — `KEEPER_PRIVATE_KEY` |
| Quest indexer + settler | `agile-transformation` | `quest-indexer/railway.json` → `node index.mjs` | **NO, ever** |
| Prediction keeper | *not visible from this repo* | ⚠️ **source not in this repository** | presumably yes |

> The project↔service mapping is inferred from GitHub deploy statuses: `poetic-determination`
> reports on commits predating the quest indexer; `agile-transformation` first appears on
> `59aa5cd`, the commit that added `quest-indexer/`. Confirm in the Railway dashboard before
> acting on it destructively.

### Vercel

Team `kellyifeanyi40-7498s-projects`, two projects — `perps-litvm` and `perps-litvm-6sin` —
both reporting success on `main`. One serves `frontend/` → `app.tachyonfi.xyz`, the other
`landing/` → `tachyonfi.xyz` (redirects to `www.`). **Which is which is not determinable from
this repo**: the Vercel MCP connection is a different account, so verify in the dashboard.
Deploy status for any commit is checkable without it:

```bash
gh api repos/KellyNorm/perps-litvm/commits/main/status \
  --jq '.statuses[] | "\(.context) -> \(.state)"'
```

`frontend/vercel.json` declares both functions: `api/tachy.js` (maxDuration 10s) and
`api/quest/verify.js` (30s).

### Supabase

One project, **in the user's own org — not the org reachable through the Claude Supabase MCP
connection.** Nothing automated may provision or migrate it. Four tables, migrations checked
in under `supabase/migrations/` and **applied by hand, in numeric order** (`supabase/README.md`):

| Migration | Table | Purpose |
|---|---|---|
| `0001_quest_completion.sql` | `quest_completion` | durable verdict cache |
| `0002_quest_cursor.sql` | `quest_cursor` | resumable deep-history scan coverage |
| `0003_quest_daily.sql` | `quest_daily` | `daily_active` participation index |
| `0004_indexer_state.sql` | `indexer_state` | indexer watermark + freshness proof |

RLS on for every table with **no policies**; `anon`/`authenticated` revoked. The service-role
key is server-side only and must never carry a `VITE_` prefix — two tests in
`frontend/test/quest/env.test.js` enforce that.

---

## 2. ARCHITECTURE NOTES

### The doubled repo — read this before any git operation

The path is `/workspaces/perps-litvm/perps-litvm`. **The inner repo is the real one.** The
outer `/workspaces/perps-litvm` is an unused Codespace artifact, not a real submodule setup.
`git status` in the outer directory permanently shows `M perps-litvm` — that is noise, not a
change. **Never commit or push from the outer directory.** All work happens inside.

### Deployable isolation

`frontend/`, `landing/`, `keeper/`, and `quest-indexer/` are self-contained and do not import
one another. This is enforced, not merely intended: `quest-indexer/test/isolation.test.mjs`
fails CI if the service grows an import across a deployable boundary, constructs a signer,
reads a key-shaped variable, or reads any env var outside its allow-list. Adding an env var
to the indexer means editing that test — deliberately.

### Money-path boundaries

1. **The quest indexer holds no key and never will.** It reads chain logs and writes Supabase
   rows. It is a separate process specifically so a crash, hang, or OOM there cannot touch the
   two keepers running the money path. Turning it off is safe (`daily_active` degrades to
   indeterminate). Turning off a **keeper** is not.
2. **The quest API constructs no signer anywhere** under `frontend/api/_lib/quest/`. The
   prediction-factory ABI it uses is a *ported subset* that deliberately omits `bet`/`claim`,
   so the endpoint cannot even encode a write.
3. **Predictions are isolated from perps in the frontend** — `predictionConfig.js` is separate
   from `config.js` so a prediction change cannot reach the live perps path.
4. **Duplication across boundaries is intentional and test-pinned.** `quest-indexer/lib/`
   `definitions.mjs` and `frontend/api/_lib/quest/dailySources.js` hold the same source list
   in two places; `frontend/test/quest/sourceParity.test.js` fails if the env-var-name sets
   diverge. They stay in step through **identical env var names in both deployments**, never
   through a shared import.

### ⚠️ Two things that live outside version control

- **`prediction-keeper/`** — directory exists locally with a `node_modules` and a `.env`
  (`LITVM_RPC_URL`, `PREDICTION_KEEPER_PRIVATE_KEY`, `PREDICTION_FACTORY_ADDRESS`) but **no
  tracked source files, ever**. If it is a live Railway service, nobody can diagnose or
  redeploy it from this repo. This is the single biggest structural gap.
- **The prediction market Solidity sources** (`src/prediction/*.sol` — factory, parimutuel
  layer, oracle adapters, TWAP) exist **only on the unmerged branch
  `feat/prediction-8h-window`**, together with `script/DeployPrediction.s.sol`,
  `test/prediction/*` (412 tests), and `docs/prediction-deploy.md`. `main` has none of them.
  The live 8h factory was deployed from that branch. **A shipped, money-holding product's
  source is not on `main`.**

### `docs/` is gitignored by default

`.gitignore` has `docs/*` plus a per-file exception list. A new doc that isn't added to that
list is silently dropped by `git commit`. This already bit once: commit `34ad568` ("operator
note for the three running services") committed only the README edit, so **`README.md` on
`main` links to a `docs/services.md` that isn't in the repo.** Exceptions for `docs/services.md`
and this file have been added; add one for every new doc.

---

## 3. QUEST API STATE

`POST /api/quest/verify` — `{ address, quest }` → `{ completed, status, source,
checkedThroughBlock, asOf, reason?, coverage? }`.

Three statuses, and the middle one is load-bearing: `confirmed` (proven, either way — a true
is cacheable forever), `indeterminate` (could not prove it; **never cached**, caller retries),
`unavailable` (503; could not look at all).

**Shipped and live:**

- **Phase 1** — the endpoint, rate limiting, Tier 1 (current-state reads) + Tier 2 (bounded
  backward log scan), the in-memory drivers.
- **Phase 2 / Supabase** — durable verdict cache (`QUEST_CACHE=supabase`) and the resumable
  scan cursor, so deep-history wallets converge across polls instead of restarting from head.
- **The indexer service** (`quest-indexer/`) — forward index every 60s writing `quest_daily`
  and advancing `indexer_state`; plus the **backward settler**, which uses leftover time to
  walk `quest_cursor` downward so deep one-time quests settle in the background instead of
  needing ~200 user polls each (convergence measured at ~48k blocks/poll on prod).

Quest registry (`frontend/api/_lib/quest/quests.js`): `first_trade`, `first_prediction`,
`provide_liquidity` (one-time), `both_products` (composite, no chain calls of its own),
`daily_active` (daily).

### `daily_active` — built, HELD, and it is the only remaining step

The read path is complete on **`feat/quest-daily-active-readpath`** (2 commits, +963 lines,
0 behind `main`): the six-way fail-closed freshness gate (`indexerState.js`), the
`DAILY_SOURCES` list, the un-indexed tail scan, the post-midnight grace window, and 536 lines
of tests. **It is deliberately not merged.**

Why: the indexer starts at the safe head, not from the deploy block — a backfill would be ~10M
blocks to answer a question about today. So the day the indexer first ran is only *partially*
covered, and a wallet active at 09:00 on a day the index started at 14:00 would get a confident
`false`. The read path must not go live until the index has a **full UTC day** behind it.

The indexer landed on `main` at **2026-07-26 ~04:04 UTC**, so:

- 2026-07-26 is partially covered — not usable.
- The first fully-covered UTC day is **2026-07-27**.
- Merge is safe **on or after 2026-07-27 00:15 UTC**, *provided* `indexer_state` shows
  continuous advance across the 00:00 UTC boundary. Verify before merging:

  ```sql
  select source_key, last_block, updated_at, now() - updated_at as age
  from indexer_state where chain_id = 4441;
  ```

  Expect **4 rows**, all `age` under ~2 minutes, and no gap in the logs spanning midnight. If
  the service restarted mid-day, the watermark survives (it is durable) — what matters is that
  no *block range* was skipped, and the resume overlap guarantees that as long as the process
  came back.

Confirmation it is still held (checked 2026-07-26 05:19 UTC):

```json
{"completed":false,"status":"indeterminate","reason":"needs_indexer","quest":"daily_active"}
```

`reason: "needs_indexer"` = registered-but-unavailable, i.e. pre-merge. After the merge the
reasons you should see instead are `indexer_stale`, `day_boundary`, or none at all.

---

## 4. PENDING ITEMS

| # | Item | Blocked on |
|---|---|---|
| 1 | **Merge `feat/quest-daily-active-readpath`** | Time only — see §3. Verify `indexer_state`, then merge. This is the whole remaining scope of the quest work. |
| 2 | **Partner quest integration** | Not started, and **nothing is captured in this repo** — no partner name, endpoint contract, auth scheme, or quest-id mapping is written down anywhere. The API is built to be called by a partner platform; the integration itself is an undocumented conversation. **Capture the spec before building.** |
| 3 | **Tachy v2 / v3** | Not started, and likewise **no spec exists in the repo.** The only in-code trace is a forward-looking `V2 PATH` comment in `frontend/src/components/tachy/TachyAvatar.jsx`. The v1 system prompt says trading-by-chat is "coming soon", which implies v2 ≈ transactional Tachy — but that is an inference, not a spec. Write it down somewhere tracked before starting. |
| 4 | **PositionManager EIP-170 headroom** | **BLOCKING for the next change to that contract.** 23,919 / 24,576 bytes — 657 bytes (~2.7%) of headroom, and `optimizer_runs = 1` is already spent, so the cheap lever is gone. The fix is `refactor/eip170-library-extraction` (move logic into `library` contracts, which `DELEGATECALL` and don't count toward runtime size); branch exists, **PARKED**. The failure shows up at *deploy* time, after the work is written. **Treat "am I adding to PositionManager?" as the trigger — run `forge build --sizes` before writing the feature.** It is money-path code, so per `CLAUDE.md` rule 3 it needs a written plan and an explicit go-ahead before any implementation. |
| 5 | **Tachy Groq free-tier quota** | **A paid tier is a pre-promotion requirement, not an optimisation.** Free tier `llama-3.3-70b-versatile`: RPM 30 / **TPD 100,000**. A call costs ~1,430 prompt + 60–250 completion tokens, so TPM (12,000) binds first at ~7–8 req/min — `TACHY_RPM` defaults to 7. The hard ceiling is **~65 exchanges per day, key-global**, exhausted by one engaged user in a sitting. No per-IP limiter can enforce a key-global cap. Do not promote Tachy until this is paid. (Gemini is worse: 5 req/min global. Switching provider is one env var, `TACHY_PROVIDER`.) |

Also worth fixing, lower priority: get `prediction-keeper/` and `src/prediction/*.sol` under
version control on `main` (§2); and surface the `indexer_stale` `detail` in the response
envelope — it is computed and logged server-side but dropped, which forces the symptom-to-cause
table in `docs/services.md`.

---

## 5. KEY DECISIONS + WHY

**The quest API never lies. `indeterminate` is never a `false`.**
A quest platform credits wallets off this endpoint, so a wrong `false` silently robs a user who
did the thing. Every mechanism follows from that one rule:

- A negative is **never stored**. `quest_completion` and `quest_daily` have no
  `completed` column — a row's *existence* is the fact. `quest_cursor` stores *coverage*
  (which block ranges were walked) and the verdict is derived on read, so a proven false is
  computed, never remembered.
- An unregistered quest id is a **400**, not a `false`. A registered-but-unavailable one
  (`daily_active` today) is a **200 indeterminate**, because it is an id the platform will
  really call.
- Contract addresses have **no compiled-in defaults**, in the indexer *and* the read path. A
  superseded contract stays immutable and keeps answering calls — a stale default would let the
  service index a contract nobody uses, report itself perfectly fresh, and hand out confident
  falses. Missing config kills the process (indexer) or returns 503 `not_configured` (API).
- `quest_daily` is the **one** table where absence means "no", so the freshness gate is read
  before it *every time* and **fails closed six ways**: missing source row, short row count,
  read failure, wall-clock age, block lag, and `head < last_block`. The last is the nasty one
  — after a chain re-genesis the watermark sits above the new head, the lag subtraction goes
  negative and reads as *perfect freshness*, and a naive check would hand out confident falses
  forever. Recovery: `delete from indexer_state where chain_id = 4441;` then restart.
- Freshness is the **minimum across all four sources**, never an average. A wallet whose only
  activity today was a bet must not be reported inactive because the factory indexer alone fell
  behind.
- **The forward indexer has absolute priority over the settler.** A lagging index is the only
  thing that can make the endpoint lie; a lagging settler just means "not yet" for longer.

**The 8h factory redeploy (2026-07-22).**
The prediction strike is fixed at `t0`, so the betting window is exactly how stale the strike
can get while bets are still open. Live 24h markets averaged ~1.0% strike drift (max 2.70%)
with betting open. Shortening the longest frame from 24h to 8h cuts the betting window from
23.5h to 7.5h. The settlement window is unchanged at 1,800s, so the 60% TWAP coverage gate
still clears ~10–12× at 300s staleness, and `label == total life` still holds across all four
frames. The old factory is **immutable and cannot be upgraded**, so it was left to drain — its
live markets were all empty-book (0/0 pools), so they VOID with no funds stranded. It still
answers calls, which is exactly why a hardcoded fallback address would be a live trap: a build
pointed at it looks perfectly healthy while showing markets nobody trades. The old factory is
still *scanned* by the quest API, because bets placed there before the redeploy are real bets.

**Tachy educates; it never advises.**
The line is drawn in the system prompt (`frontend/api/_lib/systemPrompt.js`, which is the
spec — the supplemental blocks may only *add*, and a contradiction there is the bug):

- **Allowed** — what leverage means, what a liquidation price is, what % move liquidates you,
  how parimutuel payouts work, what funding is, tradeoffs of high vs low leverage. Product-safety
  philosophy is fine ("high leverage is how most people blow up early").
- **Never** — predicting price, "is now a good time", telling anyone what to pick. Asked
  "should I long?", it explains the tradeoff factually and asks about *their* risk tolerance.
- **Never invents** — no TVL, holder counts, mainnet date, token/airdrop plans, or live prices.
  `knowsAnswer: false` and a pointer to the app or the team.
- v1 **places no trades** at all. Asked to, it points at the trade interface.

---

## 6. HOW TO VERIFY EACH SERVICE IS HEALTHY

### Quest API — the endpoint answers

```bash
curl -sX POST https://app.tachyonfi.xyz/api/quest/verify \
  -H 'content-type: application/json' \
  -d '{"address":"0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292","quest":"first_trade"}'
```

Healthy = a JSON envelope with `status` and `checkedThroughBlock`. `indeterminate` with
`reason: "budget_exhausted"` on a deep-history wallet is **correct behaviour**, not a fault —
the scan ran out of budget and honestly said so; `coverage[].remaining` tells you how far it
still has to walk. A 503 `not_configured` means an address env var is unset.

`daily_active` today returns `reason: "needs_indexer"`. After the §3 merge, the reasons to
expect are:

| `reason` | Meaning |
|---|---|
| *(none)*, `status: confirmed` | Answered. `completed` is trustworthy. |
| `indexer_stale` | The freshness gate refused. Diagnose with the SQL below. |
| `day_boundary` | Within ~15 min after 00:00 UTC. Expected, self-clearing. |
| `index_unreadable` | `quest_daily` could not be read — Supabase problem. |

### Quest indexer — the watermarks are moving

The single most informative check. Run it in the Supabase SQL editor:

```sql
select source_key, last_block, updated_at, now() - updated_at as age
from indexer_state where chain_id = 4441;
```

Expect **4 rows** (`positionManager`, `liquidityPool`, `predictionFactory`,
`predictionFactoryOld`), `age` under ~2 minutes, `last_block` climbing between two runs a
minute apart.

- **0 rows** → never successfully indexed. Is the service running at all?
- **fewer than 4** → a source is missing, usually a changed address: the row is keyed by
  address, so a redeploy self-invalidates and starts fresh. Correct, but reads stale until it
  catches up.
- **`age` growing** → process is down, crash-looping, or wedged.
- **`last_block` static but `age` small** → running and finding no new blocks. Fine on a quiet
  chain; the guarded write refreshes `updated_at` without moving the watermark, which is why
  `age` alone is not enough.

Railway logs, every tick:

```
[indexer] head 33421655 — positionManager:33421635(+0) liquidityPool:33421635(+0) …
```

`(+n)` is rows written. `[settler]` lines appear only when there is work *and* the index is
caught up. React to: `contract preflight failed … NO CONTRACT CODE` (wrong address, startup
refused), `… failed, watermark held` (persistent = bad), and **no `[indexer]` line for minutes**
(hung — restart).

Map `indexer_stale` back to which of the six conditions fired (the `detail` is logged
server-side but not returned): fewer than 4 rows → missing source; `age` > 15 min → wall-clock;
`head − min(last_block)` > ~2,800 blocks → block lag; watermark **above** head → chain reset,
fix with `delete from indexer_state where chain_id = 4441;` + restart.

### Tachy — the assistant answers

```bash
curl -sX POST https://app.tachyonfi.xyz/api/tachy \
  -H 'content-type: application/json' \
  -d '{"message":"What is TachyonFi?"}'
```

Note the field is **`message`** (singular string), not `messages` — the wrong shape returns
400 `missing_message`. Healthy = `{"ok":true, "reply":{...}, "meta":{"fallback":false}}`.
`"fallback":true` means the provider failed or the quota tripped and an in-character canned
reply was served — check `meta.reason`, and suspect the free-tier ceiling (§4 item 5).

### Perp keeper — it is filling

No HTTP surface. Check Railway logs for the startup banner
(`keeper account: 0xCCd1…5748 (dedicated — earns the fill fee)`) and for fill lines. Confirm
on-chain that the keeper key still has zkLTC for gas:

```bash
cast balance 0xCCd143E9Ae97E82a178A9E99799c4EA52ff35748 --rpc-url "$LITVM_RPC_URL"
```

If it dies, requests stop being filled and the money path stalls. **Highest priority of the
three.** Runbook: `docs/TESTNET_LAUNCH.md`.

### Prediction keeper — you cannot, from here

No source, no logs reachable from this repo. Indirect check only: markets on the live factory
should keep advancing phases and settling. See §2.

### Frontend / landing — deploys are green

```bash
gh api repos/KellyNorm/perps-litvm/commits/main/status \
  --jq '.statuses[] | "\(.context) -> \(.state)"'
```

Expect four contexts green: two Vercel, two Railway. (Docs-only commits may show only the
Vercel pair — Railway skips builds with no watched-path changes.)

### The repo itself

```bash
cd /workspaces/perps-litvm/perps-litvm   # the INNER repo — always
forge test && forge fmt --check          # 306 perps tests; +412 on feat/prediction-8h-window
```
