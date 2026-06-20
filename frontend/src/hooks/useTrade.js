import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES } from "../config.js";
import { pmWrite, musdWrite, pmRead } from "../lib/contracts.js";
import { loadPending, savePending, clearPending } from "../lib/pending.js";
import * as trade from "../lib/trade.js";

const VERBING = { open: "Opening", increase: "Increasing", close: "Closing", decrease: "Decreasing" };
const IN_PROGRESS = ["approving", "requesting", "waiting", "executing"];

// Keeper-deferral tuning. After leg 1 the request is the keeper's to fill; we WATCH
// (read-only) and only fall back to self-execute if the keeper doesn't resolve it.
const WATCH_POLL_MS = 4_000; // requests(id).active + event reconcile cadence
const KEEPER_GRACE_SEC = 28; // unresolved past this -> surface the self-execute fallback

const nowSec = () => Math.floor(Date.now() / 1000);

// Drives the whole two-step market-order loop for the connected wallet acting as its
// own keeper: approve (if needed) -> request (leg 1) -> wait for a fresh payload ->
// executeRequest (leg 2) -> classify the outcome honestly. Exactly ONE trade is
// in-flight at a time (the contract serializes a position's lifecycle anyway), so a
// single `flow` powers the global status banner. A pending breadcrumb is persisted to
// localStorage after leg 1 so a refresh / abandoned wallet prompt can resume leg 2.
export function useTrade({ account, getSigner, wrongChain, toast, onTraded, addOrderId }) {
  const [flow, setFlow] = useState(null);
  const [pending, setPending] = useState(null);
  const [lastFill, setLastFill] = useState({ n: 0 }); // bumps per fill -> ignite the button
  const busyRef = useRef(false);
  const clearTimer = useRef(null);

  // On connect / account switch, resume WATCHING any unfinished request. The keeper
  // may have already filled it while we were away, so the watcher effect reconciles
  // immediately; if it's old enough that the keeper clearly isn't coming, the
  // self-execute fallback is offered right away.
  useEffect(() => {
    clearTimeout(clearTimer.current);
    if (!account) {
      setPending(null);
      setFlow(null);
      return;
    }
    const crumb = loadPending(account);
    setPending(crumb);
    setFlow(
      crumb
        ? {
            phase: "watching",
            ...crumb,
            fallbackReady: nowSec() - (crumb.requestTs || 0) >= KEEPER_GRACE_SEC,
            message: "Unfinished order — checking whether the keeper filled it…",
          }
        : null,
    );
  }, [account]);

  const scheduleClear = useCallback((ms = 6000) => {
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFlow(null), ms);
  }, []);

  // Apply a resolution read from chain state/events (no local receipt — the keeper
  // sent the execute). A fill bumps lastFill so the trade button glows.
  const applyOutcome = useCallback(
    (crumb, outcome) => {
      clearPending(account);
      setPending(null);
      if (outcome?.kind === "filled") {
        setFlow({ phase: "done", ...crumb, ok: true, message: `${crumb.verb} ${crumb.symbol} ✓` });
        toast(`${crumb.verb} ${crumb.symbol} ✓`);
        setLastFill((s) => ({ n: s.n + 1, action: crumb.action, isLong: crumb.isLong, symbol: crumb.symbol }));
      } else if (outcome?.kind === "slippage") {
        setFlow({ phase: "done", ...crumb, ok: false, message: "Price moved past your limit — refunded." });
        toast("Price moved past your limit — refunded.", true);
      } else if (outcome?.kind === "cancelled") {
        setFlow({ phase: "done", ...crumb, ok: true, message: "Order cancelled — refunded." });
        toast("Order cancelled — refunded.");
      } else {
        // Resolved but unlabelled (event window missed) — still refresh on-chain truth.
        setFlow({ phase: "done", ...crumb, ok: true, message: `${crumb.verb || "Order"} ${crumb.symbol || ""} — resolved.` });
      }
      onTraded?.();
      scheduleClear();
    },
    [account, toast, onTraded, scheduleClear],
  );

  // WATCH a pending market request for keeper resolution. Read-only: polls
  // requests(id).active and reconciles the outcome from events — no signature, no gas.
  // Pauses while a manual leg (self-execute / cancel) holds busyRef so the two don't
  // race. After KEEPER_GRACE_SEC unresolved, exposes the self-execute fallback; the
  // watcher keeps running, so a late keeper fill still wins the race.
  useEffect(() => {
    if (!account || !pending) return;
    let stopped = false;

    const graceAt = (pending.requestTs || nowSec()) + KEEPER_GRACE_SEC;
    const graceMs = Math.max(0, graceAt - nowSec()) * 1000;
    const graceTimer = setTimeout(() => {
      if (stopped) return;
      setFlow((f) =>
        f && f.phase === "watching" && f.id === pending.id
          ? { ...f, fallbackReady: true, message: "Keeper hasn't filled this yet. Keep waiting, or execute it yourself." }
          : f,
      );
    }, graceMs);

    async function poll() {
      if (stopped || busyRef.current) return; // a manual leg is driving — stand down
      let state;
      try {
        state = await trade.readRequestState(pmRead(), pending.id, pending.fromBlock);
      } catch {
        return; // transient RPC hiccup — try again next tick
      }
      if (stopped || busyRef.current || state.active) return;
      applyOutcome(pending, state.outcome);
    }

    poll(); // reconcile immediately (keeper may have filled within seconds / while away)
    const iv = setInterval(poll, WATCH_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(graceTimer);
      clearInterval(iv);
    };
  }, [account, pending, applyOutcome]);

  // Leg 2 self-execute (the manual fallback path): append a fresh payload,
  // executeRequest, then tell the outcome from THIS receipt's events. Throws on revert
  // (caller keeps the breadcrumb and offers execute-it-yourself / cancel).
  const runExecute = useCallback(
    async (crumb) => {
      setFlow((f) => ({ ...(f || {}), ...crumb, phase: "executing", message: "Step 2 of 2 — confirm the execute in your wallet…" }));
      const pm = pmWrite(getSigner());
      const { outcome } = await trade.executeRequest(pm, crumb.feed, crumb.id);
      clearPending(account);
      setPending(null);
      if (outcome.kind === "filled") {
        setFlow({ phase: "done", ...crumb, ok: true, message: `${crumb.verb} ${crumb.symbol} ✓` });
        toast(`${crumb.verb} ${crumb.symbol} ✓`);
        setLastFill((s) => ({ n: s.n + 1, action: crumb.action, isLong: crumb.isLong, symbol: crumb.symbol }));
      } else if (outcome.kind === "slippage") {
        setFlow({ phase: "done", ...crumb, ok: false, message: "Price moved past your limit — refunded." });
        toast("Price moved past your limit — refunded.", true);
      } else {
        setFlow({ phase: "done", ...crumb, ok: true, message: "Executed." });
        toast("Executed.");
      }
      onTraded?.();
      scheduleClear();
    },
    [account, getSigner, toast, onTraded, scheduleClear],
  );

  // Centralized failure handling: if a breadcrumb exists (leg 1 already landed), keep
  // it and offer resume/cancel; otherwise the failure was pre-request, so just clear.
  const handleError = useCallback(
    (err, action) => {
      const crumb = loadPending(account);
      const reason = err?.message || String(err);
      if (!crumb) {
        setFlow(null);
        if (!err?.rejected) toast(`Failed: ${reason.slice(0, 80)}`, true);
        else toast("Cancelled.", true);
        return;
      }
      setFlow({
        phase: "error",
        ...crumb,
        fallbackReady: true,
        error: reason,
        message: err?.rejected
          ? "You dismissed the wallet prompt — your order is still pending. The keeper may still fill it, or execute it yourself."
          : `Self-execute reverted: ${reason.slice(0, 120)}. The keeper may still fill it.`,
      });
    },
    [account, toast],
  );

  // The full happy path for an action from the UI.
  const submit = useCallback(
    async (p) => {
      if (busyRef.current) return toast("A trade is already in progress.", true);
      if (!account) return toast("Connect a wallet first.", true);
      if (wrongChain) return toast("Switch to LiteForge (4441) first.", true);
      if (loadPending(account)) return toast("Finish or cancel your pending order first.", true);

      const a = trade.ACTIONS[p.action];
      if (!a) return toast(`Unknown action ${p.action}`, true);
      const feed = p.symbol;
      const market = trade.marketKey(p.symbol);

      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        const signer = getSigner();
        const pm = pmWrite(signer);
        const musd = musdWrite(signer);

        // 1) Allowance — open/increase need collateral + fee; close/decrease need the
        //    fee only. Surface the one-time approve as its own step.
        const collateral1e18 = a.needsCollateral ? trade.toAsset(p.collateral) : ethers.constants.Zero;
        const needed = a.needsCollateral ? collateral1e18.add(trade.EXECUTION_FEE) : trade.EXECUTION_FEE;
        setFlow({ phase: "approving", action: p.action, symbol: p.symbol, isLong: p.isLong, verb: a.verb, message: "Checking mUSD allowance…" });
        await trade.ensureAllowance(musd, account, ADDRESSES.positionManager, needed, () =>
          setFlow((f) => ({ ...f, message: "Approve mUSD spending — confirm in your wallet (one-time)." })),
        );

        // 2) Acceptable price off the FRESH mark × slippage (directional, both sides).
        setFlow((f) => ({ ...f, phase: "requesting", message: "Fetching the live price…" }));
        const mark = await trade.freshMark(feed);
        const acceptable = trade.acceptablePrice1e8(mark, p.slipFrac, a.isOpenSide, p.isLong);

        // 3) Leg 1 — send the request.
        setFlow((f) => ({ ...f, phase: "requesting", message: `Step 1 of 2 — ${VERBING[p.action].toLowerCase()}: confirm the request in your wallet…` }));
        const { id, requestTs, rcpt } = await trade.sendRequest(pm, p.action, market, p.isLong, {
          collateral: collateral1e18,
          leverage: a.needsCollateral ? Math.round(p.leverage) : 0,
          acceptablePrice: acceptable,
          closeBps: p.closeBps || 0,
        });

        // Persist the breadcrumb (incl. the block to scan events from) so a refresh
        // resumes watching, then hand off to the KEEPER — no auto-execute. The watcher
        // effect (keyed on `pending`) takes it from here.
        const crumb = { id: id.toString(), requestTs, fromBlock: rcpt.blockNumber, action: p.action, symbol: p.symbol, feed, isLong: p.isLong, verb: a.verb };
        savePending(account, crumb);
        setFlow({ phase: "watching", ...crumb, fallbackReady: false, message: "Submitted — waiting for the keeper to fill it…" });
        setPending(crumb);
      } catch (err) {
        handleError(err, p.action);
      } finally {
        busyRef.current = false;
      }
    },
    [account, wrongChain, getSigner, toast, handleError],
  );

  // MANUAL FALLBACK (keeper down / not running): execute the request yourself. Same
  // self-execute path as before keeper deferral — fetch a fresh payload, then send
  // executeRequest with the connected wallet acting as its own keeper. If the keeper
  // (or anyone) filled it between the watcher's last poll and this send, executeRequest
  // reverts RequestNotActive; we reconcile that as a resolution rather than an error,
  // so the fallback never strands a request the keeper already handled.
  const executeNow = useCallback(async () => {
    if (busyRef.current) return;
    const crumb = pending || loadPending(account);
    if (!crumb) return;
    busyRef.current = true;
    clearTimeout(clearTimer.current);
    try {
      setFlow({ ...crumb, phase: "waiting", message: "Executing it yourself — fetching a fresh price…" });
      await trade.waitForFreshPayload(crumb.feed, crumb.requestTs, ({ pkgTs, floor }) =>
        setFlow((f) => (f && f.phase === "waiting" ? { ...f, message: `Executing it yourself — waiting for a fresh price (pkg ${pkgTs || "…"} · need ≥ ${floor})` } : f)),
      );
      await runExecute(crumb);
    } catch (err) {
      const reason = err?.message || String(err);
      if (!err?.rejected && /RequestNotActive/.test(reason)) {
        // The keeper beat us to it — read the real outcome and present THAT.
        try {
          const state = await trade.readRequestState(pmRead(), crumb.id, crumb.fromBlock);
          applyOutcome(crumb, state.active ? { kind: "unknown" } : state.outcome);
          return;
        } catch {
          /* fall through to the generic handler */
        }
      }
      handleError(err, crumb.action);
    } finally {
      busyRef.current = false;
    }
  }, [pending, account, runExecute, handleError, applyOutcome]);

  // Manual fallback: owner-reclaim the request after CANCEL_DELAY (collateral+fee for
  // open/increase, fee for close/decrease — the contract decides which).
  const cancelPending = useCallback(async () => {
    if (busyRef.current) return;
    const crumb = pending || loadPending(account);
    if (!crumb) return;
    busyRef.current = true;
    clearTimeout(clearTimer.current);
    try {
      setFlow({ ...crumb, phase: "executing", message: "Cancelling & refunding — confirm in your wallet…" });
      await trade.cancelRequest(pmWrite(getSigner()), crumb.id);
      clearPending(account);
      setPending(null);
      setFlow({ phase: "done", ...crumb, ok: true, message: "Order cancelled — refunded." });
      toast("Order cancelled — refunded.");
      onTraded?.();
      scheduleClear();
    } catch (err) {
      const reason = err?.message || String(err);
      setFlow({
        phase: "error",
        ...crumb,
        error: reason,
        message: /TooEarlyToCancel/.test(reason)
          ? "Too early to cancel — the refund window hasn't opened yet. Try resuming instead."
          : `Cancel failed: ${reason.slice(0, 120)}`,
      });
      toast("Cancel failed.", true);
    } finally {
      busyRef.current = false;
    }
  }, [pending, account, getSigner, toast, onTraded, scheduleClear]);

  // --- 11c resting orders -------------------------------------------------------
  // Place a RESTING trigger ENTRY — limit/stop OPEN (no position yet) OR limit/stop
  // INCREASE (add to a live position). Both are single-leg, escrow collateral + fee,
  // and rest on-chain until the keeper poll fills them (NO leg-2 here). The ONLY
  // on-chain difference is requestTriggerOpen vs requestTriggerIncrease (and the latter
  // takes the position's closePending mutex). triggerAbove is derived from
  // trigger-vs-mark (never the Limit/Stop label); a STOP entry gets the permissive
  // acceptablePrice so the catch isn't blocked by SlippageNotMet. `p.kind` is
  // "open" | "increase".
  const submitTriggerEntry = useCallback(
    async (p) => {
      if (busyRef.current) return toast("A trade is already in progress.", true);
      if (!account) return toast("Connect a wallet first.", true);
      if (wrongChain) return toast("Switch to LiteForge (4441) first.", true);
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      const kind = p.kind === "increase" ? "increase" : "open";
      const noun = kind === "increase" ? "increase" : "order"; // "limit increase" / "limit order"
      try {
        const signer = getSigner();
        const pm = pmWrite(signer);
        const musd = musdWrite(signer);
        const market = trade.marketKey(p.symbol);
        const collateral1e18 = trade.toAsset(p.collateral);
        const needed = collateral1e18.add(trade.EXECUTION_FEE);

        const triggerAbove = p.triggerPrice >= p.mark;
        const isStop = triggerAbove === p.isLong; // entry stop
        const label = isStop ? "Stop" : "Limit";

        setFlow({ phase: "approving", action: kind, symbol: p.symbol, isLong: p.isLong, verb: "Placed", message: "Checking mUSD allowance…" });
        await trade.ensureAllowance(musd, account, ADDRESSES.positionManager, needed, () =>
          setFlow((f) => ({ ...f, message: "Approve mUSD spending — confirm in your wallet (one-time)." })),
        );

        const buffer = isStop ? trade.STOP_SLIP : p.slipFrac;
        const acceptable = trade.acceptablePrice1e8(p.triggerPrice, buffer, true, p.isLong);
        const trigger1e8 = ethers.BigNumber.from(Math.round(p.triggerPrice * 1e8).toString());

        setFlow((f) => ({ ...f, phase: "requesting", message: `Placing your ${label.toLowerCase()} ${noun} — confirm in your wallet…` }));
        const { id } = await trade.sendTriggerRequest(pm, kind, market, p.isLong, {
          collateral: collateral1e18,
          leverage: Math.round(p.leverage),
          acceptablePrice: acceptable,
          triggerPrice: trigger1e8,
          triggerAbove,
        });
        addOrderId?.(account, id.toString());

        setFlow({ phase: "done", ok: true, symbol: p.symbol, isLong: p.isLong, message: `${label} ${noun} resting until ${p.symbol} ${triggerAbove ? "≥" : "≤"} $${p.triggerPrice}.` });
        toast(`${label} ${noun} placed ✓`);
        onTraded?.();
        scheduleClear();
      } catch (err) {
        const reason = err?.message || String(err);
        if (err?.rejected) {
          setFlow(null);
          toast("Cancelled.", true);
        } else {
          setFlow({
            phase: "done",
            ok: false,
            symbol: p.symbol,
            message: /CloseAlreadyPending/.test(reason)
              ? "This position already has a resting trigger-edit (one at a time)."
              : `Order failed: ${reason.slice(0, 110)}`,
          });
          toast("Order failed.", true);
          scheduleClear();
        }
      } finally {
        busyRef.current = false;
      }
    },
    [account, wrongChain, getSigner, toast, onTraded, scheduleClear, addOrderId],
  );

  // Place a RESTING trigger EXIT (TP / SL) on an open position: requestTriggerClose
  // (full) or requestTriggerDecrease (partial, closeBps). Escrows the fee only. The
  // engine's closePending mutex allows only ONE resting exit per position (no OCO).
  // A stop-loss gets the permissive acceptablePrice; take-profit uses the normal bound.
  const submitTriggerExit = useCallback(
    async (p) => {
      if (busyRef.current) return toast("A trade is already in progress.", true);
      if (!account) return toast("Connect a wallet first.", true);
      if (wrongChain) return toast("Switch to LiteForge (4441) first.", true);
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        const signer = getSigner();
        const pm = pmWrite(signer);
        const musd = musdWrite(signer);
        const market = trade.marketKey(p.symbol);

        const triggerAbove = p.triggerPrice >= p.mark;
        const isStop = triggerAbove !== p.isLong; // exit stop-loss
        const label = isStop ? "Stop-loss" : "Take-profit";

        setFlow({ phase: "approving", action: p.kind, symbol: p.symbol, isLong: p.isLong, verb: "Placed", message: "Checking mUSD allowance…" });
        await trade.ensureAllowance(musd, account, ADDRESSES.positionManager, trade.EXECUTION_FEE, () =>
          setFlow((f) => ({ ...f, message: "Approve the 0.5 mUSD fee — confirm in your wallet (one-time)." })),
        );

        const buffer = isStop ? trade.STOP_SLIP : 0.005;
        const acceptable = trade.acceptablePrice1e8(p.triggerPrice, buffer, false, p.isLong);
        const trigger1e8 = ethers.BigNumber.from(Math.round(p.triggerPrice * 1e8).toString());

        setFlow((f) => ({ ...f, phase: "requesting", message: `Placing your ${label.toLowerCase()} — confirm in your wallet…` }));
        const { id } = await trade.sendTriggerRequest(pm, p.kind, market, p.isLong, {
          acceptablePrice: acceptable,
          closeBps: p.closeBps || 0,
          triggerPrice: trigger1e8,
          triggerAbove,
        });
        addOrderId?.(account, id.toString());

        setFlow({ phase: "done", ok: true, symbol: p.symbol, isLong: p.isLong, message: `${label} resting until ${p.symbol} ${triggerAbove ? "≥" : "≤"} $${p.triggerPrice}.` });
        toast(`${label} placed ✓`);
        onTraded?.();
        scheduleClear();
      } catch (err) {
        const reason = err?.message || String(err);
        if (err?.rejected) {
          setFlow(null);
          toast("Cancelled.", true);
        } else {
          setFlow({ phase: "done", ok: false, symbol: p.symbol, message: /CloseAlreadyPending/.test(reason) ? "This position already has a resting exit order (one at a time)." : `Order failed: ${reason.slice(0, 110)}` });
          toast("Order failed.", true);
          scheduleClear();
        }
      } finally {
        busyRef.current = false;
      }
    },
    [account, wrongChain, getSigner, toast, onTraded, scheduleClear, addOrderId],
  );

  // The keeper FILL leg for a resting order, triggered once the static poll says it
  // would fill: send the real executeRequest. If price moved back between the poll and
  // the send, the engine reverts the gate again — classify that as STILL RESTING (never
  // strand the order) and let the poll resume.
  const fillOrder = useCallback(
    async (order) => {
      if (busyRef.current) return toast("A trade is already in progress.", true);
      if (!account) return toast("Connect a wallet first.", true);
      if (wrongChain) return toast("Switch to LiteForge (4441) first.", true);
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      const VERB = { open: "Opened", increase: "Increased", close: "Closed", decrease: "Decreased" };
      const crumb = { id: order.id, feed: order.feed, symbol: order.symbol, isLong: order.isLong, action: order.kindName, verb: VERB[order.kindName] || "Filled" };
      try {
        setFlow({ ...crumb, phase: "executing", message: `Order ready — confirm the fill for ${order.typeLabel} ${order.symbol}…` });
        const pm = pmWrite(getSigner());
        const { outcome } = await trade.executeRequest(pm, crumb.feed, crumb.id);
        if (outcome.kind === "filled") {
          setFlow({ phase: "done", ...crumb, ok: true, message: `${crumb.verb} ${crumb.symbol} ✓` });
          toast(`${crumb.verb} ${crumb.symbol} ✓`);
          setLastFill((s) => ({ n: s.n + 1, action: crumb.action, isLong: crumb.isLong, symbol: crumb.symbol }));
        } else {
          // Triggers REVERT rather than auto-cancel, so a non-fill outcome is unusual;
          // refresh and let the list reflect on-chain truth.
          setFlow({ phase: "done", ...crumb, ok: false, message: "Order did not fill — still resting." });
        }
        onTraded?.();
        scheduleClear();
      } catch (err) {
        const reason = err?.message || String(err);
        if (err?.rejected) {
          setFlow(null);
          toast("Fill dismissed — order still resting.", true);
        } else if (/TriggerNotMet|SlippageNotMet|TooEarly|PriceBeforeRequest/.test(reason)) {
          setFlow({ phase: "done", ...crumb, ok: false, message: "Price moved back before the fill landed — order still resting." });
          toast("Price moved back — still resting.", true);
          scheduleClear();
        } else {
          setFlow({ phase: "done", ...crumb, ok: false, message: `Fill reverted: ${reason.slice(0, 110)}` });
          toast("Fill reverted.", true);
          scheduleClear();
        }
        onTraded?.();
      } finally {
        busyRef.current = false;
      }
    },
    [account, wrongChain, getSigner, toast, onTraded, scheduleClear],
  );

  // Cancel a resting order and refund its escrow. Locked until CANCEL_DELAY (180s)
  // after the request — the UI gates the button on the same countdown, so a press
  // here should already be past the lock (TooEarlyToCancel is handled defensively).
  const cancelOrder = useCallback(
    async (order) => {
      if (busyRef.current) return toast("A trade is already in progress.", true);
      if (!account || wrongChain) return;
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        setFlow({ phase: "executing", id: order.id, symbol: order.symbol, isLong: order.isLong, message: "Cancelling order & refunding — confirm in your wallet…" });
        await trade.cancelRequest(pmWrite(getSigner()), order.id);
        setFlow({ phase: "done", ok: true, symbol: order.symbol, message: "Order cancelled — escrow refunded." });
        toast("Order cancelled — refunded.");
        onTraded?.();
        scheduleClear();
      } catch (err) {
        const reason = err?.message || String(err);
        if (err?.rejected) {
          setFlow(null);
          toast("Cancelled.", true);
        } else {
          setFlow({ phase: "done", ok: false, symbol: order.symbol, message: /TooEarlyToCancel/.test(reason) ? "Too early to cancel — the 180s refund lock hasn't elapsed." : `Cancel failed: ${reason.slice(0, 110)}` });
          toast("Cancel failed.", true);
          scheduleClear();
        }
      } finally {
        busyRef.current = false;
      }
    },
    [account, wrongChain, getSigner, toast, onTraded, scheduleClear],
  );

  // Hide the transient banner. Keeps any on-chain pending intact (it reappears as a
  // resume prompt on the next load); only clears the visual.
  const dismiss = useCallback(() => {
    clearTimeout(clearTimer.current);
    const crumb = loadPending(account);
    setFlow(
      crumb
        ? {
            phase: "watching",
            ...crumb,
            fallbackReady: nowSec() - (crumb.requestTs || 0) >= KEEPER_GRACE_SEC,
            message: "Waiting for the keeper — execute it yourself or cancel for a refund once the window opens.",
          }
        : null,
    );
  }, [account]);

  // "watching" is NOT in-progress: the wallet is idle, the keeper is working, and the
  // user may freely interact (or invoke the self-execute fallback).
  const inProgress = Boolean(flow && IN_PROGRESS.includes(flow.phase));

  return {
    flow,
    pending,
    lastFill,
    inProgress,
    submit,
    executeNow,
    cancelPending,
    dismiss,
    submitTriggerEntry,
    submitTriggerExit,
    fillOrder,
    cancelOrder,
    CANCEL_DELAY: trade.CANCEL_DELAY,
  };
}
