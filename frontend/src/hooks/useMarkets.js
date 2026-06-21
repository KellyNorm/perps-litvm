import { useEffect, useRef, useState } from "react";
import { pmRead } from "../lib/contracts.js";
import { marketKey } from "../lib/marketKey.js";
import { assetToNum, priceToNum } from "../lib/engine.js";
import { withRetry } from "../lib/withRetry.js";
import { CANDIDATE_MARKETS, addressesConfigured } from "../config.js";

const STATE_POLL_MS = 15_000;

// Discover which candidate markets are live (supportedMarkets == true) and poll
// each one's on-chain aggregate state (OI per side, mark, funding/borrow indices).
export function useMarkets() {
  const [supported, setSupported] = useState(null); // [{symbol,name,...,key}] | null while loading
  const [states, setStates] = useState({}); // symbol -> {longOI, shortOI, lastMark, raw}
  const [error, setError] = useState(null);
  const timer = useRef(null);

  // One-time discovery.
  useEffect(() => {
    let cancelled = false;
    if (!addressesConfigured()) {
      setError("Contract addresses not configured (see .env).");
      setSupported([]);
      return;
    }
    (async () => {
      try {
        const pm = pmRead();
        const checks = await Promise.all(
          CANDIDATE_MARKETS.map(async (m) => {
            const key = marketKey(m.symbol);
            try {
              const ok = await withRetry(() => pm.supportedMarkets(key));
              return ok ? { ...m, key } : null;
            } catch {
              return null;
            }
          }),
        );
        if (!cancelled) setSupported(checks.filter(Boolean));
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || String(e));
          setSupported([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll per-market state for the supported set.
  useEffect(() => {
    if (!supported || !supported.length) return;
    let cancelled = false;
    const pm = pmRead();

    async function poll() {
      try {
        const entries = await Promise.all(
          supported.map(async (m) => {
            const s = await withRetry(() => pm.markets(m.key));
            return [
              m.symbol,
              {
                longOI: assetToNum(s.longSizeUsd),
                shortOI: assetToNum(s.shortSizeUsd),
                lastMark: priceToNum(s.lastMarkPrice),
                raw: s,
              },
            ];
          }),
        );
        if (!cancelled) {
          setStates(Object.fromEntries(entries));
          setError(null); // a good poll clears any earlier discovery error
        }
      } catch {
        // Transient RPC drop (already retried by withRetry). Keep the last good states
        // and let the global "reconnecting…" indicator show — do NOT raise a hard red
        // "Market read failed" banner that wipes a working dashboard on a passing blip.
      }
    }

    poll();
    timer.current = setInterval(poll, STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer.current);
    };
  }, [supported]);

  return { supported, states, error, loading: supported === null };
}
