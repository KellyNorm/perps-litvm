import { useMemo } from "react";
import { fmtUsd, fmtPrice } from "../lib/format.js";

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

// Live mark-price area/line that ACCUMULATES from RedStone polls — sparse at first,
// fills over time. No synthetic OHLC history; every point is an observed sample.
export default function Chart({ symbol, series, mark, startedAt }) {
  const pts = series || [];
  const view = useMemo(() => {
    if (pts.length < 2) return null;
    const prices = pts.map((p) => p.price);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (hi === lo) {
      hi += hi * 0.0005 || 1;
      lo -= lo * 0.0005 || 1;
    }
    const rng = hi - lo;
    const n = pts.length;
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v) => PAD + (1 - (v - lo) / rng) * (H - PAD * 2);
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
    const area = `${line} L${W},${H - PAD} L0,${H - PAD} Z`;
    return { line, area, y, lo, hi };
  }, [pts]);

  const cur = mark && !mark.error ? mark.price : pts.length ? pts[pts.length - 1].price : null;
  const first = pts.length ? pts[0].price : null;
  const delta = cur != null && first != null ? cur - first : null;
  const deltaPct = delta != null && first ? (delta / first) * 100 : null;
  const up = delta != null && delta >= 0;

  return (
    <div className="chart-wrap">
      <div className="chart-top">
        <span className="price mono">{cur != null ? fmtUsd(cur) : "—"}</span>
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
          {cur != null && <line className="mark-line" x1="0" y1={view.y(cur)} x2={W} y2={view.y(cur)} />}
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
