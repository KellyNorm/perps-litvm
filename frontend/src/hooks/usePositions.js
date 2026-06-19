import { useCallback, useEffect, useRef, useState } from "react";
import { pmRead } from "../lib/contracts.js";
import { positionKey } from "../lib/marketKey.js";
import { assetToNum, priceToNum } from "../lib/engine.js";

const POLL_MS = 12_000;

// When connected, read positions(getPositionKey(owner, market, isLong)) for each
// live market × both sides; keep the open ones (sizeUsd > 0). Derived uPnL / liq /
// health are computed in the view from the LIVE mark; here we read the on-chain
// state plus the exact accrued borrow fee and signed funding (view fns on PM).
export function usePositions(account, supported) {
  const [positions, setPositions] = useState(null); // [] once loaded
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const pollRef = useRef(null);

  const key = account && supported && supported.length ? account + ":" + supported.map((m) => m.symbol).join(",") : "";

  useEffect(() => {
    if (!key) {
      setPositions(null);
      return;
    }
    let cancelled = false;
    const pm = pmRead();
    const owner = account;

    async function poll() {
      try {
        const jobs = [];
        for (const m of supported) {
          for (const isLong of [true, false]) {
            jobs.push(
              (async () => {
                const pkey = positionKey(owner, m.key, isLong);
                const p = await pm.positions(pkey);
                if (p.sizeUsd.isZero()) return null;
                const [feeBn, fundBn] = await Promise.all([
                  pm.pendingBorrowFee(owner, m.key, isLong),
                  pm.pendingFunding(owner, m.key, isLong),
                ]);
                return {
                  symbol: m.symbol,
                  name: m.name,
                  key: pkey,
                  isLong,
                  collateral: assetToNum(p.collateral),
                  sizeUsd: assetToNum(p.sizeUsd),
                  entryPrice: priceToNum(p.entryPrice),
                  borrowFee: assetToNum(feeBn),
                  fundingOwed: assetToNum(fundBn), // signed: + ⇒ owes, − ⇒ owed
                };
              })(),
            );
          }
        }
        const results = (await Promise.all(jobs)).filter(Boolean);
        if (!cancelled) setPositions(results);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    }

    pollRef.current = poll;
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      pollRef.current = null;
      clearInterval(timer.current);
    };
  }, [key]);

  // Manual refresh (e.g. right after a trade fills) so positions don't lag the poll.
  const refresh = useCallback(() => pollRef.current?.(), []);

  return { positions, error, refresh };
}
