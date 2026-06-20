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
    const extra = [...liqLines, ...trigLines].map((l) => l.price).filter((p) => p > 0 && isFinite(p));
    const prices = pts.map((p) => p.price).concat(extra);
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
  }, [pts, liqLines, trigLines]);

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
          {markCur != null && <line className="mark-line" x1="0" y1={view.y(markCur)} x2={W} y2={view.y(markCur)} />}
          {liqLines.map((l, i) =>
            l.price > 0 ? (
              <g key={"liq" + i}>
                <line className="liq-line" x1="0" y1={view.y(l.price)} x2={W} y2={view.y(l.price)} />
                <text className="liq-flag" x="8" y={view.y(l.price) - 5}>
                  {(l.label || "LIQ") + " " + fmtUsd(l.price)}
                </text>
              </g>
            ) : null,
          )}
          {trigLines.map((t, i) =>
            t.price > 0 ? (
              <g key={"trig" + i}>
                <line className="trig-line" x1="0" y1={view.y(t.price)} x2={W} y2={view.y(t.price)} />
                <text className="trig-flag" x={W - 160} y={view.y(t.price) - 5}>
                  {(t.label || "TRIGGER") + " " + fmtUsd(t.price)}
                </text>
              </g>
            ) : null,
          )}
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
