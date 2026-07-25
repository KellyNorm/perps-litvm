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

import { batchRead, headBlock, marketKey, positionKey, positionManagerRead } from "./chain.js";

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
