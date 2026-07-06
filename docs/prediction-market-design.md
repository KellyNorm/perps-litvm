# Prediction Market — Step 0 Design

**Status:** DESIGN (Step 0). No contracts written yet. This document is the blueprint;
it is the thing to review before any money-path Solidity exists.

**Branch:** `feat/prediction-market`
**Network:** LitVM LiteForge testnet, chain **4441**, gas token **zkLTC**.
**Bet currency:** **mUSD** (`MockERC20` at `0x4aedab95d41a31f891ee12d13cd77102705e2def`) — the
same token the perps use, but held and accounted in a **completely separate** contract.

---

## 0. One-paragraph summary

A **parimutuel binary prediction market**: repeatedly, the protocol lists short-lived
"will the price be above the strike at expiry?" markets on 11 DIA-fed assets. Bettors stake
mUSD on **UP** or **DOWN**. Betting closes at a **lock** time; a **TWAP settlement window**
runs *entirely after* the lock; the outcome compares that TWAP against a strike set at market
creation. Winners split the whole pool pro-rata. An **auto-factory** keeps ~7 staggered
markets alive so there is *always* at least one bettable market. Prices come **only** from
**DIA** via an oracle-agnostic `AggregatorV3` interface — the perps' RedStone path is not
touched. A **dedicated, isolated keeper** (own program, own key, own Railway service) drives
replenishment, TWAP sampling, and settlement.

---

## 1. Hard boundaries (non-negotiable, from the constitution + this task)

1. **Perps are provably untouched.** No edits to `src/PositionManager.sol`,
   `src/LiquidityPool.sol`, `src/Governance.sol`, `src/PriceReader.sol`, or their ABIs. The
   prediction market is **new files only** under `src/prediction/` and a **new keeper**
   under `prediction-keeper/`. A reviewer can confirm the boundary with `git diff --stat` —
   nothing outside those two new trees should change.
2. **Funds are segregated.** The prediction contract holds its **own** mUSD balance and its
   **own** per-market accounting. It never calls, reads, or shares storage with the perps LP
   or PositionManager. A drain bug in one system cannot reach the other's funds.
3. **Oracle segregation.** Prediction markets read **DIA only**, through a Chainlink-style
   `IAggregatorV3` adapter. Perps keep RedStone. Neither depends on the other's oracle.
4. **Randomness never touches money.** On-chain randomness is used *only* to pick which
   asset/timeframe to list next. No payout, strike, or settlement value is ever derived from
   randomness.
5. **Money-path discipline.** Reasoning (this doc) → tests → implementation. CEI +
   `ReentrancyGuard` on every fund-moving function. `SafeERC20`. Round **down** on payouts.
   `immutable`/`constant` wherever possible; minimal, documented admin powers.

---

## 2. Assets — the 11 DIA feeds (config-driven, NOT the perp registry)

The perp on-chain registry only knows BTC/ETH. The prediction market's asset set is
**independent** and **configured at deploy** as a list of DIA feed adapters:

| # | Symbol | Notes |
|---|--------|-------|
| 1 | BTC | |
| 2 | ETH | |
| 3 | BNB | |
| 4 | XRP | |
| 5 | SOL | |
| 6 | TRX | |
| 7 | HYPE | |
| 8 | DOGE | |
| 9 | RAIN | |
| 10 | ZCASH | |
| 11 | LTC | |

Each asset is stored as:

```solidity
struct Asset {
    string  symbol;        // "BTC" (display + keeper labeling)
    address feed;          // DIA AggregatorV3 adapter for this asset
    uint8   feedDecimals;  // cached decimals() of the feed (e.g. 8)
    uint8   displayDp;     // UI display precision (per-asset; e.g. BTC 0, DOGE 5)
    bool    enabled;       // governance can disable a feed without deleting history
}
Asset[] public assets;     // index = assetId
```

- **Feed addresses are set at deploy** via the constructor / an `addAsset` admin call. The
  set is **configurable** — governance can `addAsset` / `setAssetEnabled` as DIA ships or
  retires feeds, without redeploying. Disabling only stops *new* markets on that asset;
  in-flight markets settle normally.
- `feedDecimals` and `displayDp` are per-asset so strike/settlement math and UI rounding are
  correct across a $100k BTC and a $0.0001 asset alike.
