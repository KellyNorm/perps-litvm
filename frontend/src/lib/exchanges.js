// Multi-source public-exchange feed: OHLC candles + a fast live ticker. These are
// INDICATIVE reference prices for the chart/PnL display only — trades on this DEX
// execute against the on-chain RedStone mark, NOT these feeds.
//
// Why not Binance: api.binance.com / data-api.binance.vision are geo-blocked in some
// regions, so the chart would hang on "loading" there. We try globally-reachable,
// CORS-open exchanges in order and use the first that responds: Kraken → Bybit →
// Coinbase. Each maps our market symbol to its own spot pair.

// Our market symbol -> each source's spot pair. Only mapped symbols get a feed;
// anything else falls back to the live RedStone mark line.
const KRAKEN = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", LTC: "LTCUSD" };
const BYBIT = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", LTC: "LTCUSDT" };
const COINBASE = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", LTC: "LTC-USD" };

// Kraken returns canonical result keys (e.g. "XXBTZUSD") that differ from the request
// pair, so we match by base-asset code instead of the literal pair string.
const KRAKEN_BASE = { BTC: "XBT", ETH: "ETH", SOL: "SOL", LTC: "LTC" };

// Timeframe selector set. Each carries the per-source granularity code: Kraken/Bybit
// take minutes, Coinbase takes seconds. `limit` is the max history we keep per TF.
export const TIMEFRAMES = [
  { key: "15m", krakenInt: 15, bybitInt: "15", cbGran: 900, limit: 200 },
  { key: "1H", krakenInt: 60, bybitInt: "60", cbGran: 3600, limit: 240 },
  { key: "4H", krakenInt: 240, bybitInt: "240", cbGran: 21600, limit: 250 },
  { key: "1D", krakenInt: 1440, bybitInt: "D", cbGran: 86400, limit: 300 },
];

export const DEFAULT_TF = "1H";

// True if any source can chart this symbol (otherwise the live mark line is used).
export function hasExchangeFeed(symbol) {
  return Boolean(KRAKEN[symbol] || BYBIT[symbol] || COINBASE[symbol]);
}

