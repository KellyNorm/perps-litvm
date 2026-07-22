import { withRetry } from "../withRetry.js";

// Bounded scan of a wallet's BetPlaced history, so a market the user bet in stays visible
// even AFTER they claim it — claim() zeroes the on-chain stake, so stakeOf() can no longer
// tell "never bet" from "bet and claimed". The durable record is the BetPlaced event
// (both marketId and better are indexed), which this reads back within a bounded window.
//
// Mirrors the bounded-getLogs discipline in lib/orders.js: walk BACKWARDS from head, cap
// the look-back hard, and bail on repeated errors — never an unbounded eth_getLogs.
//
// Tuning vs orders.js / the brief, with the reasons (measured on chain 4441, ~0.25s/block):
//  - LOOKBACK 120_000: this IS orders.js's SCAN_LOOKBACK. (~8h here.) A literal "24k" only
//    covers ~1.7h and would MISS bets a couple of hours old — e.g. smoke-test market #59,
//    whose bet is ~38k blocks / ~2.7h back.
//  - CHUNK 10_000, not 1_000: 1_000 is not actually LitVM's getLogs ceiling — 50_000-block
//    ranges return fine (~0.7s); only ~120k times out. 1_000 costs 121 serial round trips
//    (~52s); 10_000 costs ~12 (~5s) with the same safety. Kept well under the timeout edge.
const CHUNK = 10_000;
const LOOKBACK = 120_000;
const MAX_CONSEC_ERRORS = 3; // repeated chunk failures → stop and return the partial set

/**
 * Set of marketId strings the wallet has ever bet on within the look-back window.
 * Best-effort: on any failure it returns whatever it has (possibly empty) so the caller
 * degrades to stake-only visibility rather than showing nothing — a PENDING claim (stake>0)
 * must never disappear because this history query 502'd.
 *
 * @param factory   read-only factory contract (its ABI must carry the BetPlaced event)
 * @param account   connected wallet
 * @param targetIds terminal marketIds currently on the board; when all are found we early-exit
 */
export async function scanParticipation(factory, account, targetIds) {
  const found = new Set();
  if (!account) return found;

  let latest;
  try {
    latest = await withRetry(() => factory.provider.getBlockNumber());
  } catch {
    return found; // can't get head → caller falls back to stake-only
  }

  const floor = Math.max(0, latest - LOOKBACK);
  const filter = factory.filters.BetPlaced(null, account); // better is the 2nd indexed topic
  const target = targetIds && targetIds.length ? targetIds.map(String) : null;

  let hi = latest;
  let consecErrors = 0;
  while (hi >= floor) {
    const lo = Math.max(floor, hi - CHUNK + 1);
    try {
      const logs = await factory.queryFilter(filter, lo, hi);
      for (const l of logs) found.add(l.args.marketId.toString());
      consecErrors = 0;
      // Early-exit: every terminal market on the board is already accounted for.
      if (target && target.every((id) => found.has(id))) break;
    } catch {
      // A single throttled/timed-out chunk is skipped; only a sustained streak aborts the
      // walk (degrading to the partial set) so one bad response can't lose the whole scan.
      if (++consecErrors >= MAX_CONSEC_ERRORS) break;
    }
    hi = lo - 1;
  }
  return found;
}