- **All 11 must be live at deploy.** The factory selection (§6) only ever draws from
  `enabled` assets.

---

## 3. Oracle — DIA via an oracle-agnostic `IAggregatorV3`

DIA on LitVM exposes Chainlink-compatible adapters. We read through a minimal interface so
the market is **oracle-agnostic** (swap DIA for anything AggregatorV3-shaped without touching
market logic):

```solidity
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80  roundId,
        int256  answer,        // price, scaled by decimals()
        uint256 startedAt,
        uint256 updatedAt,     // <-- staleness anchor
        uint80  answeredInRound
    );
}
```

**Reading rules (enforced on every read):**

- `answer > 0` — reject zero/negative.
- `updatedAt != 0` and `block.timestamp - updatedAt <= MAX_STALENESS` — reject stale.
- `answeredInRound >= roundId` — reject incomplete rounds.
- A read that fails **any** check is treated as "no price" — it can never be silently
  coerced to 0. Depending on phase this either blocks the action (creation) or, at
  settlement, contributes to a **void** (§5.4) rather than a wrong outcome.

`MAX_STALENESS` is a constant (recommend **120 s** for testnet; tune to DIA's observed update
cadence). This is the "tight staleness window" the constitution demands for any fund-moving
price.

> Perps keep `MainDemoConsumerBase` / RedStone. The prediction market imports **none** of
> that. The two oracle stacks are code-disjoint.

---

## 4. Market lifecycle & timeline

Every market is a struct inside **one** contract (see §8 — we do **not** deploy a contract
per market). Timeframe `T ∈ {5m, 15m, 1h}` is the *total* life from creation to expiry.

```
 create (t0)                 lock (tLock)                   expiry (tExpiry)
    │  ── betting OPEN ──────────│  ── TWAP settlement window ──│  ── settle/claim ──▶
    │                            │                              │
 strike = DIA price(t0) ± offset │  no new bets; keeper pushes  │  outcome = TWAP vs strike
                                 │  observe() samples here      │
```

- **OPEN** `[t0, tLock)` — bets accepted. `tLock = t0 + betWindow`.
- **LOCKED / settlement window** `[tLock, tExpiry)` — **no new bets**; the keeper (or anyone)
  pushes `observe()` samples of the DIA price. `tExpiry = t0 + T`.
- **SETTLED / VOID** `>= tExpiry` — `settle()` computes the TWAP over the window and fixes the
  outcome; `claim()` pays winners (or refunds).

The settlement window **sits entirely after the betting lock** — a bettor can never place a
bet inside the window that determines the result, killing last-second-bet-then-settle games.

**Timeframe split (recommended):** betting window = **⅔·T**, settlement window = **⅓·T**.

| T | betWindow `[t0,tLock)` | settlement window `[tLock,tExpiry)` |
|-----|-----|-----|
| 5m | 200 s | 100 s |
| 15m | 600 s | 300 s |
| 1h | 2400 s | 1200 s |

(Exact split is a deploy constant per timeframe; ⅔/⅓ balances "enough time to bet" against
"a TWAP window long enough to resist a single-block spike.")

---

## 5. Parimutuel math + ALL edge cases

### 5.1 The pools

Per market, two pools of mUSD:

```solidity
uint256 upPool;     // total staked on UP  (settle TWAP >  strike)
uint256 downPool;   // total staked on DOWN(settle TWAP <  strike)
mapping(address => uint256) upStake;
mapping(address => uint256) downStake;
```

`bet(marketId, side, amount)` (OPEN only): `SafeERC20.safeTransferFrom` the mUSD in, add to
the side's pool and the better's stake. Minimum bet `MIN_BET` (e.g. 1 mUSD) to bound dust and
griefing.

### 5.2 Outcome

Let `S` = settlement TWAP (§7), `K` = strike.

- `S > K` → **UP wins**
- `S < K` → **DOWN wins**
- `S == K` → **TIE** → **void** (§5.5)

### 5.3 Payout (normal two-sided market)

Let `W` = winning pool, `L` = losing pool, `P = W + L`. Protocol fee `feeBps` is taken from
the **losing** pool only (winners always get at least their stake back):

```
feeAmount   = L * feeBps / 10_000
distributable = P - feeAmount            // = W + L - fee
payout(user) = winStake(user) * distributable / W    // rounded DOWN
```

