// Prediction factory ABI fragments — PORTED, NOT IMPORTED.
//
// PROVENANCE: subset of `frontend/src/lib/prediction/predictionAbi.js`, itself verified
// against src/prediction/*.sol on 2026-07-20. Only the reads the quest checks need are
// carried over — notably NOTHING from that file's money-path write section (bet/claim):
// this endpoint is read-only and must not even be able to encode a write.
//
// See the porting note in ./positionManager.js. KEEP IN STEP with the frontend copy.

// Market struct order is load-bearing — it must match OracleResolvedMarket.sol:51.
const MARKET_TUPLE =
  "(uint16 assetId,address feed,uint64 t0,uint64 tLock,uint64 tExpiry,uint64 lastObsTs," +
  "uint64 maxStaleness,int256 strike,int256 settlePrice,uint8 phase,uint8 outcome)";

export const PREDICTION_FACTORY_ABI = [
  "function marketCount() view returns (uint256)",
  `function getMarket(uint256 marketId) view returns (${MARKET_TUPLE})`,
  // Per-user stake on a market. Tier 1 reads this across live markets — but note claim()
  // ZEROES it, so a claimed bet reads as zero. That is precisely why a Tier 1 false here
  // is not an answer: the durable record is the BetPlaced event.
  "function stakeOf(uint256 marketId,address who) view returns (uint256 upStake,uint256 downStake)",
  // Both marketId and better are indexed, so this filters server-side by wallet.
  "event BetPlaced(uint256 indexed marketId,address indexed better,uint8 side,uint256 amount)",
];

// Phases, from OracleResolvedMarket.sol. Tier 1 only inspects markets that can still hold
// a live stake; SETTLED/VOID markets are where stakes get claimed away.
export const PHASE = { OPEN: 0, LOCKED: 1, SETTLED: 2, VOID: 3 };
