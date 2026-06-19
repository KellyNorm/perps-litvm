// Two-step market-order orchestration for the 11b trade loop. Pure helpers ported
// 1:1 from scripts/smoke-perps.mjs — the ONLY change is the contracts are bound to
// the browser signer (see hooks/useTrade.js), never a private key. The connected
// wallet plays trader AND keeper: it pays the EXECUTION_FEE at request and reclaims
// it at execute.
//
// Money-path note: EXECUTION_FEE is paid in mUSD (asset), pulled by the contract via
// transferFrom alongside collateral — NOT native. So the mUSD allowance to the
// PositionManager must cover collateral + fee (open/increase) or just the fee
// (close/decrease). This mirrors the contract's safeTransferFrom exactly.

import { ethers } from "ethers";
import { marketKey } from "./marketKey.js";
import { readProvider } from "./contracts.js";
import { payloadTimestampSec, fetchMark, wrapForExecute } from "./redstone.js";
import { revertReason, isUserRejection } from "./revert.js";

// Contract constants (must match PositionManager.sol).
export const EXECUTION_FEE = ethers.utils.parseUnits("0.5", 18); // EXECUTION_FEE = 0.5e18
export const MIN_EXECUTION_DELAY = 3; // seconds; fill floor
export const CANCEL_DELAY = 180; // seconds; owner-reclaim window
export const SLIPPAGE_OPTIONS = [0.001, 0.005, 0.01]; // 0.1% / 0.5% / 1%

// action → behaviour table. isOpenSide drives the slippage direction; needsCollateral
// drives the approval amount; verb is the success toast verb (matches the button).
export const ACTIONS = {
  open: { isOpenSide: true, needsCollateral: true, verb: "Opened" },
  increase: { isOpenSide: true, needsCollateral: true, verb: "Increased" },
  close: { isOpenSide: false, needsCollateral: false, verb: "Closed" },
  decrease: { isOpenSide: false, needsCollateral: false, verb: "Decreased" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// number/string → 1e18 BigNumber, robust to JS float repr (avoids "1e+21" forms).
export function toAsset(n) {
  if (n == null) return ethers.constants.Zero;
  let s = typeof n === "string" ? n.trim() : Number(n).toFixed(18);
  s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0";
  return ethers.utils.parseUnits(s, 18);
}

// Acceptable (worst-accepted) fill price, 1e8-scaled, off the live mark. The bound is
// directional per the contract's _withinSlippage:
//   Open/Increase long  -> fill <= acceptable  (buy not above ceiling) -> mark*(1+slip)
//   Open/Increase short -> fill >= acceptable  (buy not below floor)   -> mark*(1-slip)
//   Close/Decrease long -> fill >= acceptable  (sell not below floor)  -> mark*(1-slip)
//   Close/Decrease short-> fill <= acceptable  (sell not above ceiling)-> mark*(1+slip)
// i.e. add slippage when (isOpenSide === isLong), else subtract.
export function acceptablePrice1e8(markFloat, slipFrac, isOpenSide, isLong) {
  const mark1e8 = ethers.BigNumber.from(Math.round(markFloat * 1e8).toString());
  const up = isOpenSide === isLong;
  const bps = Math.round(slipFrac * 10_000);
  const num = up ? 10_000 + bps : 10_000 - bps;
  return mark1e8.mul(num).div(10_000);
}

// Ensure the wallet has approved at least `needed` mUSD to the PositionManager;
// max-approve (like the smoke) if short. onApproving() fires only when a prompt is
// actually needed, so the UI can surface the extra wallet step.
export async function ensureAllowance(musd, owner, spender, needed, onApproving) {
  const current = await musd.allowance(owner, spender);
  if (current.gte(needed)) return false;
  onApproving?.();
  const tx = await musd.approve(spender, ethers.constants.MaxUint256);
  await tx.wait();
  return true;
}

// Build the request* call for an action against a signer-bound PositionManager.
// `params` carries the already-scaled values (collateral/addCollateral as 1e18,
// leverage as a bare integer, acceptablePrice as 1e8, closeBps as plain bps).
export function sendRequestTx(pm, action, market, isLong, params) {
  const { collateral, leverage, acceptablePrice, closeBps } = params;
  switch (action) {
    case "open":
      return pm.requestOpen(market, isLong, collateral, leverage, acceptablePrice);
    case "increase":
      return pm.requestIncrease(market, isLong, collateral, leverage, acceptablePrice);
    case "close":
      return pm.requestClose(market, isLong, acceptablePrice);
    case "decrease":
      return pm.requestDecrease(market, isLong, closeBps, acceptablePrice);
    default:
      throw new Error(`unknown action ${action}`);
  }
}

// Capture the request id from the receipt by parsing the emitted *Requested event
// (more robust than a pre-read of nextRequestId under concurrent senders, and still
// the exact id the request got). Falls back to a pre-read value if provided.
export function findRequestId(pm, rcpt, fallbackId) {
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== pm.address.toLowerCase()) continue;
    let parsed;
    try {
      parsed = pm.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name.endsWith("Requested")) return parsed.args.requestId;
  }
  if (fallbackId != null) return fallbackId;
  throw new Error(`no *Requested event in tx ${rcpt.transactionHash}`);
}