- A winner with stake `s` receives `s * distributable / W`. Since `distributable >= W`, a
  winner never receives less than their stake (fee only ever eats losing-side money).
- **`feeBps` recommendation: default `0` on testnet** (pure parimutuel, maximally fair and
  easy to reason about). It is a governable constant, `feeBps <= FEE_CAP` (cap e.g. 300 =
  3%), and any fee accrues to a **treasury address inside this contract's own balance** — it
  is *never* routed to the perps LP.
- **Rounding dust:** payouts round down; the un-distributed remainder (at most `W` wei-ish)
  stays in the contract and is swept to treasury by an admin `sweepDust(marketId)` only
  **after** the market is fully claimed/expired. Dust can never block a claim.

### 5.4 Claiming

`claim(marketId)`:
1. Require `SETTLED` (or `VOID`).
2. Compute the caller's payout/refund from stored stake + fixed outcome.
3. Zero the caller's stake **before** transfer (CEI), then `safeTransfer`.
4. `nonReentrant`.

Winners on the losing side get 0. Idempotent: a second claim pays 0.

### 5.5 Edge case — EXACT TIE (`S == K`)

Ties **will be common** — near-the-money strike + coarse feed precision means `S == K`
happens for real. Deterministic fair rule:

> **On an exact tie the market is VOID: every bettor is refunded their full stake, on both
> sides, and `feeBps` is waived (fee = 0).**

No side is arbitrarily favored, nothing is left to a coin flip, and no funds are stranded.
This is the same refund machinery as §5.6/§5.7, reached by the `S == K` branch in `settle()`.

### 5.6 Edge case — ONE-SIDED POOL (`upPool == 0` XOR `downPool == 0`)

If, at lock, all stake is on one side (the other pool is empty), there is **no counterparty
to win against**. Even if the one-sided crowd is "right," there is nothing to win.

> **A one-sided market is VOID: everyone is refunded their full stake; fee = 0.**

Detected at `settle()`: if `upPool == 0 || downPool == 0`, skip TWAP entirely and mark
`VOID`. (No oracle read is even needed — cheaper and unmanipulable.)

### 5.7 Edge case — ZERO PARTICIPANTS (`upPool == 0 && downPool == 0`)

Nobody bet. Nothing to refund, nothing to settle.

> **Marked `VOID` (or `CLOSED`) with no transfers.** `settle()` on an empty market just flips
> state so the factory can retire it. No oracle read, no payouts, no dust.

### 5.8 Edge case — UNSETTLEABLE PRICE (oracle can't produce a valid TWAP)

If the settlement window did not collect enough fresh samples to form a trustworthy TWAP
(§7), the market **cannot** be settled to a real outcome. To avoid **locking funds forever**:

> **After `tExpiry + SETTLE_GRACE`, if `settle()` still cannot form a valid TWAP, the market
> becomes `VOID` and everyone is refunded their full stake.** `SETTLE_GRACE` (e.g. 1 h) gives
> the keeper time to push samples before the safety refund opens.

This is the "never strand user funds" backstop. It also means a dead keeper degrades to
*refunds*, never to *stuck money* or a *wrong outcome*.

### 5.9 Edge-case summary table

| Condition (at settle) | Result | Fee | Transfers |
|---|---|---|---|
| `up>0 && down>0 && S>K` | UP wins | on losing pool | pro-rata to UP |
| `up>0 && down>0 && S<K` | DOWN wins | on losing pool | pro-rata to DOWN |
| `S == K` (exact tie) | **VOID** | 0 | full refund both sides |
| one-sided pool | **VOID** | 0 | full refund |
| zero participants | **VOID/CLOSED** | 0 | none |
| no valid TWAP by `tExpiry+GRACE` | **VOID** | 0 | full refund |

Every non-clean path lands on the **same** conservative primitive: *full refund, no fee*.
That is deliberate — the only ways to lose your stake are (a) you bet and were wrong against a
real counterparty. Everything ambiguous refunds.

---

## 6. Strike logic (near-the-money, all 11 assets)

At **creation** (`t0`), read the DIA price `p0` (with all §3 checks — a market cannot be
created on a stale/invalid feed):

