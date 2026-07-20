import { ethers } from "ethers";

// Pools and stakes are 18-dec mUSD. Feed answers are 18-dec (all 11 adapters report
// feedDecimals=18, verified on-chain 2026-07-20) but displayed at the asset's own
// displayDp, which ranges 2 (BTC) to 6 (RAIN).

export function toNum(bn, decimals = 18) {
  if (bn === null || bn === undefined) return null;
  try {
    return Number(ethers.utils.formatUnits(bn, decimals));
  } catch {
    return null;
  }
}

/** Pool sizes: compact, no decimals — "12,850" not "12,850.00". */
export function fmtPool(bn) {
  const n = toNum(bn);
  if (n === null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** mUSD amounts where precision matters (payouts, claims). */
export function fmtMusd(bn, dp = 2) {
  const n = toNum(bn);
  if (n === null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Oracle price at the asset's own display precision. */
export function fmtFeedPrice(bn, displayDp = 2) {
  const n = toNum(bn);
  if (n === null) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: displayDp, maximumFractionDigits: displayDp });
}

/**
 * Parimutuel odds as UP's share of the total pool.
 * An empty pool is a genuine 50/50 — the design's bar needs SOME split, and 50 is the
 * honest one. Never imply a lean that no stake supports.
 */
export function upShare(upPool, downPool) {
  const up = toNum(upPool) ?? 0;
  const down = toNum(downPool) ?? 0;
  const total = up + down;
  if (total <= 0) return 0.5;
  return up / total;
}

/**
 * Parimutuel payout for `stake` on `side`, net of the market's OWN fee snapshot.
 *
 * Winners split the whole pool pro-rata, so the payout falls as more people join your
 * side. feeBps is passed in from pools() per market — never a global or a constant.
 */
export function estPayout({ stake, side, upPool, downPool, feeBps }) {
  const s = Number(stake) || 0;
  if (s <= 0) return { payout: 0, multiple: 0 };

  const up = toNum(upPool) ?? 0;
  const down = toNum(downPool) ?? 0;

  const winningPool = (side === "UP" ? up : down) + s;
  const total = up + down + s;
  if (winningPool <= 0) return { payout: 0, multiple: 0 };

  const fee = (total * (Number(feeBps) || 0)) / 10_000;
  const payout = ((total - fee) * s) / winningPool;
  return { payout, multiple: payout / s };
}

/** "0:42" under a minute-ish, "43m" / "1h 43m" beyond. Returns null once elapsed. */
export function fmtCountdown(targetTs, nowTs) {
  const secs = targetTs - nowTs;
  if (secs <= 0) return null;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 && secs >= 600 ? `${m}m` : `${m}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
