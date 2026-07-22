// Prediction-market config. Deliberately separate from the perps `config.js` so a
// change here can never affect the live perps money path.
//
// Everything that CAN be read from chain IS read from chain (asset symbols, per-market
// fee, timeframes). The only hardcoded values are addresses and pure display metadata.

const env = import.meta.env;

export const PREDICTION_FACTORY_ADDRESS = (
  env.VITE_PREDICTION_FACTORY_ADDRESS || "0x6338985C7f689C3e1959bfe1a8bb36E44849EA40"
).trim();

// Multicall3 at its canonical cross-chain address. VERIFIED deployed on chain 4441
// (codesize 3808, 2026-07-20) — the board read fans out through this, so if it ever
// goes missing the board must degrade rather than hang. See multicall.js.
export const MULTICALL3_ADDRESS = (
  env.VITE_MULTICALL3_ADDRESS || "0xcA11bde05977b3631167028862bE2a173976CA11"
).trim();

// --- on-chain enums (OracleResolvedMarket.sol / PredictionMarketFactory.sol) ---

export const PHASE = { OPEN: 0, LOCKED: 1, SETTLED: 2, VOID: 3 };
export const OUTCOME = { NONE: 0, UP: 1, DOWN: 2 };

// Bet SIDE is a SEPARATE enum from OUTCOME on-chain (ParimutuelPredictions.Side):
// `enum Side { Up, Down }` → Up=0, Down=1. Do NOT pass OUTCOME.UP (1) as a bet side —
// on-chain that is Side.Down. bet(marketId, side, amount) takes THIS.
export const SIDE = { UP: 0, DOWN: 1 };

// Contract floor: bets below 1 mUSD revert BelowMinBet(). 18-dec.
export const MIN_BET = "1000000000000000000";

export const PHASE_LABEL = { 0: "OPEN", 1: "LOCKED", 2: "SETTLED", 3: "VOID" };

// TF_15M=0, TF_30M=1, TF_1H=2, TF_24H=3. The 5-min frame shown in the design mockup
// does NOT exist on-chain — TF_COUNT is 4. Do not add it.
export const TIMEFRAME_LABEL = { 0: "15-min", 1: "30-min", 2: "1-hour", 3: "24-hour" };

// --- display metadata ---

// Fallback badge colours for assets with no bundled SVG icon. Keyed by the on-chain
// symbol string. Shape mirrors the design's `.sym` badge so the fallback reads as
// intentional, not as a broken image.
export const ASSET_BADGE = {
  BTC: { fg: "#F7931A", bg: "rgba(247,147,26,.14)", bd: "rgba(247,147,26,.4)" },
  ETH: { fg: "#8FA0FF", bg: "rgba(143,160,255,.14)", bd: "rgba(143,160,255,.4)" },
  BNB: { fg: "#F3BA2F", bg: "rgba(243,186,47,.14)", bd: "rgba(243,186,47,.4)" },
  XRP: { fg: "#C8D3E8", bg: "rgba(200,211,232,.12)", bd: "rgba(200,211,232,.34)" },
  SOL: { fg: "#14F1C6", bg: "rgba(20,241,198,.14)", bd: "rgba(20,241,198,.4)" },
  TRX: { fg: "#FF4D5A", bg: "rgba(255,77,90,.14)", bd: "rgba(255,77,90,.4)" },
  HYPE: { fg: "#4BE3C8", bg: "rgba(75,227,200,.14)", bd: "rgba(75,227,200,.42)" },
  DOGE: { fg: "#D8B44A", bg: "rgba(216,180,74,.14)", bd: "rgba(216,180,74,.4)" },
  RAIN: { fg: "#5EC8FF", bg: "rgba(94,200,255,.14)", bd: "rgba(94,200,255,.42)" },
  ZCASH: { fg: "#ECB244", bg: "rgba(236,178,68,.14)", bd: "rgba(236,178,68,.4)" },
  LTC: { fg: "#A6A9AA", bg: "rgba(166,169,170,.14)", bd: "rgba(166,169,170,.4)" },
};

export const DEFAULT_BADGE = { fg: "#93A0C0", bg: "rgba(147,160,192,.12)", bd: "rgba(147,160,192,.32)" };