```
strike K = p0 * (10_000 ± offsetBps) / 10_000
```

- **Proportional, not absolute.** The offset is a **percent of price** (`offsetBps`), so the
  same setting is meaningful for BTC and for a sub-cent asset. No per-asset absolute tuning.
- **Default `offsetBps = 0` → strike = spot → a fair ~50/50 market.** This is the
  recommended default. `offsetBps` is a governable constant capped small (e.g.
  `OFFSET_CAP = 50` = 0.5%); direction (bias UP or DOWN) is a stored flag if ever used.
  Recommendation: **ship at 0** and only introduce an offset if you deliberately want a house
  lean — and if you do, keep it symmetric/disclosed.
- **Precision.** `K` is stored at the feed's native `feedDecimals`. `displayDp` drives UI
  rounding only; the on-chain comparison `S vs K` is always at full feed precision. Because
  both `S` and `K` are integers at the same scale, `S == K` is exact and deterministic — the
  tie rule (§5.5) is well-defined.
- Strike is fixed at creation and **immutable** for the life of the market.

---

## 7. TWAP settlement window (manipulation-resistant `S`)

`S` is a **time-weighted average** of DIA observations taken **only inside** `[tLock,
tExpiry)`.

### 7.1 Sampling — `observe(marketId)`

- Permissionless; the dedicated keeper calls it on a cadence (e.g. every ~15–30 s) during the
  window. Anyone may call it (keeper failure ⇒ community can still settle).
- Each call reads DIA `latestRoundData`, applies **all** §3 checks (reject stale/zero/
  incomplete), and appends an observation:

```solidity
struct Obs { uint64 ts; int256 price; }   // ts = block.timestamp, clamped to window
Obs[] observations;   // per market
```

- Guards: only within the window; enforce a **min spacing** between samples
  (`MIN_OBS_SPACING`, e.g. 10 s) so one caller can't spam-weight a single instant; dedupe on
  DIA `roundId` if unchanged is acceptable (still advances time weight).

### 7.2 TWAP computation at `settle()`

Time-weight each observation over the interval it "owns" (stepwise/last-observation-carried),
clamped to `[tLock, tExpiry)`:

```
S = Σ ( price_i * (t_{i+1} - t_i) )  /  (t_last - t_first)
```

**Validity requirements** (else → VOID via §5.8):

- at least `MIN_SAMPLES` observations (e.g. 3), AND
- observations span at least `MIN_COVERAGE` of the window (e.g. 60%), AND
- the **last** observation is fresh (`tExpiry - lastObs.ts <= MAX_STALENESS`).

If valid, `S` is fixed on-chain and the market is `SETTLED`. If not valid by `tExpiry +
SETTLE_GRACE`, `VOID` (refunds).

### 7.3 Why post-lock TWAP

- Bets are closed before *any* sample counts, so no one can bet on information inside the
  settlement window.
- Averaging over ⅓·T of samples makes a single-block spike (flash manipulation) cost far more
  than a point-in-time read would, and one bad DIA tick can't swing the result.
- Staleness + coverage checks mean a frozen/thin feed **voids** (refund) rather than settling
  on garbage — consistent with "never settle a fund-moving action on a stale price."

---

## 8. Contract architecture (ONE contract, factory logic inside)

We do **not** deploy a contract per 5-minute market — that would sprawl gas and addresses and
fragment the mUSD balance. Instead: **one `ParimutuelPredictions` contract** that holds all
funds and stores every market as a struct. "Factory" = internal creation logic.

```
src/prediction/
├── ParimutuelPredictions.sol   // markets, pools, bet/observe/settle/claim, factory logic
├── IAggregatorV3.sol           // oracle-agnostic price interface (§3)
└── (test mocks under test/)     // MockAggregatorV3 for unit tests
```

```solidity
enum Phase { Open, Locked, Settled, Void }

struct Market {
    uint16  assetId;
    uint8   timeframe;     // enum index into {5m,15m,1h}
    uint64  t0;
    uint64  tLock;
    uint64  tExpiry;
    int256  strike;        // feed-decimal scaled, immutable
    uint256 upPool;
    uint256 downPool;
    Phase   phase;
    int256  settlePrice;   // set at settle (the TWAP), 0 until then
    // observations[] + stake mappings keyed by marketId in separate storage
}
Market[] public markets;   // marketId = index
```

