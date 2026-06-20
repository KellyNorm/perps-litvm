import { useEffect, useRef, useState } from "react";
import { fetchLiveTickers } from "../lib/exchanges.js";

const POLL_MS = 1_500; // fast tick so price / chart / PnL feel live

// Fast live price feed from the public exchanges (Kraken → Bybit → Coinbase). This is
// the DISPLAY feed: it drives the shown price, the chart's current price, and position
// PnL so they tick smoothly (~1.5s) instead of freezing on the slow RedStone demo
// oracle. It is INDICATIVE — trades still execute & realize against the on-chain
// RedStone mark; this never touches the trading path.
//
// Returns { live, source }: live is { symbol: { price, source, tsMs } } and updates in
// place per symbol (a momentary source blip keeps the last good price). `source` is the
// exchange currently serving prices, for display.
export function useLiveFeed(symbols) {
  const [live, setLive] = useState({});
  const [source, setSource] = useState(null);
  const sourceRef = useRef(null);

  const key = symbols && symbols.length ? symbols.join(",") : "";

  useEffect(() => {
    if (!key) return;
    const feeds = key.split(",");
    let cancelled = false;
    const ctrl = new AbortController();

    async function poll() {
      const { prices, source: src } = await fetchLiveTickers(feeds, sourceRef.current, ctrl.signal);
      if (cancelled) return;
      if (src) {
        sourceRef.current = src;
        setSource(src);
      }
      const now = Date.now();
      setLive((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const s of feeds) {
          if (isFinite(prices[s]) && prices[s] > 0) {
            next[s] = { price: prices[s], source: src, tsMs: now };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [key]);

  return { live, source };
}
