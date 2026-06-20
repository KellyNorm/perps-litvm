import { useEffect, useRef, useState } from "react";

// INDICATIVE OHLC history from a public exchange (Binance spot). This is a reference
// chart only — trades on this DEX execute against the on-chain RedStone mark, NOT this
// feed. We map our market symbol -> the Binance spot pair and pull klines (CORS-open,
// no key). Hosts are tried in order; data-api.binance.vision is the public market-data
// mirror (no geo-block / rate-limit headaches), api.binance.com is the fallback.
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

// Our market symbol -> Binance spot pair. Only mapped symbols get candles; anything
// else (or a fetch failure) falls back to the live RedStone mark line.
export const BINANCE_SYMBOL = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  LTC: "LTCUSDT",
};

// The existing selector set. `interval` is the Binance kline code; `limit` is how much
// history to pull (kept to a sensible window per timeframe).
export const TIMEFRAMES = [
  { key: "15m", interval: "15m", limit: 200 },
  { key: "1H", interval: "1h", limit: 240 },
  { key: "4H", interval: "4h", limit: 250 },
  { key: "1D", interval: "1d", limit: 365 },
];

export const DEFAULT_TF = "1H";

const REFRESH_MS = 30_000; // re-pull to advance the latest candle

export function binanceSymbol(symbol) {
  return BINANCE_SYMBOL[symbol] || null;
}

// Map a raw Binance kline row -> lightweight-charts candle. Row layout:
// [openTime(ms), open, high, low, close, volume, closeTime, ...]. Time is UTC seconds.
function toCandle(row) {
  return {
    time: Math.floor(row[0] / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
  };
}

async function fetchKlines(pair, interval, limit, signal) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) throw new Error("empty klines");
      return rows.map(toCandle).filter((c) => isFinite(c.close) && isFinite(c.time));
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("klines fetch failed");
}

// Fetch + periodically refresh OHLC candles for a market/timeframe. Returns
// { candles, status, pair }: status is "loading" | "ok" | "error". On error the chart
// falls back to the live RedStone mark line so nothing white-screens.
export function useCandles(symbol, tfKey) {
  const [candles, setCandles] = useState(null);
  const [status, setStatus] = useState("loading");
  const seq = useRef(0);

  const pair = binanceSymbol(symbol);
  const tf = TIMEFRAMES.find((t) => t.key === tfKey) || TIMEFRAMES.find((t) => t.key === DEFAULT_TF);

  useEffect(() => {
    if (!pair || !tf) {
      setStatus("error");
      setCandles(null);
      return;
    }
    const myseq = ++seq.current;
    const ctrl = new AbortController();
    let timer = null;

    setStatus("loading");
    setCandles(null);

    async function load() {
      try {
        const data = await fetchKlines(pair, tf.interval, tf.limit, ctrl.signal);
        if (myseq !== seq.current) return;
        setCandles(data);
        setStatus("ok");
      } catch {
        if (myseq !== seq.current || ctrl.signal.aborted) return;
        setStatus((s) => (s === "ok" ? "ok" : "error")); // keep a good chart if a refresh blips
      }
    }

    load();
    timer = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      if (timer) clearInterval(timer);
    };
  }, [pair, tf?.key]);

  return { candles, status, pair };
}