- **Immutables:** `mUSD` token address, timeframe durations, `MIN_BET`, staleness/TWAP
  constants. **Governable (capped, documented):** `feeBps`, `offsetBps`, per-asset
  enable/add, `pause`, `treasury`. Every privileged function is listed in §11.
- `ReentrancyGuard` on `bet`, `claim`, `settle` (settle moves no funds but flips state that
  claim reads — guard anyway). `whenNotPaused` on `bet`/`createMarket`; `settle`/`claim`
  work even when paused (users must always be able to exit).
- **No `delegatecall`, no upgradeable proxy** for v1 — fixed, auditable bytecode. (Perps'
  governance/pause pattern can be mirrored later if needed, but kept independent.)

---

## 9. Auto-factory — ~7 staggered markets, random, never all-locked

### 9.1 Invariant

> **At every block there is ≥ 1 market in `Open` phase (bettable).** Target a rolling set of
> ~7 active markets (Open or Locked) staggered across assets/timeframes.

### 9.2 `replenish()` (permissionless; keeper-driven)

```
1. Reap: any market past tExpiry → settle() it (or mark it settleable).
2. Count active (Open|Locked) markets = A, and open markets = O.
3. While A < TARGET_ACTIVE (=7):
     pick (assetId, timeframe) via randomized selection (§9.3)
     createMarket(assetId, timeframe)   // strike from DIA at t0, staggered expiry
     A++
4. GUARANTEE: if O == 0 after step 3 (e.g. all newly-created somehow locked — can't happen
   with fresh Open markets, but assert), force-create one 5m Open market.
```

Because every freshly created market **starts Open** and `replenish()` refills whenever the
active count dips, and locks are staggered in time, there is always ≥1 Open market. The
"never all-locked" guarantee is structural (count + fresh-Open creation), independent of the
random draw — randomness picks *variety*, not *availability*.

**Staggering:** new markets get spread start times / mixed timeframes so their locks don't
all land at once. Practically: `replenish()` creates at most one or a couple markets per call
and the keeper calls it frequently, so creations naturally spread across time; timeframe mix
(5m/15m/1h) spreads the locks further.

### 9.3 Randomized selection (selection ONLY — never payouts)

```
seed = keccak256(block.prevrandao, block.timestamp, marketCount, assetsLen)
assetId   = enabledAssets[ seed % enabledAssetsLen ]
timeframe = TIMEFRAMES[ (seed >> 128) % 3 ]
```

- Draws only from **enabled** assets.
- **De-dup:** if the drawn `(assetId, timeframe)` already has a live Open market, advance
  deterministically to the next enabled asset (linear probe) so the ~7 markets stay varied
  rather than 7 identical BTC-5m markets.
- **Randomness caveat (documented, acceptable):** on Arbitrum Nitro `block.prevrandao` is
  sequencer-influenced and *not* secure randomness. That is **fine here by construction** —
  it only decides *which asset/timeframe to list*. No strike, no TWAP, no payout, no fee, and
  no refund depends on it. The worst a manipulator achieves is choosing that the next listed
  market is, say, ETH-15m instead of SOL-5m — which carries no financial edge because they
  still have to bet into a fair parimutuel and settle against DIA.

### 9.4 Why permissionless

`replenish()`, `observe()`, and `settle()` are all permissionless so the market **self-heals
without a keeper**: the dedicated keeper is the *efficient* driver, but a dead keeper doesn't
freeze the system — anyone (including a bettor who wants their market settled) can advance it,
and the §5.8 grace-refund guarantees no stuck funds even in the worst case.

---

## 10. Dedicated prediction keeper (separate program, key, Railway service)

**Fully isolated from the perp keeper.** New directory, new process, new key, new Railway
service. It shares *nothing* with `keeper/` except the RPC endpoint (a public URL, not a
secret).

```
prediction-keeper/
├── keeper.mjs           // main loop (ethers v5, ESM) — mirrors keeper/ conventions
├── lib/
│   ├── abi.mjs          // vendored ParimutuelPredictions ABI (no Foundry at runtime)
│   └── dia.mjs          // optional: DIA read helpers / labels
├── abi/
│   └── ParimutuelPredictions.json
├── package.json         // "start": "node keeper.mjs", engines node >=20 <23, ethers ^5
├── railway.json         // NIXPACKS, restartPolicy ON_FAILURE, numReplicas 1
├── .env.example
└── .gitignore           // .env, logs/
```

