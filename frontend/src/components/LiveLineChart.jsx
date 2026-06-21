import { useMemo } from "react";
import { fmtUsdPx, fmtPrice } from "../lib/format.js";

const W = 980;
const H = 300;
const PAD = 8;

function timeLabel(ts) {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// FALLBACK chart used when the exchange OHLC fetch fails: the original live mark-price
// area/line that ACCUMULATES from RedStone polls — sparse at first, fills over time. No
// synthetic OHLC; every point is an observed sample. Keeps the liq/trigger overlay
// lines so the position context survives even without candles.
export default function LiveLineChart({ symbol, series, mark, live, startedAt, liqLines = [], trigLines = [], note }) {
  const pts = series || [];
  const markPrice = mark && !mark.error ? mark.price : null;
  // Fast DISPLAY price (public-exchange ticker) for the headline number; the orange
  // accumulation line + the horizontal mark-line stay the RedStone execution mark.
  const livePrice = live && isFinite(live.price) ? live.price : null;

  const view = useMemo(() => {
    if (pts.length < 2) return null;
    // Scale the Y-axis to the PRICE ACTION ONLY. Liq/entry/trigger reference lines are
    // NOT allowed to expand the range — a 1x long's liq sits ~10x below entry, and
    // including it would pin the live line into a sliver at the top. Far references are
    // clamped to an edge (see yRef) instead of zooming out to reach them.
    const prices = pts.map((p) => p.price).filter((p) => p > 0 && isFinite(p));
    if (prices.length < 2) return null;
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (hi === lo) {
      hi += hi * 0.0005 || 1;
      lo -= lo * 0.0005 || 1;
    }
    // Small headroom so the line never glues to the top/bottom edge.
    const padPx = (hi - lo) * 0.08;
    lo -= padPx;
    hi += padPx;
    const rng = hi - lo;
    const n = pts.length;
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v) => PAD + (1 - (v - lo) / rng) * (H - PAD * 2);
    // Reference-line placement: clamp out-of-range prices to the nearest edge and report
    // the direction so the caller can show a "↓ LIQ $X" marker rather than rescaling.
    const yRef = (v) => {
      if (!isFinite(v)) return { y: H - PAD, edge: "bottom" };
      if (v > hi) return { y: PAD, edge: "up" };
      if (v < lo) return { y: H - PAD, edge: "down" };
      return { y: y(v), edge: null };
    };
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
    const area = `${line} L${W},${H - PAD} L0,${H - PAD} Z`;
    return { line, area, y, yRef, lo, hi };
  }, [pts]);

  const lastPt = pts.length ? pts[pts.length - 1].price : null;
  // Header tracks the fast live ticker; the horizontal mark-line tracks RedStone.
  const cur = livePrice != null ? livePrice : markPrice != null ? markPrice : lastPt;
  const markCur = markPrice != null ? markPrice : lastPt;
  const first = pts.length ? pts[0].price : null;
  const delta = cur != null && first != null ? cur - first : null;
  const deltaPct = delta != null && first ? (delta / first) * 100 : null;
  const up = delta != null && delta >= 0;

  return (
    <div className="chart-wrap">
      <div className="chart-top">
        <span className="price mono">{cur != null ? fmtUsdPx(cur) : "—"}</span>
        {delta != null ? (
          <span className={"chg mono " + (up ? "pos" : "neg")}>
            {(up ? "+$" : "−$") + fmtPrice(Math.abs(delta))} ({Math.abs(deltaPct).toFixed(2)}% since {timeLabel(startedAt)})
          </span>
        ) : (
          <span className="chg mono loading-dim">accumulating…</span>
        )}
        <span className="chart-badge">
          <span className="dot"></span> {symbol} live mark · {pts.length} pts
        </span>
      </div>

      {note && <div className="chart-source">{note}</div>}

      {view ? (
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="markfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(255,138,76,0.28)" />
              <stop offset="1" stopColor="rgba(255,138,76,0)" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((g) => {
            const gy = PAD + (g * (H - PAD * 2)) / 4;
            return <line key={g} x1="0" y1={gy} x2={W} y2={gy} stroke="#141A23" strokeWidth="1" />;
          })}
          <path d={view.area} fill="url(#markfill)" />
          <path d={view.line} fill="none" stroke="var(--molten)" strokeWidth="1.6" />
          {markCur != null &&
            (() => {
              const r = view.yRef(markCur);
              return <line className="mark-line" x1="0" y1={r.y} x2={W} y2={r.y} />;
            })()}
          {liqLines.map((l, i) => {
            if (!(l.price > 0)) return null;
            const r = view.yRef(l.price);
            const arrow = r.edge === "up" ? "↑ " : r.edge === "down" ? "↓ " : "";
            // Clamped to the top edge: drop the label below the line so it isn't clipped.
            const ty = r.edge === "up" ? r.y + 14 : r.y - 5;
            return (
              <g key={"liq" + i}>
                <line className="liq-line" x1="0" y1={r.y} x2={W} y2={r.y} />
                <text className="liq-flag" x="8" y={ty}>
                  {arrow + (l.label || "LIQ") + " " + fmtUsdPx(l.price)}
                </text>
              </g>
            );
          })}
          {trigLines.map((t, i) => {
            if (!(t.price > 0)) return null;
            const r = view.yRef(t.price);
            const arrow = r.edge === "up" ? "↑ " : r.edge === "down" ? "↓ " : "";
            const ty = r.edge === "up" ? r.y + 14 : r.y - 5;
            return (
              <g key={"trig" + i}>
                <line className="trig-line" x1="0" y1={r.y} x2={W} y2={r.y} />
                <text className="trig-flag" x={W - 160} y={ty}>
                  {arrow + (t.label || "TRIGGER") + " " + fmtUsdPx(t.price)}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="chart-empty">
          <div>Live mark chart — building from RedStone polls.</div>
          <div className="loading-dim">
            {pts.length === 0 ? "Waiting for the first price…" : `${pts.length} sample so far, need 2+ to draw a line.`}
          </div>
        </div>
      )}
    </div>
  );
}
