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

import {
  batchRead,
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

/** first_trade, Tier 2: has this wallet EVER opened a position? `owner` is indexed. */
export async function firstTradeTier2(address, opts) {
  const pm = positionManagerRead();
  return scanWithResume(
    [
      {
        contract: pm,
        filter: pm.filters.PositionOpened(address),
        floor: deployBlocks.positionManager(),
        address: pm.address,
        label: "PositionManager",
      },
    ],
    { ...opts, wallet: address },
  );
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
export async function firstPredictionTier2(address, opts) {
  const factory = predictionFactoryRead();
  const oldFactory = predictionFactoryOldRead();

  return scanWithResume(
    [
      {
        contract: factory,
        filter: factory.filters.BetPlaced(null, address),
        floor: deployBlocks.predictionFactory(),
        address: factory.address,
        label: "prediction factory (8h, live)",
      },
      {
        contract: oldFactory,
        filter: oldFactory.filters.BetPlaced(null, address),
        floor: deployBlocks.predictionFactoryOld(),
        address: oldFactory.address,
        label: "prediction factory (24h, draining)",
      },
    ],
    { ...opts, wallet: address },
  );
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
export async function provideLiquidityTier2(address, opts) {
  const pool = liquidityPoolRead();
  return scanWithResume(
    [
      {
        contract: pool,
        filter: pool.filters.Deposit(address),
        floor: deployBlocks.liquidityPool(),
        address: pool.address,
        label: "LiquidityPool",
      },
    ],
    { ...opts, wallet: address },
  );
}