// Send a request* tx and return { id, requestTs }. requestTs is the block timestamp
// the request was queued at — the freshness floor is requestTs + MIN_EXECUTION_DELAY.
export async function sendRequest(pm, action, market, isLong, params) {
  const fallback = await pm.nextRequestId().catch(() => null);
  const rcpt = await (await sendRequestTx(pm, action, market, isLong, params)).wait();
  const id = findRequestId(pm, rcpt, fallback);
  const requestTs = (await readProvider().getBlock(rcpt.blockNumber)).timestamp;
  return { id, requestTs, rcpt };
}

// Poll the demo feed until a payload exists that the contract's freshness guard will
// accept for a request queued at `requestTs`: a package stamped >= floor (else
// PriceBeforeRequest) AND the chain clock past the same floor (else TooEarlyToExecute).
// Identical to the smoke's waitForFreshPayload; onTick reports progress to the UI.
export async function waitForFreshPayload(feed, requestTs, onTick) {
  const floor = requestTs + MIN_EXECUTION_DELAY;
  const TIMEOUT_MS = 180_000;
  const POLL_MS = 4_000;
  const start = Date.now();
  for (;;) {
    let pkgTs = 0;
    try {
      pkgTs = await payloadTimestampSec(feed);
    } catch {}
    const blockTs = (await readProvider().getBlock("latest")).timestamp;
    onTick?.({ pkgTs, blockTs, floor });
    if (pkgTs >= floor && blockTs >= floor) return;
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error(
        `timed out waiting for a fresh ${feed} payload stamped >= ${floor} (last pkg ts ${pkgTs}); the demo feed updates slowly — retry`,
      );
    }
    await sleep(POLL_MS);
  }
}

// Classify an executeRequest receipt into an honest outcome. RequestExecuted is
// emitted ONLY on a fill; RequestCancelled(slippage=true) is the market-order
// auto-cancel + refund. (Resting-trigger reverts never reach here — they throw and
// are handled by the caller; triggers are 11c anyway.)
export function classifyExecute(pm, rcpt) {
  let filled = null;
  let cancelled = null;
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== pm.address.toLowerCase()) continue;
    let parsed;
    try {
      parsed = pm.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name === "RequestExecuted") filled = parsed.args;
    if (parsed.name === "RequestCancelled") cancelled = parsed.args;
  }
  if (filled) return { kind: "filled", executionPrice: filled.executionPrice };
  if (cancelled && cancelled.slippage) return { kind: "slippage" };
  return { kind: "unknown" };
}

// The keeper leg: append a fresh signed payload and call executeRequest. Returns the
// classified outcome. On revert, throws with a decoded reason (the caller keeps the
// pending breadcrumb so the user can resume or, after CANCEL_DELAY, cancel+refund).
export async function executeRequest(pmSigner, feed, id) {
  const wrapped = wrapForExecute(pmSigner, feed);
  let rcpt;
  try {
    rcpt = await (await wrapped.executeRequest(id)).wait();
  } catch (err) {
    const e = new Error(revertReason(pmSigner.interface, err));
    e.rejected = isUserRejection(err);
    e.cause = err;
    throw e;
  }
  return { outcome: classifyExecute(pmSigner, rcpt), rcpt };
}

// Owner-reclaim a stale/abandoned request after CANCEL_DELAY (manual fallback).
export async function cancelRequest(pmSigner, id) {
  try {
    return await (await pmSigner.cancelRequest(id)).wait();
  } catch (err) {
    const e = new Error(revertReason(pmSigner.interface, err));
    e.rejected = isUserRejection(err);
    e.cause = err;
    throw e;
  }
}

// Live mark (float) for a feed at submit time — used to derive acceptablePrice from
// the freshest price, not the polled display mark.
export async function freshMark(feed) {
  return (await fetchMark(feed)).price;
}

export { marketKey };
