import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineStyle, CrosshairMode } from "lightweight-charts";
import { fmtUsdPx, fmtPrice } from "../lib/format.js";
import { useCandles, TIMEFRAMES, DEFAULT_TF, hasExchangeFeed } from "../hooks/useCandles.js";
import LiveLineChart from "./LiveLineChart.jsx";

const CHART_H = 300;

// Palette pulled live from the Dark Velocity theme (index.css :root) so the chart stays
// in sync with the single source of truth. lightweight-charts is imperative, so we
// resolve the CSS custom properties to concrete colors at render time.
function chartColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n, fb) => s.getPropertyValue(n).trim() || fb;
  return {
    up: v("--pos", "#00d98b"),
    down: v("--neg", "#ff4d6d"),
    grid: v("--line-soft", "rgba(108,140,255,0.1)"),
    text: v("--muted", "#8b95ad"),
    border: v("--line", "rgba(108,140,255,0.18)"),
    mark: v("--accent-blue", "#29a9ff"), // RedStone mark · execution line
    liq: v("--amber", "#ffb547"), // liquidation overlay = amber
    trig: v("--accent-violet", "#a24dff"),
  };
}

// Candlestick body — owns the imperative lightweight-charts instance. Candles are
// INDICATIVE exchange history; the RedStone mark (blue line) is what trades execute
// against. liq/trigger overlays are drawn as labelled price lines.
function CandleChart({ candles, markPrice, liqLines, trigLines }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const linesRef = useRef([]);
  const C = chartColors();
  // Latest candle set, read by the autoscale provider so the Y-range tracks price
  // action only (kept in a ref because the series is created once, before data lands).
  const candlesRef = useRef(null);

  // Create once.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: CHART_H,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: C.text,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: C.grid },
        horzLines: { color: C.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addCandlestickSeries({
      upColor: C.up,
      downColor: C.down,
      borderUpColor: C.up,
      borderDownColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      // Scale the Y-axis to PRICE ACTION ONLY. By default lightweight-charts folds
      // createPriceLine() values into the autoscale, so a far-away liq line (e.g. a 1x
      // long's liq ~10x below entry) would stretch the range and flatten the candles.
      // Compute the range from candle highs/lows alone; liq/trigger/mark lines render on
      // top and clamp to the axis edge instead of expanding it.
      autoscaleInfoProvider: () => {
        const data = candlesRef.current;
        if (!data || !data.length) return null;
        let min = Infinity;
        let max = -Infinity;
        for (const c of data) {
          if (c.low < min) min = c.low;
          if (c.high > max) max = c.high;
        }
        if (!isFinite(min) || !isFinite(max)) return null;
        const pad = (max - min) * 0.08 || max * 0.0005;
        return { priceRange: { minValue: min - pad, maxValue: max + pad } };
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) chart.applyOptions({ width: Math.floor(w) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  // Data updates (symbol / timeframe / refresh).
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !candles || !candles.length) return;
    candlesRef.current = candles; // set before setData so the autoscale provider sees it
    s.setData(candles);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Mark + liq/trigger overlay price lines. Rebuilt whenever any input changes.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const pl of linesRef.current) {
      try {
        s.removePriceLine(pl);
      } catch {}
    }
    linesRef.current = [];
    const add = (price, color, title, style) => {
      if (price == null || !isFinite(price) || price <= 0) return;
      linesRef.current.push(
        s.createPriceLine({
          price,
          color,
          lineWidth: style === LineStyle.Solid ? 2 : 1,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        }),
      );
    };
    // The RedStone mark — the price trades actually execute against.
    add(markPrice, C.mark, "mark · execution", LineStyle.Solid);
    for (const l of liqLines) add(l.price, C.liq, l.label || "LIQ", LineStyle.Dashed);
    for (const t of trigLines) add(t.price, C.trig, t.label || "TRIGGER", LineStyle.Dashed);
  }, [markPrice, liqLines, trigLines, candles]);

  return <div className="chart-canvas" ref={elRef} />;
}

export default function Chart({ symbol, series, mark, live, liveSource, startedAt, liqLines = [], trigLines = [] }) {
  const [tf, setTf] = useState(DEFAULT_TF);
  const { candles, status, source } = useCandles(symbol, tf);

  const markPrice = mark && !mark.error ? mark.price : null;
  // Fast DISPLAY price from the public-exchange ticker — the headline number and the
  // chart's "current price" track this so they tick smoothly (~1.5s). The RedStone mark
  // stays the orange "mark · execution" line below.
  const livePrice = live && isFinite(live.price) ? live.price : null;

  // Header price/change off the candle set (last close vs the period's first open),
  // with the live ticker preferred for the headline number, then the RedStone mark.
  const head = useMemo(() => {
    if (!candles || !candles.length) return null;
    const firstOpen = candles[0].open;
    const lastClose = candles[candles.length - 1].close;
    const cur = livePrice != null ? livePrice : markPrice != null ? markPrice : lastClose;
    const delta = cur - firstOpen;
    const pct = firstOpen ? (delta / firstOpen) * 100 : 0;
    return { cur, delta, pct, up: delta >= 0 };
  }, [candles, livePrice, markPrice]);

  const sourceNote = hasExchangeFeed(symbol)
    ? `Candles & live price: ${source || liveSource || "Kraken/Bybit/Coinbase"} spot · indicative real-time. Trades execute & realize against the RedStone mark (the orange “mark · execution” line).`
    : `RedStone live mark (no exchange feed for ${symbol}).`;

  // Fetch failed / timed out (or unmapped market) -> fall back to the live mark line so
  // nothing hangs on "loading". The liq/trigger overlays carry over.
  if (status === "error") {
    return (
      <LiveLineChart
        symbol={symbol}
        series={series}
        mark={mark}
        live={live}
        startedAt={startedAt}
        liqLines={liqLines}
        trigLines={trigLines}
        note={sourceNote + " — exchange candles unavailable, showing the live mark."}
      />
    );
  }

  return (
    <div className="chart-wrap">
      <div className="chart-top">
        <span className="price mono">{head ? fmtUsdPx(head.cur) : livePrice != null ? fmtUsdPx(livePrice) : markPrice != null ? fmtUsdPx(markPrice) : "—"}</span>
        {head ? (
          <span className={"chg mono " + (head.up ? "pos" : "neg")}>
            {(head.up ? "+$" : "−$") + fmtPrice(Math.abs(head.delta))} ({Math.abs(head.pct).toFixed(2)}% · {tf})
          </span>
        ) : (
          <span className="chg mono loading-dim">loading candles…</span>
        )}
        <span className="tf">
          {TIMEFRAMES.map((t) => (
            <button key={t.key} className={tf === t.key ? "on" : ""} onClick={() => setTf(t.key)} type="button">
              {t.key}
            </button>
          ))}
        </span>
      </div>

      <div className="chart-source">{sourceNote}</div>

      <div className="chart-canvas-wrap">
        <CandleChart candles={candles} markPrice={markPrice} liqLines={liqLines} trigLines={trigLines} />
        {status === "loading" && !candles && (
          <div className="chart-loading loading-dim">Loading {symbol} candles…</div>
        )}
      </div>
    </div>
  );
}
