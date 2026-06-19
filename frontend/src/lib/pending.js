// Pending two-step requests persisted to localStorage, keyed by wallet so a refresh
// (or a wallet/abandon mid-flow) can resume the keeper leg. We persist the request
// id + the on-chain requestTs (needed to recompute the freshness floor on resume)
// plus enough labelling to render an honest resume banner. Collateral/fee escrow
// lives on-chain; this is only the breadcrumb to find it again.

import { CHAIN_ID } from "../config.js";

const KEY = (account) => `tachyonfi:pending:${CHAIN_ID}:${(account || "").toLowerCase()}`;

// One pending request at a time per wallet (the contract serializes a position's
// close/decrease via the closePending mutex; an open blocks a second open). Storing
// a single record keeps the resume UX unambiguous.
export function loadPending(account) {
  if (!account || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY(account));
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.id != null ? p : null;
  } catch {
    return null;
  }
}

export function savePending(account, record) {
  if (!account || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY(account), JSON.stringify(record));
  } catch {}
}

export function clearPending(account) {
  if (!account || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY(account));
  } catch {}
}
