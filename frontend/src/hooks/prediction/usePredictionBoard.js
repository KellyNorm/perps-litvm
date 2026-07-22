import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { readProvider } from "../../lib/contracts.js";
import { batchReadChunked, multicall3 } from "../../lib/prediction/multicall.js";
import { PREDICTION_FACTORY_ABI, AGGREGATOR_V3_ABI } from "../../lib/prediction/predictionAbi.js";
import { PREDICTION_FACTORY_ADDRESS, PHASE } from "../../lib/prediction/predictionConfig.js";

const POLL_MS = 12_000;

// How far back to walk for settled history. Live markets are always the newest ids,
// so walking from the tail finds them immediately; the extra depth only fills the
// SETTLED cards. Bounded so the batch cannot grow without limit as marketCount rises.
const HISTORY_DEPTH = 24;

function factory() {
  return new ethers.Contract(PREDICTION_FACTORY_ADDRESS, PREDICTION_FACTORY_ABI, readProvider());
}

/**
 * Reads the whole prediction board in ~3 RPC round trips via Multicall3.
 *
 * Everything here is READ-ONLY — no wallet required, matching how the perps
 * dashboard boots. `account` is optional and only adds the claimable() reads.
 */
export function usePredictionBoard(account) {
  const [markets, setMarkets] = useState(null); // null = first load
  const [assets, setAssets] = useState([]);
  const [error, setError] = useState(null);
  // Chain-clock anchor: { ts } is block.timestamp at the last poll, { at } is the
  // Date.now() ms when we sampled it. The UI interpolates ts + elapsed-wall between
  // polls, so countdowns count down to CHAIN time (what the keeper acts on), not the
  // browser clock, which on LitVM runs ahead of chain time.
  const [chainTime, setChainTime] = useState(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const f = factory();
    const mc = multicall3();
    try {
      // ---- pass 1: sizes + chain clock -----------------------------------
      const [countRes, assetCountRes, tsRes] = await batchReadChunked([
        { contract: f, fn: "marketCount" },
        { contract: f, fn: "assetCount" },
        { contract: mc, fn: "getCurrentBlockTimestamp" },
      ]);
      if (!countRes.ok || !assetCountRes.ok) throw new Error("factory unreachable");

      // Anchor to chain time; if the clock read failed, fall back to wall-clock so
      // countdowns still run rather than freezing.
      const chainTs = tsRes.ok ? tsRes.value.toNumber() : Math.floor(Date.now() / 1000);

      const marketCount = countRes.value.toNumber();
      const assetCount = assetCountRes.value.toNumber();

      // ---- pass 2: asset registry + market rows ---------------------------
      // Symbols come from chain. Note asset 9 is the string "ZCASH", not "ZEC" —
      // any symbol-keyed lookup needs that alias (see CoinIcon).
      const assetCalls = Array.from({ length: assetCount }, (_, i) => ({
        contract: f,
        fn: "assets",
        args: [i],
      }));

      const from = Math.max(0, marketCount - HISTORY_DEPTH);
      const ids = Array.from({ length: marketCount - from }, (_, i) => from + i);
      const marketCalls = ids.flatMap((id) => [
        { contract: f, fn: "getMarket", args: [id] },
        { contract: f, fn: "timeframeOf", args: [id] },
        { contract: f, fn: "pools", args: [id] },
      ]);

      const res = await batchReadChunked([...assetCalls, ...marketCalls]);
      const assetRows = res.slice(0, assetCount).map((r, i) =>
        r.ok
          ? { id: i, symbol: r.value.symbol, feed: r.value.feed, displayDp: r.value.displayDp, enabled: r.value.enabled }
          : { id: i, symbol: `#${i}`, feed: ethers.constants.AddressZero, displayDp: 2, enabled: false },
      );

      const rows = [];
      for (let k = 0; k < ids.length; k++) {
        const m = res[assetCount + k * 3];
        const tf = res[assetCount + k * 3 + 1];
        const pools = res[assetCount + k * 3 + 2];
        // A market we cannot read is skipped, not rendered half-blank.
        if (!m.ok || !tf.ok || !pools.ok) continue;

        const asset = assetRows[m.value.assetId] || null;
        rows.push({
          id: ids[k],
          assetId: m.value.assetId,
          symbol: asset ? asset.symbol : `#${m.value.assetId}`,
          displayDp: asset ? asset.displayDp : 2,
          feed: m.value.feed,
          tLock: m.value.tLock.toNumber(),
          tExpiry: m.value.tExpiry.toNumber(),
          strike: m.value.strike,
          settlePrice: m.value.settlePrice,
          phase: m.value.phase,
          outcome: m.value.outcome,
          timeframe: tf.value,
          upPool: pools.value.upPool,
          downPool: pools.value.downPool,
          // Per-market fee SNAPSHOT. Currently 0, but read live — a market settles at
          // the fee captured when it was created, not at today's global feeBps.
          feeBps: pools.value.marketFeeBps,
        });
      }

      // ---- pass 3: live prices + claimable --------------------------------
      // One latestRoundData per DISTINCT feed actually on the board, not per market.
      const feeds = [...new Set(rows.map((r) => r.feed.toLowerCase()))];
      const priceCalls = feeds.map((addr) => ({
        contract: new ethers.Contract(addr, AGGREGATOR_V3_ABI, readProvider()),
        fn: "latestRoundData",
      }));
      const claimCalls = account
        ? rows
            .filter((r) => r.phase === PHASE.SETTLED || r.phase === PHASE.VOID)
            .map((r) => ({ contract: f, fn: "claimable", args: [r.id, account] }))
        : [];

      const tail = await batchReadChunked([...priceCalls, ...claimCalls]);
      const priceByFeed = {};
      feeds.forEach((addr, i) => {
        const r = tail[i];
        // A stale/failed feed read leaves price null — the UI shows "—" rather than
        // inventing a number. Never render a fabricated price next to a strike.
        priceByFeed[addr] = r.ok ? { answer: r.value.answer, updatedAt: r.value.updatedAt.toNumber() } : null;
      });

      const claimTargets = rows.filter((r) => r.phase === PHASE.SETTLED || r.phase === PHASE.VOID);
      const claimById = {};
      claimTargets.forEach((r, i) => {
        const res2 = tail[feeds.length + i];
        if (res2 && res2.ok) claimById[r.id] = res2.value;
      });

      const enriched = rows.map((r) => ({
        ...r,
        price: priceByFeed[r.feed.toLowerCase()] || null,
        claimable: claimById[r.id] || null,
      }));

      if (!alive.current) return;
      setChainTime({ ts: chainTs, at: Date.now() });
      setAssets(assetRows);
      setMarkets(enriched);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // Keep the last good board on screen; surface the error without blanking.
      setError(e?.message || "board read failed");
    }
  }, [account]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  return { markets, assets, error, chainTime, loading: markets === null, refresh: load };
}
