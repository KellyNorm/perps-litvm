// The quest checks themselves.
//
// CONTRACT FOR EVERY TIER 1 CHECK — read this before adding one:
//   returns { completed, reliable, checkedThroughBlock }
//
//   completed: true   → the wallet HAS done the thing. Permanent; safe to cache forever.
//   completed: false  → the wallet has no CURRENT on-chain state proving it. That is NOT
//                       the same as "never did it": positions close, stakes are claimed,
//                       LP shares are redeemed. A Tier 1 false is only ever a reason to
//                       run the Tier 2 history scan, never an answer on its own.
//   reliable: false   → at least one underlying read failed, so even the `true`/`false`
//                       split is untrustworthy. The caller must degrade to indeterminate.
//
// That asymmetry — a positive is proof, a negative is a hint — is the whole design. It is
// why nothing here may ever return a bare boolean.

// CONTRACT FOR EVERY TIER 2 CHECK:
//   takes (address, opts) and returns the scan result unchanged.
//   found                   → proof. Permanent.
//   !found && complete      → a PROVEN negative: every source covered from a validated
//                             floor up to head — possibly ACROSS SEVERAL POLLS.
//   exhausted               → we ran out of budget or lost a chunk. Indeterminate.
// Tier 2 reuses the head block Tier 1 already fetched, so the two tiers together cost one
// eth_blockNumber, not two.
//
// `opts` is forwarded to scanWithResume() verbatim — {head, cursors, chainId, wallet,
// quest}. A tier2 therefore does not know or care whether coverage is being accumulated;
// it declares its sources and the resume layer decides what still needs walking. Callers
// that pass only {head} get a one-shot scan, exactly as before.

// SOURCES ARE DECLARED ONCE PER QUEST, and both consumers read the same declaration:
//
//   * the Tier 2 scan, which binds each source's filter to one wallet and walks it;
//   * the index proof (indexProof.js), which needs only the address and the floor and
//     requires a completed backfill for EVERY source in the list.
//
// That sharing is load-bearing rather than tidy. If the proof's list were maintained
// separately and lost a source — the draining prediction factory is the obvious candidate,
// since nothing new is written to it — the proof would demand coverage of one factory and
// then report a confirmed false about a wallet whose only bet was on the other. A quest's
// sources are one list, in one place, and `filterFor` is what lets the scan still be
// per-wallet.

import {
  batchRead,
  chainId,
  deployBlocks,
  headBlock,
  liquidityPoolRead,
  marketKey,
  positionKey,
  positionManagerRead,
  predictionFactoryOldRead,
  predictionFactoryRead,
} from "./chain.js";
import { scanWithResume } from "./cursor.js";
import { scanForEvent } from "./scan.js";
import { DAY_BOUNDARY, maxLagBlocks, withinDayBoundaryGrace } from "./indexerState.js";
import { requiredSourceKeys, tailScanSources } from "./dailySources.js";
import { utcDay } from "./cache.js";

/**
 * Bind a quest's declared sources to one wallet — the shape scanForEvent wants.
 * `filterFor` is dropped rather than carried, so nothing downstream can re-bind a source
 * that has already been bound to somebody.
 */
function forWallet(sources, wallet) {
  return sources.map(({ filterFor, ...source }) => ({ ...source, filter: filterFor(wallet) }));
}

// The markets PositionManager actually supports for perps. bytes32("BTC") / bytes32("ETH")
// are MARKET_BTC / MARKET_ETH on-chain. SOL/LTC appear in the frontend's CANDIDATE_MARKETS
// but are probed for support at runtime there; adding one here costs 2 more reads.
const TRADE_MARKETS = ["BTC", "ETH"];

/**
 * first_trade, Tier 1: does the wallet hold an OPEN position right now?
 *
 * 4 reads — {BTC,ETH} × {long,short} — in a single Multicall3 round trip. The position
 * key is derived locally (getPositionKey is `pure`), which is what keeps this at 4 calls
 * instead of 8.
 *
 * A closed position leaves sizeUsd == 0, so a false here falls through to the
 * PositionOpened scan.
 */
