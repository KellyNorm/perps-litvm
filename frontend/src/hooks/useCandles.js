import { useEffect, useRef, useState } from "react";
import { fetchCandles, hasExchangeFeed, TIMEFRAMES, DEFAULT_TF } from "../lib/exchanges.js";

// Re-export so existing imports (Chart.jsx) keep working.
export { TIMEFRAMES, DEFAULT_TF, hasExchangeFeed };

const REFRESH_MS = 30_000; // re-pull to advance the latest candle
const LOAD_DEADLINE_MS = 7_000; // hard cap on the FIRST load — never hang on "loading"

// Fetch + periodically refresh INDICATIVE OHLC candles for a market/timeframe from a
// globally-reachable, CORS-open exchange (Kraken → Bybit → Coinbase fallback). Returns
// { candles, status, source }: status is "loading" | "ok" | "error".
//
// CRUCIAL: the first load is bounded by LOAD_DEADLINE_MS. If no source answers in that
// window the status flips to "error" and the chart falls back to the live mark line —
// it NEVER hangs on "loading" (the failure mode in Binance-restricted regions).
export function useCandles(symbol, tfKey) {
  const [candles, setCandles] = useState(null);
  const [status, setStatus] = useState("loading");
  const [source, setSource] = useState(null);
  const seq = useRef(0);

  const supported = hasExchangeFeed(symbol);
  const tf = TIMEFRAMES.find((t) => t.key === tfKey) || TIMEFRAMES.find((t) => t.key === DEFAULT_TF);

  useEffect(() => {
    if (!supported || !tf) {
      setStatus("error");
      setCandles(null);
      setSource(null);
      return;
    }
    const myseq = ++seq.current;
    const ctrl = new AbortController();
    let timer = null;
    // Overall deadline for the first load so it can never hang on "loading".
    const deadline = setTimeout(() => ctrl.abort(), LOAD_DEADLINE_MS);

    setStatus("loading");
    setCandles(null);
    setSource(null);

    async function load() {
      try {
        const { candles: data, source: src } = await fetchCandles(symbol, tf, { signal: ctrl.signal });
        if (myseq !== seq.current) return;
        setCandles(data);
        setSource(src);
        setStatus("ok");
      } catch {
        if (myseq !== seq.current) return;
        // Keep a good chart if a periodic refresh merely blips; otherwise fall back.
        setStatus((s) => (s === "ok" ? "ok" : "error"));
      }
    }

    load().finally(() => clearTimeout(deadline));
    timer = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(deadline);
      if (timer) clearInterval(timer);
    };
  }, [symbol, supported, tf?.key]);

  return { candles, status, source };
}
