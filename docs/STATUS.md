# STATUS — the map for whoever picks this up next

Written 2026-07-26, updated 2026-07-27 (quest API completed — §3). Chain **4441** (LitVM
LiteForge) throughout. Everything here is testnet,
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
| **Quest API** | `POST /api/quest/verify` | Live. **All 5 quests answerable** as of 2026-07-27 (§3). |

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
connection.** Nothing automated may provision or migrate it. Five tables, migrations checked
in under `supabase/migrations/` and **applied by hand, in numeric order** (`supabase/README.md`):

| Migration | Table | Purpose |
|---|---|---|
| `0001_quest_completion.sql` | `quest_completion` | durable verdict cache |
| `0002_quest_cursor.sql` | `quest_cursor` | resumable deep-history scan coverage |
| `0003_quest_daily.sql` | `quest_daily` | `daily_active` participation index |
| `0004_indexer_state.sql` | `indexer_state` | indexer watermark + freshness proof |
| `0005_quest_backfill.sql` | `quest_backfill` | the one-time sweep's coverage, **plus** `indexer_state.completion_from` — the handoff watermark the zero-chunk negative joins against |

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
- **The one-time-quest backfill** (#16, 2026-07-27) — one UNFILTERED sweep per source from
  head to its deploy block, writing a `quest_completion` row for every wallet it finds and
  recording the blocks it read in `quest_backfill`. 426 chunks once for everybody, versus
  1,060 chunks per wallet forever. Runs in the scheduler's leftover time, behind the forward
  index's absolute priority. Also added `indexer_state.completion_from`, set once, never
  moved — the block from which forward completions have been written.
- **The zero-chunk read path** (#17, 2026-07-27) — for a quest whose sources have all been
  swept to the floor, a negative is a lookup rather than a walk. See "the two routes to a
  confirmed false" below. `first_trade` and `first_prediction` are on it; `provide_liquidity`
  is not, and that is the one remaining quest-API task (§4).
- **`daily_active`** (#18, 2026-07-27) — the six-way freshness gate plus a live tail scan;
  merged once the index had a full UTC day behind it. See below.

### The two routes to a confirmed false

Both make the same claim from the same kind of evidence — coverage of every source from a
**validated floor** up to the block being reported, with no hole anywhere in it. Nothing
stores a verdict; both derivations re-run on every request.

1. **The Tier 2 scan** (`scan.js`) — walks it per wallet, accumulating coverage in
   `quest_cursor` across polls. Always available; slow on deep history.
2. **The index proof** (`indexProof.js`) — joins the backfill's coverage to the forward
   index's. Seven conditions, all re-derived per request: a `quest_backfill` row for every
   required source; `floor_block` = the configured floor; `covered_to` **=** `floor_block`
   (equality — "reached the floor"); `covered_from >= completion_from - 1` (the two halves
   touch); `completion_from` not null; the six-way freshness gate; and the floor verified
   on-chain with one `eth_getCode`. Any one failing returns `unproven` and falls back to the
   scan, so the fast path can be wrong only by being slow. Reports
   `checkedThroughBlock = min(last_block)`, never head, and carries an `index` object showing
   where the two coverages meet so a negative is auditable.

Measured on prod 2026-07-27: `first_trade` for a never-active wallet returned a confirmed
false in **1.45s on the first call**, over a proven span of 10,751,715 blocks. The same answer
by scanning is ~1,075 chunks ≈ 54 minutes of `eth_getLogs`, which is why it previously took
~200 polls to converge.

`QUEST_INDEX_PROOF` selects the driver and **defaults to whatever `QUEST_CACHE` is**, so a
deployment already running the durable cache picks it up with no new variable.
`QUEST_INDEX_PROOF=none` is the rollback — effective on the next cold start, no redeploy, and
it leaves the durable cache untouched.

Quest registry (`frontend/api/_lib/quest/quests.js`): `first_trade`, `first_prediction`,
`provide_liquidity` (one-time), `both_products` (composite, no chain calls of its own),
`daily_active` (daily).

### `daily_active` — MERGED and live (2026-07-27)

Held deliberately until the index had a **full UTC day** behind it, and merged once it did.
The reason for the hold, kept here because it is the shape of the bug the whole design guards
against: the indexer starts at the safe head rather than the deploy block (a backfill would be
~10M blocks to answer a question about *today*), so the day it first ran is only *partially*
covered — and a wallet active at 09:00 on a day the index started at 14:00 would have got a
confident `false`.

Timeline: indexer landed on `main` 2026-07-26 ~04:04 UTC → 2026-07-26 partially covered, not
usable → **2026-07-27 the first fully-covered UTC day** → merged 2026-07-27 23:33 UTC (#18)
after confirming all 4 `indexer_state` rows current and advancing across the midnight boundary.

What it does: the six-way fail-closed freshness gate (`indexerState.js`) runs **before**
`quest_daily` is read at all; if it says stale, absence must not be used. Then a row lookup for
(wallet, today), then a live scan of the un-indexed tail above the watermark.

**The post-midnight grace window.** For ~15 minutes after 00:00 UTC, `daily_active` declines to
answer — `reason: "day_boundary"`, distinct from `indexer_stale` and **not a fault**. The
writer and the reader disagree about what day it is by construction: the indexer stamps a row
from its *block's* timestamp (correct — a catch-up run must not file yesterday under today),
while the endpoint asks for the *wall-clock* day (correct — it is answering "was this wallet
active today"). Those agree to within the skew, which is nothing at 14:00 and everything at
00:00:03. The window costs ~1% of the day and removes the entire class, in both directions
(a wrong false just after midnight, and a wrong *true* from a tail-scan hit that was actually
yesterday's activity). Configurable via `QUEST_DAILY_BOUNDARY_GRACE_MS`; `0` disables it.

**Known gap:** the freshness `detail` — which of the six conditions fired — is set by
`checks.js` but **dropped by `verify.js`**, which forwards `reason` only. So an
`indexer_stale` in the envelope does not say *why*, and diagnosis still needs the SQL in §6.
Listed in §4.

---

## 4. PENDING ITEMS

| # | Item | Blocked on |
|---|---|---|
| 1 | **`provide_liquidity` on the zero-chunk path** | The LiquidityPool sweep reaching its floor. This is the **whole remaining scope of the quest work** — the other two one-time quests are already on it (§3). Check with `select source_key, covered_to - floor_block as remaining from quest_backfill where chain_id = 4441;`; `remaining = 0` on `0x4716a0c9…` is the green light. The change is one line in `frontend/api/_lib/quest/quests.js` — `indexSources: provideLiquiditySources` — the function is already exported from `checks.js` and `settlerParity.test.js` already covers it. Safe to add early in the sense that it cannot lie (an unfinished sweep fails `not_at_floor` and falls back to the scan), but it costs three Supabase reads per request to be told so. |
| 2 | **Partner quest integration** | **Us** — the blocker they reported is fixed and unannounced. They integrated `first_trade`, hit a latency wall, and the participation index solved it; they have not re-tested. One message is owed. Full state in **§4.1** — read it before contacting them. |
| 3 | **Tachy v2 / v3** | Not started, and likewise **no spec exists in the repo.** The only in-code trace is a forward-looking `V2 PATH` comment in `frontend/src/components/tachy/TachyAvatar.jsx`. The v1 system prompt says trading-by-chat is "coming soon", which implies v2 ≈ transactional Tachy — but that is an inference, not a spec. Write it down somewhere tracked before starting. |
| 4 | **PositionManager EIP-170 headroom** | **BLOCKING for the next change to that contract.** 23,919 / 24,576 bytes — 657 bytes (~2.7%) of headroom, and `optimizer_runs = 1` is already spent, so the cheap lever is gone. The fix is `refactor/eip170-library-extraction` (move logic into `library` contracts, which `DELEGATECALL` and don't count toward runtime size); branch exists, **PARKED**. The failure shows up at *deploy* time, after the work is written. **Treat "am I adding to PositionManager?" as the trigger — run `forge build --sizes` before writing the feature.** It is money-path code, so per `CLAUDE.md` rule 3 it needs a written plan and an explicit go-ahead before any implementation. |
| 5 | **Tachy Groq free-tier quota** | **A paid tier is a pre-promotion requirement, not an optimisation.** Free tier `llama-3.3-70b-versatile`: RPM 30 / **TPD 100,000**. A call costs ~1,430 prompt + 60–250 completion tokens, so TPM (12,000) binds first at ~7–8 req/min — `TACHY_RPM` defaults to 7. The hard ceiling is **~65 exchanges per day, key-global**, exhausted by one engaged user in a sitting. No per-IP limiter can enforce a key-global cap. Do not promote Tachy until this is paid. (Gemini is worse: 5 req/min global. Switching provider is one env var, `TACHY_PROVIDER`.) |

### 4.1 The partner integration — exact state as of 2026-07-28

The one pending item that is about a **relationship** rather than code, which is why it is
written out rather than left as a table cell. Everything in this subsection came from the
operator; nothing is inferred unless marked.

**What they integrated.** `first_trade` only — "has this wallet opened a position". That is
all they need right now. They have not asked for anything else.

**How they call it.** A **synchronous, user-facing "Verify" button** with a **10-second client
timeout**, needing **p95 under ~2s**. That constraint is the whole story of this integration:
the endpoint's answer is correct at any latency, but theirs is a button a human is watching.

**What they tested against.** 10 provably-real traders pulled from the LiteForge explorer —
wallets that had demonstrably opened positions. A good test set, and an unforgiving one: every
one of them is a *positive*, so any wallet returning `indeterminate` was visibly a failure.

**What went wrong, and what fixed it.** Before the participation index, a `first_trade` answer
for a wallet with no open position meant a per-wallet backward log scan — ~10s of `eth_getLogs`
per poll and ~200 polls to converge, so their button either timed out or got an honest
`indeterminate`. The backfill + zero-chunk read path (§3) turned that into an indexed lookup:
**measured 0.7–1.4s**, first call. The problem they reported is solved.

**They do not know that yet.** They have not re-tested since the fix.

#### The message we owe them

1. `first_trade` is fixed — sub-second to ~1.4s, no longer scan-bound. Re-run the 10-wallet test.
2. Expect `source` to be `"cache"` or `"index"`. Both are correct and both are fast; `cache` is
   a durable stored completion, `index` is a proof recomputed from coverage on that request.
   They should treat them identically and **not** branch on `source` — it is a debugging field.
3. Offer **`first_prediction`**, which is on the same fast path as of 2026-07-27. (*Inference,
   not from the operator:* `both_products` is also available and costs nothing extra once both
   parts are known, since it composes through the same cache-first path.)
4. **Ask whether they re-poll on `indeterminate`.** This is the question that matters most and
   it has never been answered. Our side is built so a negative is never fabricated — an
   unprovable answer returns `indeterminate` rather than `false`. But if their client renders
   `indeterminate` as "not completed" and never retries, that guarantee dies at their boundary
   and a real trader gets denied a reward. **Ask explicitly; do not assume they retry.**

#### The residual risk to state honestly when we contact them

*Marked as inference — the operator did not raise this.* The fast path is not a guarantee of
speed, only of correctness. If the index proof declines for any of its seven conditions — most
plausibly `indexer_stale` if the Railway indexer is down or lagging — `first_trade` falls back
to the Tier 2 scan, which budgets ~10s and can reach ~16–25s worst case against the function's
30s ceiling. **That exceeds their 10s client timeout.** So the honest promise is "fast in the
normal case, and never wrong", not "always under 2s". Either they tolerate an occasional
timeout, or they retry, or we tell them to treat a timeout the same as `indeterminate` — which
is the same question as item 4 above, and another reason to ask it.

#### What we do NOT have — do not invent these

- **No platform name.** Nothing in this repo or any commit identifies the partner.
- **No contact.** No email, handle, or channel is recorded anywhere on our side.
- **No written integration contract.** No agreed endpoint spec, auth scheme, quest-id mapping,
  rate-limit allowance, or SLA. The API is built to be called by a partner platform; the terms
  of that call have never been written down by us.

The rate limiter is worth knowing before any conversation about volume: `QUEST_RPM` defaults to
**10/min** and `QUEST_RPH` to **100/hour**, per-IP and per-instance
(`frontend/api/quest/verify.js`). A partner batch-verifying from one server address would hit
that. It has never been discussed with them.

Also worth fixing, lower priority: get `prediction-keeper/` and `src/prediction/*.sol` under
version control on `main` (§2); and surface the `indexer_stale` `detail` in the response
envelope — `checks.js:322` sets it, `verify.js:390` forwards `reason` only and drops it, which
forces the symptom-to-cause table in `docs/services.md` and the SQL in §6.

**Stale-branch hazard, learned the hard way 2026-07-27.** ~20 unmerged feature branches sit on
this repo, most cut weeks apart. A branch handed over for merging is likely several PRs behind
`main`, and *its last green CI ran against a tree that no longer exists*.
`feat/quest-daily-active-readpath` was fully green, conflicted with `main` in three files, and
git produced a **duplicate `supabaseIndexerStateDriver` import** in `verify.js` with no
conflict marker — both sides added it on different lines, a clean textual merge and a
`SyntaxError` at module load that would have taken down the whole endpoint, `first_trade`
included, on the first request after deploy. Before merging any branch here: check
`git log --oneline <branch>..origin/main`, trial-merge in a scratch worktree, run both suites
(`frontend`, `quest-indexer`) on the merged tree, and validate a conflict resolution by
diffing the merge against **both** parents — deletions vs each parent should only ever be
lines the other side replaced with a superset.

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

`daily_active` is live as of 2026-07-27; `reason: "needs_indexer"` would now mean a rollback
happened. The reasons to expect are:

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

### The backfill sweep — how far down it has got

Governs whether a quest can use the zero-chunk path (§3), and item 1 in §4:

```sql
select source_key, floor_block, covered_from, covered_to,
       covered_to - floor_block as remaining, updated_at
from quest_backfill where chain_id = 4441 order by remaining;
```

`remaining = 0` means that source reached its floor — the equality the read path tests. As of
2026-07-27 PositionManager and both prediction factories are at 0; LiquidityPool is still
descending. Also check the handoff is claimed, or no negative can be derived at all:
`select source_key, completion_from from indexer_state where chain_id = 4441;` — a NULL there
means "not yet proven" and fails closed by design, and is **not** the same as zero.

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