export async function firstTradeTier1(address) {
  const pm = positionManagerRead();

  // Head is sampled BEFORE the reads, never after: the batch may land on a later block,
  // and claiming to have checked through a block we had not yet reached would be a lie
  // in the direction that matters (a caller could cache a false against future state).
  const checkedThroughBlock = await headBlock();

  const calls = [];
  for (const symbol of TRADE_MARKETS) {
    for (const isLong of [true, false]) {
      calls.push({
        contract: pm,
        fn: "positions",
        args: [positionKey(address, marketKey(symbol), isLong)],
      });
    }
  }

  const results = await batchRead(calls);

  // One `true` is proof regardless of what else failed — a positive cannot be produced by
  // a dropped call. A `false`, though, is only trustworthy if every read landed.
  const completed = results.some((r) => r.ok && r.value.sizeUsd.gt(0));
  const reliable = completed || results.every((r) => r.ok);

  return { completed, reliable, checkedThroughBlock };
}

/** The one source that can prove — or disprove — a first trade. */
export function firstTradeSources() {
  const pm = positionManagerRead();
  return [
    {
      contract: pm,
      address: pm.address,
      floor: deployBlocks.positionManager(),
      label: "PositionManager",
      filterFor: (wallet) => pm.filters.PositionOpened(wallet),
    },
  ];
}

/** first_trade, Tier 2: has this wallet EVER opened a position? `owner` is indexed. */
export async function firstTradeTier2(address, opts) {
  return scanWithResume(forWallet(firstTradeSources(), address), { ...opts, wallet: address });
}

// How many of the newest market ids Tier 1 inspects. Live markets are always the newest
// ids, so walking from the tail finds them immediately; the bound stops the batch growing
// with marketCount. Mirrors the frontend board's HISTORY_DEPTH reasoning.
const PREDICTION_TAIL = 48;

/**
 * first_prediction, Tier 1: does the wallet hold stake on any recent market?
 *
 * Two round trips: marketCount, then stakeOf across the newest ids.
 *
 * DELIBERATELY BROADER THAN "LIVE MARKETS": every recent market is checked regardless of
 * phase, because stakeOf is zeroed by claim(), NOT by settlement — a settled-but-unclaimed
 * stake is still proof of a bet, and catching it here saves an expensive Tier 2 scan. That
 * also means getMarket is never called: the phase is irrelevant to the question.
 *
 * Only the NEW factory is read. The old one is draining and its markets were empty-book,
 * so a live stake there is not a realistic positive — but bets placed on it before the
 * 2026-07-22 redeploy are real, which is why Tier 2 scans both.
 */
export async function firstPredictionTier1(address) {
  const factory = predictionFactoryRead();
  const checkedThroughBlock = await headBlock();

  const [countRes] = await batchRead([{ contract: factory, fn: "marketCount" }]);
  if (!countRes.ok) return { completed: false, reliable: false, checkedThroughBlock };

  const marketCount = countRes.value.toNumber();
  if (marketCount === 0) {
    // No markets have ever existed, so nobody can have bet. Reliable, and a true negative.
    return { completed: false, reliable: true, checkedThroughBlock };
  }

  const newest = marketCount - 1;
  const oldest = Math.max(0, newest - PREDICTION_TAIL + 1);
  const calls = [];
  for (let id = newest; id >= oldest; id--) {
    calls.push({ contract: factory, fn: "stakeOf", args: [id, address] });
  }

  const results = await batchRead(calls);

  const completed = results.some((r) => r.ok && (r.value.upStake.gt(0) || r.value.downStake.gt(0)));
  // `reliable` asks only whether the READS LANDED — not whether the tail covered every
  // market. The bound is irrelevant here because a Tier 1 negative never proves anything
  // in the first place; markets older than the tail are exactly what Tier 2 is for.
  // (Treating a short tail as "unreliable" would suppress the escalation and leave this
  // quest permanently unanswerable — which is precisely what it did before this comment.)
  const reliable = completed || results.every((r) => r.ok);

  return { completed, reliable, checkedThroughBlock };
}

/**
 * first_prediction, Tier 2: has this wallet EVER bet? `better` is the 2nd indexed topic.
 *
 * BOTH FACTORIES. The 24h factory was superseded on 2026-07-22 but bets placed on it are
 * real bets, and it is immutable — a user who bet there must not be told they never bet.
 * The live factory is scanned first because recent activity is likelier; if the budget
 * runs out before the old one is reached, the result is `exhausted` (indeterminate), never
 * a false.
 *
 * The two factories have DIFFERENT FLOORS (32,222,320 and 30,665,562) and their coverage
 * accumulates independently — one cursor row each, keyed by address. So the routine mid-
 * convergence state "live factory fully walked, old factory barely started" is represented
 * exactly, and this quest returns a proven false only once BOTH have reached their floors.
 */
