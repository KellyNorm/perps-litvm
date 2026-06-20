import { useCallback, useEffect, useRef, useState } from "react";
import { pmRead } from "../lib/contracts.js";
import { loadOrderIds, addOrderId as persistOrderId, removeOrderId, scanOrderIds, readOrder } from "../lib/orders.js";
import { staticFillable } from "../lib/triggers.js";

const LIST_POLL_MS = 30_000; // re-read on-chain order state (catch fills/cancels)
const FILL_POLL_MS = 10_000; // fillability heartbeat (also our keeper-fill detector)
const KEEPER_GRACE_MS = 20_000; // met-but-unfilled this long -> offer manual fill

// The 11c resting-order layer, now DEFERRING to the keeper. Two jobs:
//   1) Build the wallet's open-order list from tracked ids (localStorage ∪ a
//      best-effort owner event-scan), reading requests(id)+triggers(id), keeping only
//      live resting triggers.
//   2) WATCH whether the KEEPER fills each met order. On an interval, run a READ-ONLY
//      static executeRequest per order (no gas, no signature, no prompt) to ask "would
//      this fill right now?". When one first goes fillable we mark it "filling" and
//      give the keeper a short grace window; only if it stays met-but-unfilled past
//      KEEPER_GRACE_MS do we surface the manual "Fill now" fallback ("ready"). While
//      any order is being filled we re-read the list so a keeper fill drops it promptly.
//      Honest scope: this tab only watches while open; the keeper bot is the real
//      filler now, this is the with/without-keeper fallback.
export function useOrders({ account, supported, toast }) {
  const [orders, setOrders] = useState(null); // [] once loaded, null before
  const [readiness, setReadiness] = useState({}); // id -> "ready" | "filling" | reason
  const prevReady = useRef(new Set());
  const readySince = useRef({}); // id -> ms first seen fillable (keeper grace clock)
  const refreshRef = useRef(null);

  const symKey = supported ? supported.map((m) => m.symbol).join(",") : "";

  const refresh = useCallback(async () => {
    if (!account || !supported || !supported.length) {
      setOrders(account ? [] : null);
      return;
    }
    try {
      const pm = pmRead();
      const ids = new Set(loadOrderIds(account));
      try {
        for (const id of await scanOrderIds(pm, account)) {
          ids.add(id);
          persistOrderId(account, id); // fold recovered ids into local tracking
        }
      } catch {}

      const byKey = {};
      for (const m of supported) byKey[m.key.toLowerCase()] = m;

      const out = [];
      for (const id of ids) {
        const o = await readOrder(pm, id, account);
        if (!o) {
          removeOrderId(account, id); // filled / cancelled / not ours — stop tracking
          continue;
        }
        const m = byKey[o.market.toLowerCase()];
        if (!m) continue; // market not in the supported set
        out.push({ ...o, symbol: m.symbol, name: m.name, feed: m.symbol });
      }
      out.sort((a, b) => Number(a.id) - Number(b.id));
      setOrders(out);
    } catch {
      // transient RPC hiccup — keep the prior list rather than flashing empty
    }
  }, [account, symKey]);

  refreshRef.current = refresh; // let the fill heartbeat re-read the list without a dep cycle

  useEffect(() => {
    refresh();
    if (!account) return;
    const t = setInterval(refresh, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [refresh, account]);

  // Fillability heartbeat (read-only). Re-armed whenever the order list changes.
  useEffect(() => {
    if (!account || !orders || !orders.length) {
      prevReady.current = new Set();
      return;
    }
    let cancelled = false;

    async function tick() {
      if (document.visibilityState !== "visible") return;
      const next = {};
      const liveIds = new Set();
      let anyFilling = false;
      for (const o of orders) {
        liveIds.add(o.id);
        let fillable = false;
        let reason = null;
        try {
          ({ fillable, reason } = await staticFillable(o.feed, o.id, account));
        } catch {
          reason = "resting";
        }
        if (fillable) {
          // Met — start (or read) the keeper grace clock. Within grace it's the
          // keeper's to fill ("filling"); past grace we surface the manual fallback.
          const since = readySince.current[o.id] || (readySince.current[o.id] = Date.now());
          if (Date.now() - since >= KEEPER_GRACE_MS) {
            next[o.id] = "ready";
          } else {
            next[o.id] = "filling";
            anyFilling = true;
          }
        } else {
          delete readySince.current[o.id];
          next[o.id] = reason || "resting";
        }
      }
      // Drop grace clocks for orders that left the list (filled/cancelled).
      for (const id of Object.keys(readySince.current)) if (!liveIds.has(id)) delete readySince.current[id];
      if (cancelled) return;
      setReadiness(next);

      // While the keeper is expected to be filling something, re-read the list so its
      // fill (which makes the request inactive) drops the order promptly instead of
      // waiting for the slower LIST_POLL.
      if (anyFilling) refreshRef.current?.();

      // One-time nudge only once an order crosses into the MANUAL window (grace lapsed,
      // keeper hasn't filled). The confirm is still a manual send from the table — we
      // never auto-fire a wallet tx.
      const ready = new Set(Object.keys(next).filter((id) => next[id] === "ready"));
      for (const id of ready) {
        if (!prevReady.current.has(id)) {
          const o = orders.find((x) => x.id === id);
          if (o) toast?.(`Keeper hasn't filled — you can fill ${o.typeLabel} ${o.symbol} yourself`);
        }
      }
      prevReady.current = ready;
    }

    tick();
    const t = setInterval(tick, FILL_POLL_MS);
    const onVis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [account, orders, toast]);

  const addOrderId = useCallback((acct, id) => persistOrderId(acct || account, id), [account]);

  return { orders, readiness, refresh, addOrderId };
}