**Responsibilities (loop, every `PRED_KEEPER_LOOP_MS`):**

1. `replenish()` — keep ~7 markets / ≥1 Open (idempotent; cheap no-op when full).
2. For each market in its settlement window `[tLock, tExpiry)`: call `observe()` on cadence
   (respecting `MIN_OBS_SPACING`) to build the TWAP.
3. For each market past `tExpiry`: call `settle()`.
4. (Optional) proactively `claim()`-nudge nothing — claims are user-driven; keeper does not
   custody or auto-pay.

**Isolation guarantees:**

- **Own key** `PRED_KEEPER_PRIVATE_KEY` — a fresh dedicated account, NOT the deployer, NOT
  the perp keeper key. Funded with a little zkLTC for gas.
- **Own Railway service** — separate deploy, separate secret store, separate logs. A crash or
  compromise of one keeper cannot touch the other.
- **Own restart policy** (`ON_FAILURE`, backfills active set from chain on boot — restart is
  idempotent because all state is on-chain; the keeper holds no local state).
- Same `railway.json`/root-deploy resolution lessons as the perp keeper apply (vendored ABI,
  `start` script, `ethers` in deps) so it runs on a root NIXPACKS deploy without Foundry.

---

## 11. Privileged functions (minimize + document — constitution rule)

| Function | Who | Cap / guard | Purpose |
|---|---|---|---|
| `addAsset(sym, feed, dp)` | governance | must be a valid AggregatorV3 (reads `decimals()`) | onboard a DIA feed |
| `setAssetEnabled(id, bool)` | governance | in-flight markets still settle | pause new markets on an asset |
| `setFeeBps(bps)` | governance | `<= FEE_CAP` (e.g. 300) | protocol fee (default 0) |
| `setOffsetBps(bps, dir)` | governance | `<= OFFSET_CAP` (e.g. 50) | strike offset (default 0) |
| `setTreasury(addr)` | governance | non-zero | fee/dust sink (segregated) |
| `pause()/unpause()` | governance | `bet`/`create` gated; `settle`/`claim` NEVER gated | incident halt |
| `sweepDust(marketId)` | governance | only after settled + grace | reclaim rounding dust to treasury |

- No admin can touch a user's stake, alter a strike, alter a settled outcome, or move pooled
  funds except the capped fee/dust to treasury. **There is no `withdraw everything` admin
  path.** Users can always `claim`/refund even while paused.
- `governance` = the same account/pattern as perps *only if convenient*; funds remain
  segregated regardless. Recommend a dedicated owner for clean separation.

---

## 12. Definitive env list

### 12.1 Prediction keeper (`prediction-keeper/.env`, gitignored)

```bash
# LitVM LiteForge testnet (chain 4441). Public RPC — not a secret.
LITVM_RPC_URL=https://liteforge.rpc.caldera.xyz/infra-partner-http

# DEDICATED prediction-keeper key — its OWN fresh account. NOT the deployer,
# NOT the perp keeper key. Funded with a little zkLTC for gas.
PRED_KEEPER_PRIVATE_KEY=0xYOUR_DEDICATED_PREDICTION_KEEPER_KEY

# Deployed prediction contract (chain 4441). Filled after deploy.
PREDICTION_ADDRESS=0x...

# mUSD collateral token — read-only here (labeling / fee reporting).
MUSD_ADDRESS=0x4aedab95d41a31f891ee12d13cd77102705e2def

# --- Optional tuning ---
# Main-loop period, ms (default 5000).
# PRED_KEEPER_LOOP_MS=5000
# Observation cadence during settlement window, ms (>= MIN_OBS_SPACING on-chain).
# PRED_OBSERVE_MS=20000
# Log hint for where live listeners attach; state is reconciled from chain regardless.
# START_BLOCK=
```

### 12.2 Deploy-time (Foundry `.env`, gitignored — perps' existing file, extended)

