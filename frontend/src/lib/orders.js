// Resting-order id tracking + on-chain read. Trigger orders live ON-CHAIN (escrow +
// the request/trigger structs); this module is only the breadcrumb to FIND them again
// and the reader that hydrates them. Two id sources, merged: (1) localStorage ids we
// stamped when WE placed the order this browser, and (2) a best-effort scan of the
// wallet's own Trigger*Requested events (recovers orders after a cache clear / other
// device). Mirrors pending.js's per-wallet keying.

import { ethers } from "ethers";
import { CHAIN_ID } from "../config.js";
import { assetToNum, priceToNum } from "./engine.js";
import { KIND, orderLabel } from "./triggers.js";
import { withRetry } from "./withRetry.js";

const KEY = (account) => `tachyonfi:orders:${CHAIN_ID}:${(account || "").toLowerCase()}`;

export function loadOrderIds(account) {
  if (!account || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY(account));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function addOrderId(account, id) {
  if (!account || id == null || typeof localStorage === "undefined") return;
  try {
    const set = new Set(loadOrderIds(account));
    set.add(String(id));
    localStorage.setItem(KEY(account), JSON.stringify([...set]));
  } catch {}
}

export function removeOrderId(account, id) {
  if (!account || id == null || typeof localStorage === "undefined") return;
  try {
    const set = new Set(loadOrderIds(account));
    set.delete(String(id));
    localStorage.setItem(KEY(account), JSON.stringify([...set]));
  } catch {}
}

// Best-effort recovery of resting-order ids from the wallet's own trigger events.
// `owner` is the 2nd indexed topic on every Trigger*Requested event. LitVM caps each
// eth_getLogs at <=1000 blocks, so we PAGE a recent window in 1000-block chunks working
// backwards (with a gentle inter-page delay), swallowing per-page failures — the
// localStorage ids are the dependable source; this only supplements them. Resting orders
// are recent, so we stop the walk the moment a page yields ids ("found what we need").
// When nothing turns up we still cap the walk (MAX_SCAN_PAGES) rather than pounding a
// possibly-degraded RPC every refresh.
const SCAN_PAGE_SIZE = 1_000; // LitVM's per-getLogs block cap
const MAX_SCAN_PAGES = 24; // bound the empty-scan walk (~24k blocks)
const SCAN_PAGE_DELAY_MS = 75; // gentle spacing between pages on a shared RPC
const TRIGGER_EVENTS = ["TriggerOpenRequested", "TriggerCloseRequested", "TriggerDecreaseRequested", "TriggerIncreaseRequested"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scanOrderIds(pm, account) {
  if (!account) return [];
  const latest = await withRetry(() => pm.provider.getBlockNumber());
  const floor = Math.max(0, latest - SCAN_PAGE_SIZE * MAX_SCAN_PAGES);
  const ids = new Set();
  let to = latest;
  for (let page = 0; page < MAX_SCAN_PAGES && to >= floor; page++) {
    const from = Math.max(floor, to - SCAN_PAGE_SIZE + 1); // inclusive [from, to], <=1000 blocks
    for (const ev of TRIGGER_EVENTS) {
      try {
        const logs = await pm.queryFilter(pm.filters[ev](null, account), from, to);
        for (const l of logs) ids.add(l.args.requestId.toString());
      } catch {
        // range too wide / event unsupported — ignore, localStorage still covers us.
      }
    }
    if (ids.size) break; // recovered this wallet's recent orders — stop paging
    to = from - 1;
    if (to >= floor) await sleep(SCAN_PAGE_DELAY_MS);
  }
  return [...ids];
}

// Hydrate one tracked id into a display order, or null if it is no longer a live
// resting trigger owned by `account` (filled, cancelled, expired, market order, or
// a different owner). triggers(id).triggerPrice == 0 means "not a resting trigger".
export async function readOrder(pm, id, account) {
  // A TRANSIENT transport failure must NOT look like "order gone" — that would untrack
  // a still-live order. withRetry rides out a hiccup; if it still fails it THROWS, and
  // the caller (useOrders.refresh) keeps the prior list rather than dropping the id.
  const [r, t] = await Promise.all([withRetry(() => pm.requests(id)), withRetry(() => pm.triggers(id))]);
  if (!r.active) return null;
  if (t.triggerPrice.isZero()) return null; // a plain market two-step request, not resting
  if (account && r.owner.toLowerCase() !== account.toLowerCase()) return null;

  const kind = Number(r.kind);
  const isLong = r.isLong;
  const triggerAbove = t.triggerAbove;
  const { label, kindClass, isStop } = orderLabel(kind, triggerAbove, isLong);

  // Locked escrow: a trigger-OPEN/INCREASE escrows collateral + fee; an EXIT escrows
  // the fee only (mirrors the contract's safeTransferFrom at request time).
  const fee = assetToNum(r.executionFee);
  const collateral = assetToNum(r.collateral);
  const locked = kindClass === "entry" ? collateral + fee : fee;

  // Size: entries carry collateral × leverage (notional); a Decrease overloads
  // `leverage` to carry closeBps; a full Close has no fixed notional (whole position).
  const lev = Number(r.leverage);
  let sizeUsd = null;
  let closeBps = null;
  if (kindClass === "entry") sizeUsd = collateral * lev;
  else if (kind === 2) closeBps = lev; // Decrease: leverage field == closeBps

  return {
    id: String(id),
    market: r.market,
    isLong,
    kind,
    kindName: KIND[kind],
    kindClass,
    isStop,
    typeLabel: label,
    triggerPrice: priceToNum(t.triggerPrice),
    triggerAbove,
    acceptablePrice: priceToNum(r.acceptablePrice),
    collateral,
    fee,
    locked,
    sizeUsd,
    closeBps,
    leverage: lev,
    requestTs: Number(r.requestTimestamp),
  };
}
