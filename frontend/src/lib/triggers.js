// Resting-order (11c) primitives layered on the 11b two-step machinery. NO contract
// changes: a trigger order is an ordinary request* PLUS a stored (triggerPrice,
// triggerAbove) gate, and its fill is the SAME executeRequest — the engine's gate
// simply REVERTS TriggerNotMet/SlippageNotMet until the mark crosses, so the request
// rests (stays active) instead of cancelling. See PositionManager.executeRequest.

import { ethers } from "ethers";
import { pmRead, readProvider } from "./contracts.js";
import { wrapForExecute } from "./redstone.js";
import { revertReason, decodeRawError } from "./revert.js";

// THE TRIGGER PRIMITIVE — one rule encodes limit/stop opens AND TP/SL closes for
// long and short. The contract stores ONE (triggerPrice, triggerAbove); the gate is
//   triggerAbove ? mark >= triggerPrice : mark <= triggerPrice.
// Derive triggerAbove purely from trigger-vs-mark (NOT from the Limit/Stop/TP/SL
// label, which is UI-only): a trigger at/above the current mark fires on the way up;
// at/below fires on the way down.
//   limit-long & SL-long sit BELOW mark -> above=false
//   stop-long  & TP-long sit ABOVE mark -> above=true   (shorts mirror)
export function triggerAboveFor(triggerPrice, mark) {
  return triggerPrice >= mark;
}

// RequestKind (PositionManager.sol enum): Open, Close, Decrease, Increase.
export const KIND = { 0: "open", 1: "close", 2: "decrease", 3: "increase" };
export const KIND_OPEN = 0;
export const KIND_CLOSE = 1;
export const KIND_DECREASE = 2;
export const KIND_INCREASE = 3;

// Is this a STOP-type order (stop-entry / stop-loss) rather than a LIMIT/TP one?
// A stop fires on an ADVERSE move (price running away from you), so when the gate
// opens the fill may be far from the trigger — it needs a permissive acceptablePrice.
//   Entry (Open/Increase): stop  <=> triggerAbove === isLong
//     long-stop sits above (above=true, isLong=true), short-stop sits below.
//   Exit  (Close/Decrease): stop-loss <=> triggerAbove !== isLong
//     long SL sits below (above=false, isLong=true), short SL sits above.
export function isEntryKind(kind) {
  return kind === KIND_OPEN || kind === KIND_INCREASE;
}
export function isStopOrder(kind, triggerAbove, isLong) {
  return isEntryKind(kind) ? triggerAbove === isLong : triggerAbove !== isLong;
}

// Human label for the orders table, derived ONLY from (kind, triggerAbove, isLong).
// Returns { label, kindClass, isStop } — entries read Limit/Stop, exits Take-profit/
// Stop-loss.
export function orderLabel(kind, triggerAbove, isLong) {
  const stop = isStopOrder(kind, triggerAbove, isLong);
  if (isEntryKind(kind)) {
    const verb = kind === KIND_INCREASE ? "add" : "entry";
    return { label: stop ? `Stop ${verb}` : `Limit ${verb}`, kindClass: "entry", isStop: stop };
  }
  return { label: stop ? "Stop-loss" : "Take-profit", kindClass: "exit", isStop: stop };
}

// READ-ONLY "is this order fillable right now?" check — the browser keeper's heartbeat.
// The RedStone wrapper injects the signed payload only on populateTransaction / send,
// NOT on .callStatic, so we build the payload-bearing tx and replay it through a raw
// provider.call (NO send, NO signature, no gas, no wallet prompt). This Nitro node
// returns revert bytes as a SUCCESSFUL eth_call result, and executeRequest returns
// nothing on a fill — so empty return data == WOULD FILL, non-empty == the gate's
// revert (TriggerNotMet / SlippageNotMet while resting). Ported from the smoke's
// static-trigger probe (scripts/smoke-perps.mjs).
export async function staticFillable(feed, id, from) {
  const iface = pmRead().interface;
  const wrapped = wrapForExecute(pmRead(), feed);
  const tx = await wrapped.populateTransaction.executeRequest(ethers.BigNumber.from(String(id)));
  try {
    const raw = await readProvider().call({ ...tx, from });
    if (!raw || raw === "0x") return { fillable: true, reason: null };
    return { fillable: false, reason: decodeRawError(iface, raw) || `raw ${raw.slice(0, 10)}` };
  } catch (err) {
    return { fillable: false, reason: revertReason(iface, err) };
  }
}

// A reason that just means "still resting, try later" (the gate, or a transient
// freshness window) vs an unexpected revert worth surfacing.
export function isRestingReason(reason) {
  return /TriggerNotMet|SlippageNotMet|TooEarlyToExecute|PriceBeforeRequest/.test(reason || "");
}