```bash
# Existing perps deploy vars stay as-is. Add for the prediction deploy script:
PRED_MUSD_ADDRESS=0x4aedab95d41a31f891ee12d13cd77102705e2def
PRED_TREASURY_ADDRESS=0x...            # fee/dust sink (segregated)
PRED_FEE_BPS=0                         # default fair 50/50
PRED_OFFSET_BPS=0                      # default strike = spot
# 11 DIA feed adapter addresses (one per asset), set at deploy:
DIA_FEED_BTC=0x...
DIA_FEED_ETH=0x...
DIA_FEED_BNB=0x...
DIA_FEED_XRP=0x...
DIA_FEED_SOL=0x...
DIA_FEED_TRX=0x...
DIA_FEED_HYPE=0x...
DIA_FEED_DOGE=0x...
DIA_FEED_RAIN=0x...
DIA_FEED_ZCASH=0x...
DIA_FEED_LTC=0x...
```

**No secrets in the repo.** Only `.env.example` templates are committed; real keys live in
Railway's secret store and local gitignored `.env` files.

---

## 13. Build order (each step its own PR, tests-first on money paths)

0. **This design** (`feat/prediction-market`) — review + commit. ← you are here.
1. **`IAggregatorV3` + `MockAggregatorV3`** — interface + a test mock (settable price,
   updatedAt, decimals). Pure, no funds. Unit tests for the §3 read guards.
2. **Core market: bet + pools + strike** — `ParimutuelPredictions` with `createMarket`,
   `bet`, phase transitions, strike-from-DIA. Tests: bet accounting, phase gating, min bet,
   OPEN-only enforcement. *No* settlement yet.
3. **TWAP + settle + outcome** — `observe`, TWAP math, `settle` with the full §5 outcome
   matrix. Tests: UP/DOWN win, exact tie→void, one-sided→void, zero→void, stale/thin→void,
   coverage/min-samples, staleness.
4. **Claim + refund + fee + dust** — `claim`, refund paths, fee-on-losing-pool, dust sweep.
   Tests: pro-rata correctness, rounding-down never over-pays pool, idempotent claim, refund
   totals == deposits (conservation), fee cap, paused-still-claimable.
5. **Auto-factory** — `replenish`, randomized selection, de-dup, staggering, never-all-locked
   invariant. Tests: invariant holds across many cycles; selection only draws enabled assets;
   randomness changes nothing financial.
6. **Admin/governance** — capped setters, pause semantics, treasury. Tests: caps enforced,
   no admin fund path, paused exits still work.
7. **Deploy script** (`script/DeployPredictions.s.sol`) — wires 11 feeds from env, treasury,
   defaults. Deploy to 4441, record addresses.
8. **Prediction keeper** — `prediction-keeper/` service, vendored ABI, Railway deploy with a
   fresh dedicated key. Verify unattended replenish→observe→settle on-chain.
9. **Frontend surface** (separate track) — a Predictions tab reading DIA marks + open markets,
   bet/claim UI. Perps UI untouched.

**Money-path steps (2,3,4,5) follow the rule: reasoning (this doc) → tests → implementation,
CEI + `nonReentrant` + `SafeERC20`, and a conservation invariant test (sum of payouts+refunds
+fee+dust == sum of deposits) on every settlement path.**

---

## 14. Invariants a reviewer/auditor should be able to assert

1. **Conservation:** for any market, `Σ(payouts) + Σ(refunds) + fee + sweptDust == upPool +
   downPool`. No path mints or strands mUSD.
2. **No over-pay:** rounding is always down; the contract can never owe more than it holds.
3. **Segregation:** the contract's mUSD balance ≥ Σ(unclaimed obligations) at all times;
   nothing reads/writes perps storage; `git diff` touches only `src/prediction/**` and
   `prediction-keeper/**`.
4. **Availability:** ≥1 Open market exists whenever `replenish()` has been called within the
   last loop period (and the §5.8 grace guarantees eventual exit even if it hasn't).
5. **Price safety:** every fund-affecting price passes the §3 guards; a market never settles
   to a real outcome on a stale/thin/invalid feed — it voids and refunds instead.
6. **Randomness isolation:** removing/altering the RNG changes *only* which asset/timeframe is
   listed; every stake, payout, and refund is identical.

---

*End of Step 0 design. Nothing here is deployed or written as Solidity yet. Next action after
review: Step 1 (`IAggregatorV3` + `MockAggregatorV3`) on this branch.*
