import { useEffect, useRef, useState } from "react";
import { fetchLiveTickers } from "../lib/exchanges.js";

const POLL_MS = 1_000; // fast tick so price / chart / PnL feel live (single tunable constant)
// Hard per-poll deadline. A poll that outruns this is aborted so a single hung request
// (common from a high-latency / proxied region) can never hold the in-flight lock — and
// thus freeze the whole feed — forever. Larger than POLL_MS: a slow poll just skips a few
// ticks, then either completes or self-aborts and the next tick retries.
const POLL_TIMEOUT_MS = 4_000;

// Fast live price feed from the public exchanges (Kraken → Bybit → Coinbase). This is
// the DISPLAY feed: it drives the shown price, the chart's current price, and position
// PnL so they tick smoothly (~1s) instead of freezing on the slow RedStone demo
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
    // One in-flight request at a time: if a poll is still awaiting when the next
    // interval fires, skip it rather than stacking requests. Regional latency can make
    // a poll outlast POLL_MS, and overlapping polls would pile up against the proxy.
    let inFlight = false;
    // Controller for the poll currently in flight, so unmount can abort it.
    let activeCtrl = null;

    async function poll() {
      if (inFlight) return; // previous poll still running — skip this tick
      inFlight = true;
      // Fresh controller + watchdog PER poll so each tick is independent and bounded.
      // The watchdog aborts the fetch if it hangs past the deadline; the finally below
      // ALWAYS clears the in-flight flag — whether the fetch resolves, throws, or is
      // aborted — so a failed poll can never lock the poller. The interval keeps firing
      // regardless, so the feed self-heals on the next tick.
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const watchdog = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS);
      try {
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
      } catch {
        // A failed / aborted / timed-out poll is non-fatal: drop it and let the next
        // tick retry. Keeping the last good price (we don't clear `live`) avoids a blip.
      } finally {
        clearTimeout(watchdog);
        if (activeCtrl === ctrl) activeCtrl = null;
        inFlight = false; // never leave the lock held
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (activeCtrl) activeCtrl.abort();
      clearInterval(id);
    };
  }, [key]);

  return { live, source };
}