// fetch with its own abort timeout, chained to an optional parent signal. Rejects on
// timeout, parent-abort, non-2xx, or transport error.
async function fetchJson(url, ms, parentSignal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

// Normalize raw OHLC rows -> lightweight-charts candles, ascending unique time (UTC s).
function cleanCandles(rows) {
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    if (!isFinite(c.time) || !isFinite(c.close) || seen.has(c.time)) continue;
    seen.add(c.time);
    out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// --- Source adapters: candles ----------------------------------------------
// Each returns a normalized candle array, or throws if it can't serve this symbol/TF.
const CANDLE_SOURCES = [
  {
    id: "Kraken",
    async candles(symbol, tf, perTryMs, signal) {
      const pair = KRAKEN[symbol];
      if (!pair) throw new Error("unmapped");
      const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${tf.krakenInt}`;
      const j = await fetchJson(url, perTryMs, signal);
      if (j?.error?.length) throw new Error(j.error.join(","));
      const result = j?.result || {};
      const key = Object.keys(result).find((k) => k !== "last");
      const rows = key && result[key];
      if (!Array.isArray(rows) || !rows.length) throw new Error("empty");
      // [time, open, high, low, close, vwap, volume, count]
      return rows.map((r) => ({
        time: Math.floor(Number(r[0])),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      }));
    },
  },
  {
    id: "Bybit",
    async candles(symbol, tf, perTryMs, signal) {
      const pair = BYBIT[symbol];
      if (!pair) throw new Error("unmapped");
      const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${tf.bybitInt}&limit=${tf.limit}`;
      const j = await fetchJson(url, perTryMs, signal);
      const rows = j?.result?.list;
      if (!Array.isArray(rows) || !rows.length) throw new Error("empty");
      // newest-first: [startMs, open, high, low, close, volume, turnover]
      return rows.map((r) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      }));
    },
  },
  {
    id: "Coinbase",
    async candles(symbol, tf, perTryMs, signal) {
      const pair = COINBASE[symbol];
      if (!pair) throw new Error("unmapped");
      const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${tf.cbGran}`;
      const j = await fetchJson(url, perTryMs, signal);
      if (!Array.isArray(j) || !j.length) throw new Error("empty");
      // newest-first: [time(s), low, high, open, close, volume]
      return j.map((r) => ({
        time: Math.floor(Number(r[0])),
        open: Number(r[3]),
        high: Number(r[2]),
        low: Number(r[1]),
        close: Number(r[4]),
      }));
    },
  },
];

// Try each candle source in order; first to return usable candles wins. `signal` (an
// overall deadline) aborts everything; `perTryMs` bounds each individual source so one
// slow host can't eat the whole budget. Returns { candles, source } or throws.
export async function fetchCandles(symbol, tf, { signal, perTryMs = 3500 } = {}) {
  let lastErr;
  for (const src of CANDLE_SOURCES) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const raw = await src.candles(symbol, tf, perTryMs, signal);
      const candles = cleanCandles(raw).slice(-tf.limit);
      if (candles.length) return { candles, source: src.id };
      throw new Error("empty after clean");
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("no candle source responded");
}

// --- Source adapters: live ticker ------------------------------------------
// Each returns { symbol: price } for whatever it could fetch. Kraken batches all pairs
// in one call; Bybit/Coinbase fan out per symbol.
const LIVE_TIMEOUT = 2500;

const LIVE_SOURCES = [
  {
    id: "Kraken",
    async tickers(symbols, signal) {
      const pairs = symbols.map((s) => KRAKEN[s]).filter(Boolean).join(",");
      if (!pairs) return {};
      const j = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, LIVE_TIMEOUT, signal);
      if (j?.error?.length) throw new Error(j.error.join(","));
      const result = j?.result || {};
      const keys = Object.keys(result);
      const out = {};
      for (const s of symbols) {
        const base = KRAKEN_BASE[s];
        if (!base) continue;
        const k = keys.find((x) => x.includes(base) && x.endsWith("USD"));
        const last = k && Number(result[k]?.c?.[0]); // c = [lastPrice, lotVolume]
        if (isFinite(last) && last > 0) out[s] = last;
      }
      return out;
    },
  },
  {
    id: "Bybit",
    async tickers(symbols, signal) {
      const pairs = await Promise.all(
        symbols.map(async (s) => {
          const pair = BYBIT[s];
          if (!pair) return [s, NaN];
          try {
            const j = await fetchJson(
              `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`,
              LIVE_TIMEOUT,
              signal,
            );
            return [s, Number(j?.result?.list?.[0]?.lastPrice)];
          } catch {
            return [s, NaN];
          }
        }),
      );
      const out = {};
      for (const [s, p] of pairs) if (isFinite(p) && p > 0) out[s] = p;
      return out;
    },
  },
  {
    id: "Coinbase",
    async tickers(symbols, signal) {
      const pairs = await Promise.all(
        symbols.map(async (s) => {
          const pair = COINBASE[s];
          if (!pair) return [s, NaN];
          try {
            const j = await fetchJson(
              `https://api.exchange.coinbase.com/products/${pair}/ticker`,
              LIVE_TIMEOUT,
              signal,
            );
            return [s, Number(j?.price)];
          } catch {
            return [s, NaN];
          }
        }),
      );
      const out = {};
      for (const [s, p] of pairs) if (isFinite(p) && p > 0) out[s] = p;
      return out;
    },
  },
];

// Poll the live ticker. Tries the previously-working source first (sticky, to avoid
// jumping between exchanges mid-stream), then the rest in order. Returns
// { prices: { symbol: price }, source } — source is null if none responded.
export async function fetchLiveTickers(symbols, preferred, signal) {
  const order = preferred
    ? [...LIVE_SOURCES.filter((s) => s.id === preferred), ...LIVE_SOURCES.filter((s) => s.id !== preferred)]
    : LIVE_SOURCES;
  for (const src of order) {
    if (signal?.aborted) break;
    try {
      const prices = await src.tickers(symbols, signal);
      if (symbols.some((s) => isFinite(prices[s]))) return { prices, source: src.id };
    } catch {
      // try the next source
    }
  }
  return { prices: {}, source: null };
}