export function firstPredictionSources() {
  const factory = predictionFactoryRead();
  const oldFactory = predictionFactoryOldRead();

  return [
    {
      contract: factory,
      address: factory.address,
      floor: deployBlocks.predictionFactory(),
      label: "prediction factory (8h, live)",
      filterFor: (wallet) => factory.filters.BetPlaced(null, wallet),
    },
    {
      contract: oldFactory,
      address: oldFactory.address,
      floor: deployBlocks.predictionFactoryOld(),
      label: "prediction factory (24h, draining)",
      filterFor: (wallet) => oldFactory.filters.BetPlaced(null, wallet),
    },
  ];
}

export async function firstPredictionTier2(address, opts) {
  return scanWithResume(forWallet(firstPredictionSources(), address), { ...opts, wallet: address });
}

/**
 * provide_liquidity, Tier 1: does the wallet hold LP shares right now? One read.
 *
 * KNOWN HOLE, ACCEPTED: shares are transferable ERC-20, so a non-zero balance proves
 * custody, not deposit — someone could be credited for shares they were sent. The reverse
 * hole (deposited, then redeemed) is the common one and is what Tier 2 exists for. The
 * trade is deliberate: this is one call and catches the overwhelming majority of real LPs.
 */
export async function provideLiquidityTier1(address) {
  const pool = liquidityPoolRead();
  const checkedThroughBlock = await headBlock();

  const [res] = await batchRead([{ contract: pool, fn: "balanceOf", args: [address] }]);
  if (!res.ok) return { completed: false, reliable: false, checkedThroughBlock };

  return { completed: res.value.gt(0), reliable: true, checkedThroughBlock };
}

/**
 * provide_liquidity, Tier 2: has this wallet EVER deposited?
 *
 * Filtered on `sender` — the account that PAID the assets — not on `owner`, which merely
 * received the shares. Depositing on someone else's behalf credits the payer, which is the
 * honest reading of "provide liquidity". Both are indexed, so switching is a one-line
 * change if that call ever goes the other way.
 */
export function provideLiquiditySources() {
  const pool = liquidityPoolRead();
  return [
    {
      contract: pool,
      address: pool.address,
      floor: deployBlocks.liquidityPool(),
      label: "LiquidityPool",
      filterFor: (wallet) => pool.filters.Deposit(wallet),
    },
  ];
}

export async function provideLiquidityTier2(address, opts) {
  return scanWithResume(forWallet(provideLiquiditySources(), address), { ...opts, wallet: address });
}


// ============================================================================
// daily_active — THE ONLY QUEST WHERE ABSENCE IS AN ANSWER
// ============================================================================
// Every other quest here proves a negative by walking the chain. This one proves it by NOT
// FINDING A ROW, which is a fundamentally more dangerous move: a scan that fails returns
// `exhausted` and degrades honestly, whereas an index that stopped being written returns
// exactly what an inactive wallet returns. Nothing in the data distinguishes them.
//
// So the tiers are arranged to make the dangerous read conditional on a proof:
//
//   TIER 1  prove the index is CURRENT (six fail-closed conditions, indexerState.js), and
//           only then look for a row. A row is proof of activity. No row is a HINT — the
//           same asymmetry as every other Tier 1 in this file, which is why modelling this
//           as "the index said no, therefore no" would have been wrong.
//   TIER 2  close the gap the index has not reached yet: [watermark+1, head].
//
// Tier 2 is what makes Tier 1's hint safe to act on. Without it, a `false` would be scoped
// to the watermark while being reported as of now — and the watermark trails by up to a
// cron period, so a user who traded ninety seconds ago would be told they had not.

/**
 * daily_active, Tier 1: is the index current, and does this wallet have a row for today?
 *
 * Returns `indexedThrough` in addition to the usual contract, because Tier 2 needs to know
 * where the index stopped in order to scan from there. `checkedThroughBlock` is the CHAIN
 * HEAD, not the watermark: it is the block this answer is reported as of, and the tail scan
 * is what earns the right to say that. (A stale index never reaches Tier 2, so a `false`
 * scoped to head is never returned without the tail having been walked.)
 */
