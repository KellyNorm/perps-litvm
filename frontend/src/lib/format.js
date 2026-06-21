// Display formatting helpers. Mirror the design reference's number styling.

export function fmtPrice(n) {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 0 });
}

export function fmt2(n) {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtUsd(n) {
  return "$" + fmtPrice(n);
}

// Asset PRICES — mark, execution, entry, trigger — shown to 5 decimals. This is the
// single place price precision lives; route every price display through fmtUsdPx so they
// stay consistent. DISPLAY ONLY: stored/contract precision is unchanged, and mUSD/size
// notional keeps its coarser fmtUsd styling (do NOT use this for sizes).
export function fmtPx(n) {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

export function fmtUsdPx(n) {
  return "$" + fmtPx(n);
}

export function fmtUsd2(n) {
  return "$" + fmt2(n);
}

// Compact magnitude for OI / TVL: $1.27M, $748K, $920.
export function fmtCompact(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + fmt2(n);
}

export function fmtPct(frac, digits = 2) {
  if (frac == null || !isFinite(frac)) return "—";
  return (frac * 100).toFixed(digits) + "%";
}

// Share price can be far from 1 (e.g. ~1e-6 after seeding); keep enough precision
// to stay honest instead of rounding to 0.00.
export function fmtShare(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 0.01) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 8, minimumSignificantDigits: 1 });
}

export function shortAddr(a) {
  if (!a) return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

// Signed money, e.g. +$12.40 / −$3.00.
export function fmtSigned(n) {
  if (n == null || !isFinite(n)) return "—";
  return (n >= 0 ? "+$" : "−$") + fmt2(Math.abs(n));
}

export function countdown(secs) {
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
