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
];
