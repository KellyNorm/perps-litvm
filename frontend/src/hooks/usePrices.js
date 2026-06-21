import { useEffect, useRef, useState } from "react";
import { fetchMarks } from "../lib/redstone.js";

const POLL_MS = 6_000;
const MAX_POINTS = 720; // ~1.2h of samples at 6s cadence

// Poll the RedStone live mark for each supported feed and ACCUMULATE a price
// series per symbol (starts sparse, fills over time). No synthetic history — every
// point is an observed poll. `startedAt` lets the chart label how long it's been live.
export function usePrices(symbols) {
  const [marks, setMarks] = useState({}); // symbol -> {price, tsMs} | {error}
  const [series, setSeries] = useState({}); // symbol -> [{t, price}]
  const [startedAt] = useState(() => Date.now());
  const [lastUpdated, setLastUpdated] = useState(null);
  const seriesRef = useRef({});

  const key = symbols && symbols.length ? symbols.join(",") : "";

  useEffect(() => {
    if (!key) return;
    const feeds = key.split(",");
    let cancelled = false;

    async function poll() {
      let result;
      try {
        result = await fetchMarks(feeds);
      } catch {
        return; // never let a throw kill the interval — the chart keeps the last series
      }
      if (cancelled) return;
      // Keep the last GOOD mark per feed: only surface {error} for a feed we never had a
      // price for. A transient gateway blip must not blank an already-shown mark.
      setMarks((prev) => {
        const next = { ...prev };
        for (const f of feeds) {
          const r = result[f];
          if (r && typeof r.price === "number" && isFinite(r.price)) next[f] = r;
          else if (next[f] == null) next[f] = r;
        }
        return next;
      });
      const now = Date.now();
      const next = { ...seriesRef.current };
      for (const f of feeds) {
        const r = result[f];
        if (r && typeof r.price === "number" && isFinite(r.price)) {
          const arr = (next[f] || []).concat({ t: now, price: r.price });
          next[f] = arr.length > MAX_POINTS ? arr.slice(arr.length - MAX_POINTS) : arr;
        }
      }
      seriesRef.current = next;
      setSeries(next);
      setLastUpdated(now);
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key]);

  return { marks, series, startedAt, lastUpdated };
}
