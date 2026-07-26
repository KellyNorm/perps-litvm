// Multi-source public-exchange feed: OHLC candles + a fast live ticker. These are
// INDICATIVE reference prices for the chart/PnL display only — trades on this DEX
// execute against the on-chain RedStone mark, NOT these feeds.
//
// All exchange calls go through a same-origin proxy at /api/px/<exchange>/... (Vite
// server.proxy in dev, a Vercel function in prod) so the actual fetch happens server-side.
// This is required because some users' networks DNS-block these exchange APIs at the ISP
// level — fetching from the browser fails with ERR_NAME_NOT_RESOLVED, but the server is
// not blocked. Sources: Kraken, Bybit, Coinbase — each maps our market symbol to its own
// spot pair. Candles use the first source that responds; the live ticker queries all of
// them in parallel and takes the median (see fetchLiveTickers).

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
      const url = `/api/px/kraken/0/public/OHLC?pair=${pair}&interval=${tf.krakenInt}`;
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
      const url = `/api/px/bybit/v5/market/kline?category=spot&symbol=${pair}&interval=${tf.bybitInt}&limit=${tf.limit}`;
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
      const url = `/api/px/coinbase/products/${pair}/candles?granularity=${tf.cbGran}`;
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
// in one call; Bybit/Coinbase fan out per symbol. `quote` is the source's quote currency:
// Kraken (XBTUSD) and Coinbase (BTC-USD) quote in USD; Bybit (BTCUSDT) quotes in USDT,
// which can drift a few bp from the USD price people compare against — so USDT sources are
// dropped from the median whenever a USD source responds (see fetchLiveTickers).
const LIVE_TIMEOUT = 2500;

const LIVE_SOURCES = [
  {
    id: "Kraken",
    quote: "USD",
    async tickers(symbols, signal) {
      const pairs = symbols.map((s) => KRAKEN[s]).filter(Boolean).join(",");
      if (!pairs) return {};
      const j = await fetchJson(`/api/px/kraken/0/public/Ticker?pair=${pairs}`, LIVE_TIMEOUT, signal);
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
    quote: "USDT",
    async tickers(symbols, signal) {
      const pairs = await Promise.all(
        symbols.map(async (s) => {
          const pair = BYBIT[s];
          if (!pair) return [s, NaN];
          try {
            const j = await fetchJson(
              `/api/px/bybit/v5/market/tickers?category=spot&symbol=${pair}`,
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
    quote: "USD",
    async tickers(symbols, signal) {
      const pairs = await Promise.all(
        symbols.map(async (s) => {
          const pair = COINBASE[s];
          if (!pair) return [s, NaN];
          try {
            const j = await fetchJson(
              `/api/px/coinbase/products/${pair}/ticker`,
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

// Median of a non-empty list of numbers (average of the two middle values when even).
function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Poll the live ticker. Queries EVERY source in parallel (rather than first-responder-wins)
// and uses the MEDIAN of the prices that return within the deadline, so the shown number
// tracks the aggregated price people compare against instead of one exchange's quote. USD
// sources are preferred: when any USD source responds for a symbol, USDT sources are
// excluded from that symbol's median. Per-source timeout (LIVE_TIMEOUT) and the overall
// deadline (`signal`) both still apply. Returns { prices: { symbol: price }, source } —
// source is a "+"-joined label of the exchanges that fed the median, or null if none
// responded (the caller then holds the last good price / falls back to the mark line).
export async function fetchLiveTickers(symbols, signal) {
  // Fan out to all sources at once; each resolves to its { symbol: price } map, or {} on
  // failure/timeout so one dead source never sinks the rest.
  const responses = await Promise.all(
    LIVE_SOURCES.map(async (src) => {
      try {
        return { id: src.id, quote: src.quote, prices: await src.tickers(symbols, signal) };
      } catch {
        return { id: src.id, quote: src.quote, prices: {} };
      }
    }),
  );

  const prices = {};
  const usedIds = new Set();
  for (const s of symbols) {
    // Every source that returned a usable price for this symbol, tagged by quote currency.
    const quotes = responses
      .map((r) => ({ id: r.id, quote: r.quote, price: r.prices[s] }))
      .filter((q) => isFinite(q.price) && q.price > 0);
    if (!quotes.length) continue;
    // Prefer USD: drop USDT sources whenever at least one USD source responded.
    const usd = quotes.filter((q) => q.quote === "USD");
    const pool = usd.length ? usd : quotes;
    prices[s] = median(pool.map((q) => q.price));
    for (const q of pool) usedIds.add(q.id);
  }

  if (!usedIds.size) return { prices: {}, source: null };
  // Stable, canonical-order label of the exchanges that actually fed the median.
  const source = LIVE_SOURCES.filter((src) => usedIds.has(src.id)).map((src) => src.id).join("+");
  return { prices, source };
}