export async function dailyActiveTier1(address, { indexerState, now = () => new Date(), getHead = headBlock } = {}) {
  const head = await getHead();

  // THE MIDNIGHT WINDOW, checked before anything else — it makes both the index read AND
  // the tail scan untrustworthy, so there is nothing to gain by looking. See indexerState.js.
  if (withinDayBoundaryGrace(now())) {
    return { completed: false, reliable: false, reason: DAY_BOUNDARY, checkedThroughBlock: null };
  }

  // `now` is threaded through: the wall-clock staleness condition compares against
  // updated_at, so a caller that injected a clock must have it honoured there too — not
  // just for the day boundary above.
  const fresh = await indexerState.readFreshness({
    chainId: chainId(),
    sourceKeys: requiredSourceKeys(),
    head,
    now: () => now().getTime(),
  });

  // NOT `reliable: false` because a read failed — because we cannot PROVE the index is
  // current, which is the only thing that would let absence mean anything. verify.js turns
  // an unreliable Tier 1 into indeterminate and never reaches Tier 2.
  if (!fresh.fresh) {
    return { completed: false, reliable: false, reason: fresh.reason, checkedThroughBlock: null, detail: fresh.detail };
  }

  let hasRow;
  try {
    hasRow = await indexerState.hasDailyRow({ chainId: chainId(), wallet: address, day: utcDay(now()) });
  } catch (err) {
    // An unreadable quest_daily must not be reported as an absent row.
    console.error("[quest] quest_daily read failed, degrading to indeterminate:", err?.message);
    return { completed: false, reliable: false, reason: "index_unreadable", checkedThroughBlock: null };
  }

  return {
    completed: hasRow,
    reliable: true,
    checkedThroughBlock: head,
    indexedThrough: fresh.indexedThrough,
  };
}

/**
 * daily_active, Tier 2: the TAIL SCAN over the blocks the index has not reached.
 *
 * WHY THIS EXISTS. The index trails head by the confirmation margin plus up to one indexer
 * tick. Inside that window the freshness gate is perfectly happy — the index really is
 * current — and yet a wallet that acted ninety seconds ago has no row. Answering `false`
 * there would be a confident wrong answer to the most likely question a user asks: "I just
 * traded, why doesn't it count?". Walking [watermark+1, head] closes it, and structurally
 * it is the same move as phase A closing the top gap in the resumable scanner.
 *
 * IT IS CHEAP, AND BOUNDED BY THE FRESHNESS THRESHOLD ITSELF. If the lag exceeded
 * maxLagBlocks, Tier 1 already returned stale and this never runs. So the tail can never be
 * wider than that threshold — one getLogs per source, and in the steady state a few hundred
 * blocks. THE THRESHOLD AND THIS BUDGET ARE THE SAME KNOB; raising QUEST_INDEXER_MAX_LAG_MS
 * makes this scan proportionally more expensive, which is the honest coupling.
 */
export async function dailyActiveTier2(address, opts) {
  // `makeSources` is a test seam, in the same spirit as scanForEvent's injectable `now` and
  // `verifyFloor`: it lets the tail scan be exercised against fake contracts offline.
  const { head, tier1, makeSources = tailScanSources } = opts;
  const floor = (tier1?.indexedThrough ?? head) + 1;

  // The index already covers everything up to head, so there is no tail. Returning a
  // synthetic complete result rather than calling the scanner is not a shortcut: with
  // floor > head, scanForEvent walks nothing, produces no coverage, and would report
  // `exhausted` — an indeterminate for the case where coverage is actually total.
  if (floor > head) {
    return { found: false, complete: true, exhausted: false, chunksUsed: 0, scannedFrom: head, scannedDownTo: null, coverage: [], reason: null };
  }

  return scanForEvent(makeSources(address, floor), {
    head,
    // One chunk per source: the tail cannot exceed the freshness threshold, so sizing the
    // chunk to that threshold means the common case is a single small getLogs each.
    chunkBlocks: maxLagBlocks(),
    maxChunks: 8,
    timeBudgetMs: 8_000,

    // THE FLOOR HERE IS A WATERMARK, NOT A DEPLOY BLOCK. The default check asks "does this
    // contract have no code below the floor?", which is false for every source — the
    // contracts have existed for millions of blocks. The property that actually matters is
    // "the index provably covers everything below this floor", and Tier 1 established
    // exactly that, moments ago, via the six fail-closed freshness conditions. Carrying its
    // result forward is the re-assertion; re-reading indexer_state within the same request
    // would be a second round trip to learn the same thing.
    verifyFloor: async () => tier1?.reliable === true && Number.isInteger(tier1?.indexedThrough),
  });
}
