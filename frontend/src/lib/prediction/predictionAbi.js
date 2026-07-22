// Minimal human-readable ABI for the prediction factory. Hand-written rather than
// pulled from `out/` so the frontend bundle carries only the reads the board needs.
// Signatures verified against src/prediction/*.sol on 2026-07-20.

// Market struct order is load-bearing — it must match OracleResolvedMarket.sol:51.
const MARKET_TUPLE =
  "(uint16 assetId,address feed,uint64 t0,uint64 tLock,uint64 tExpiry,uint64 lastObsTs," +
  "uint64 maxStaleness,int256 strike,int256 settlePrice,uint8 phase,uint8 outcome)";

export const PREDICTION_FACTORY_ABI = [
  // board enumeration
  "function marketCount() view returns (uint256)",
  `function getMarket(uint256 marketId) view returns (${MARKET_TUPLE})`,
  "function timeframeOf(uint256 marketId) view returns (uint8)",
  // pools() also returns the per-market fee SNAPSHOT — never hardcode a fee, and never
  // reuse the global feeBps(), which can drift from what a live market settles at.
  "function pools(uint256 marketId) view returns (uint256 upPool,uint256 downPool,uint16 marketFeeBps)",
  "function claimable(uint256 marketId,address who) view returns (uint256)",
  // Per-user stake on a market (up + down). Used to decide whether a TERMINAL market is
  // still relevant to this wallet — a settled loss has claimable()==0 but non-zero stake,
  // so we key visibility off stake, not claimable, to keep the user's own history/claims.
  "function stakeOf(uint256 marketId,address who) view returns (uint256 upStake,uint256 downStake)",
  // ---- money-path WRITES (Step 6) ----
  // side is ParimutuelPredictions.Side: 0 = Up, 1 = Down (SEPARATE from Outcome).
  // Reverts: BettingClosed() once locked, BelowMinBet() under 1e18, EnforcedPause().
  "function bet(uint256 marketId,uint8 side,uint256 amount)",
  // Pays a winner's pro-rata payout or a void refund; amount comes from claimable().
  // Emits Claimed(marketId, claimer, phase, amount). Idempotent — a second call pays 0.
  "function claim(uint256 marketId)",
  // The mUSD token this factory pulls bets from / pays claims in. Approve THIS spender.
  "function musd() view returns (address)",
  // Events we parse from receipts to confirm the EXACT on-chain amounts.
  "event BetPlaced(uint256 indexed marketId,address indexed better,uint8 side,uint256 amount)",
  "event Claimed(uint256 indexed marketId,address indexed claimer,uint8 phase,uint256 amount)",
  // asset registry — symbols come from here, never from a hardcoded map
  "function assetCount() view returns (uint256)",
  "function assets(uint256) view returns (string symbol,address feed,uint8 feedDecimals,uint8 displayDp,bool enabled)",
  // convenience views
  "function bettingOpen(uint256 marketId) view returns (bool)",
  "function boardCounts() view returns (uint256 active,uint256 open)",
];

export const AGGREGATOR_V3_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];

export const MULTICALL3_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
  // Chain clock. The keeper locks/settles on block.timestamp, so countdowns must count
  // down to CHAIN time, not the browser's Date.now(). Read once per poll and interpolate.
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
];
