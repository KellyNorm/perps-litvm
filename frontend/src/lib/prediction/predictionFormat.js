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
 * Parimutuel payout ESTIMATE for `stake` on `side`, net of the market's OWN fee snapshot.
 * An estimate only: the pools keep moving until lock, so the realised payout differs.
 *
 * Mirrors the contract's `_payout` (ParimutuelPredictions §5.3) EXACTLY, so the preview
 * never over-promises:
 *   winningPool W = (side pool) + stake ; pot P = up + down + stake
 *   fee is taken ONLY from the LOSING pool: fee = losingPool * feeBps / 10_000
 *   payout = stake * (P - fee) / W
 * feeBps is the market's OWN snapshot from pools() — never a global or a constant.
 */
export function estPayout({ stake, side, upPool, downPool, feeBps }) {
  const s = Number(stake) || 0;
  if (s <= 0) return { payout: 0, multiple: 0 };

  const up = toNum(upPool) ?? 0;
  const down = toNum(downPool) ?? 0;

  const isUp = side === "UP" || side === 0;
  const winningPool = (isUp ? up : down) + s;
  const losingPool = isUp ? down : up;
  const total = up + down + s;
  if (winningPool <= 0) return { payout: 0, multiple: 0 };

  const fee = (losingPool * (Number(feeBps) || 0)) / 10_000;
  const payout = ((total - fee) * s) / winningPool;
  return { payout, multiple: payout / s };
}

/**
 * Price vs strike: the signed $ difference and % drift, with a direction. Lets the card
 * say "−2.70% below strike" instead of making the user subtract two numbers. `dir` is
 * "up" when price is ABOVE the strike (the market's YES side is winning) and "down" when
 * below. Returns null when either input is missing or the strike is zero.
 */
export function strikeDelta(priceBn, strikeBn) {
  const p = toNum(priceBn);
  const k = toNum(strikeBn);
  if (p === null || k === null || k === 0) return null;
  const diff = p - k;
  const pct = (diff / k) * 100;
  return { diff, pct, dir: diff > 0 ? "up" : diff < 0 ? "down" : "flat" };
}

/**
 * Per-side payout MULTIPLE at the CURRENT pool — the honest "what does this side pay"
 * signal that crowd-share % alone hides ("UP 95%" reads as likely, but it pays ~1.05×).
 *
 * Mirrors the contract's _payout / estPayout in the marginal (small-bet) limit: if a side
 * wins, each unit on it collects `(pot − fee) / sidePool`, where the fee is taken ONLY
 * from the LOSING pool using the market's OWN feeBps snapshot. Returns { empty:true } for
 * a 0/0 book — there is no real price yet, so the caller must NOT imply one.
 */
export function sideMultiples(upPool, downPool, feeBps) {
  const up = toNum(upPool) ?? 0;
  const down = toNum(downPool) ?? 0;
  const pot = up + down;
  if (pot <= 0) return { empty: true, up: null, down: null };
  const bps = Number(feeBps) || 0;
  // Fee is levied on the losing side only, so each side's multiple nets the fee the OTHER
  // side would pay when this side wins.
  const upMult = up > 0 ? (pot - (down * bps) / 10_000) / up : null;
  const downMult = down > 0 ? (pot - (up * bps) / 10_000) / down : null;
  return { empty: false, up: upMult, down: downMult };
}

/** Compact payout multiple: "1.05×", "19.8×", "120×". null → "—". */
export function fmtMult(m) {
  if (m == null || !isFinite(m) || m <= 0) return "—";
  if (m >= 100) return `${Math.round(m)}×`;
  if (m >= 10) return `${m.toFixed(1)}×`;
  return `${m.toFixed(2)}×`;
}

/**
 * Freshness age of an oracle price: how long ago (relative to chain `nowTs`) the feed's
 * `updatedAt` was. Distinguishes "the UI is stale" from "DIA simply hasn't published"
 * — a flat DIA feed only reprints on its ~140s heartbeat, so an age of a minute-plus in
 * a quiet market is EXPECTED. Returns "just now" under 5s, else "12s ago" / "2m ago".
 * Clamps negatives (chain-time interpolation can briefly run a hair ahead of updatedAt).
 */
export function fmtPriceAge(updatedAt, nowTs) {
  if (updatedAt == null || nowTs == null) return null;
  const secs = Math.max(0, nowTs - updatedAt);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
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

/**
 * Full "1h 04m 32s" countdown that ALWAYS carries seconds, so it ticks visibly every
 * second and never collapses two nearby targets (e.g. a 24h market's lock vs its
 * settle, 1800s apart) into the same coarse string. Hours are dropped below 1h.
 * Returns null once elapsed — the caller shows a "locking…"/"settling…" placeholder.
 */
export function fmtHMS(targetTs, nowTs) {
  const secs = targetTs - nowTs;
  if (secs <= 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}h ${mm}m ${ss}s` : `${mm}m ${ss}s`;
}
