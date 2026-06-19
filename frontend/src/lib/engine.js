import { ethers } from "ethers";

// Mirror of PositionManager.sol economics so client-side previews (size, liq,
// funding/day, borrow/day, uPnL, health) match the engine. Constants are copied
// verbatim from the contract; see the cited NatSpec for each.

export const PRICE_DECIMALS = 8; // RedStone marks are 1e8
export const ASSET_DECIMALS = 18; // mUSD / sizeUsd / collateral are 1e18

export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = 31_536_000;

// uint256 public constant BORROW_RATE_PER_SECOND = 3_170_979_198; (FEE_PRECISION = 1e18)
export const BORROW_RATE_PER_SECOND = 3_170_979_198;
// uint256 public constant MAX_FUNDING_RATE_PER_SECOND = 347_222_222_222; (1e18)
export const MAX_FUNDING_RATE_PER_SECOND = 347_222_222_222;
// uint256 public constant FUNDING_COEFF = 694_444_444_444; (1e18) = 2 * MAX
export const FUNDING_COEFF = 694_444_444_444;
export const FUNDING_PRECISION = 1e18;

export const MAINTENANCE_MARGIN_BPS = 1_000; // 10%
export const BPS_DENOMINATOR = 10_000;
export const MM = MAINTENANCE_MARGIN_BPS / BPS_DENOMINATOR; // 0.10

export const MAX_PROFIT_FACTOR = 5;
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 10;
export const MIN_COLLATERAL = 10;

// --- BigNumber → float helpers (display precision only) ---------------------
export function priceToNum(bn) {
  if (bn == null) return 0;
  return parseFloat(ethers.utils.formatUnits(bn, PRICE_DECIMALS));
}
export function assetToNum(bn) {
  if (bn == null) return 0;
  return parseFloat(ethers.utils.formatUnits(bn, ASSET_DECIMALS));
}

// --- borrow fee -------------------------------------------------------------
// Flat, utilization-independent: BORROW_RATE_PER_SECOND/1e18 of notional per sec.
export function borrowDayFrac() {
  return (BORROW_RATE_PER_SECOND * SECONDS_PER_DAY) / FUNDING_PRECISION;
}
export function borrowYearFrac() {
  return (BORROW_RATE_PER_SECOND * SECONDS_PER_YEAR) / FUNDING_PRECISION;
}

// --- funding ----------------------------------------------------------------
// Heavy side's per-day funding fraction of notional, signed: + ⇒ longs pay,
// − ⇒ shorts pay. Mirrors _fundingDeltas: rate = clamp(FUNDING_COEFF·|skew|, MAX).
// L, S are long/short notionals as plain numbers (USD).
export function fundingDayFrac(longUsd, shortUsd) {
  const L = longUsd;
  const S = shortUsd;
  const total = L + S;
  if (!total || L <= 0 || S <= 0) return 0; // funding only with both sides open
  const absSkew = Math.abs(L - S) / total; // [0,1]
  let rate = FUNDING_COEFF * absSkew; // per-sec, 1e18 scale
  if (rate > MAX_FUNDING_RATE_PER_SECOND) rate = MAX_FUNDING_RATE_PER_SECOND;
  const dayFrac = (rate * SECONDS_PER_DAY) / FUNDING_PRECISION;
  return L >= S ? dayFrac : -dayFrac;
}

// --- P&L --------------------------------------------------------------------
// Raw, uncapped signed P&L (USD) at `mark`, given entry/size and side.
export function signedPnl({ sizeUsd, entryPrice, isLong }, mark) {
  if (!entryPrice) return 0;
  const dir = isLong ? 1 : -1;
  return (sizeUsd * dir * (mark - entryPrice)) / entryPrice;
}

// --- liquidation price ------------------------------------------------------
// Solve equity == maintenance for the mark, holding the accrued fees fixed at
// their current snapshot (borrowFee >= 0, fundingOwed signed: + ⇒ position owes).
// equity = collateral + signedPnl − borrowFee − fundingOwed; maintenance = collateral·MM.
//   signedPnl_target = collateral·(MM−1) + borrowFee + fundingOwed
//   long:  mark = entry·(1 + target/size)   short: mark = entry·(1 − target/size)
export function liqPrice({ collateral, sizeUsd, entryPrice, isLong }, borrowFee = 0, fundingOwed = 0) {
  if (!sizeUsd || !entryPrice) return 0;
  const target = collateral * (MM - 1) + borrowFee + fundingOwed;
  const ratio = target / sizeUsd;
  const p = isLong ? entryPrice * (1 + ratio) : entryPrice * (1 - ratio);
  return p > 0 ? p : 0;
}

// Health as proximity of the mark to the liq price, in [0,1]: 1 = at entry-ish
// distance, 0 = at the liq line. Mirrors the design reference's span/dist ratio.
export function health({ entryPrice }, mark, liq) {
  const span = Math.abs(entryPrice - liq);
  const dist = Math.abs(mark - liq);
  if (!span) return 1;
  return Math.max(0, Math.min(1, dist / span));
}

export function healthColor(h) {
  return h > 0.5 ? "var(--pos)" : h > 0.25 ? "var(--molten)" : "var(--neg)";
}
