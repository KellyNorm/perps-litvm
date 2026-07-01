// LP cost-basis tracker for honest P&L. An ERC-4626 vault records NO per-holder cost
// basis on-chain — share price just drifts and `convertToAssets(shares)` is the *current*
// value, never what you paid. So to show gain/loss we record, in THIS browser, the net
// mUSD the wallet has deposited and the pLP shares those deposits minted. P&L is then
// current value − recorded basis (and it can be negative — traders winning in aggregate
// bleeds the pool). Values are stored as raw-integer decimal strings (assets 1e18, shares
// 1e24) and math is done in BigNumber to avoid float drift on real fund amounts.
//
// Honesty caveats surfaced by the reader (see useVault): this is browser-local, so a
// deposit made on another device, or pLP shares received by transfer, are NOT in the
// basis. The UI flags "partial" when the wallet holds more shares than we recorded, and
// scales the basis down when it holds fewer (shares moved out untracked).

import { ethers } from "ethers";
import { CHAIN_ID, ADDRESSES } from "../config.js";

const KEY = (account) =>
  `tachyonfi:lpbasis:${CHAIN_ID}:${(ADDRESSES.pool || "").toLowerCase()}:${(account || "").toLowerCase()}`;

function readRaw(account) {
  if (!account || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY(account));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p == null || p.assets == null || p.shares == null) return null;
    return p; // { assets: decString(1e18), shares: decString(1e24) }
  } catch {
    return null;
  }
}

function writeRaw(account, assets, shares) {
  if (!account || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY(account), JSON.stringify({ assets: assets.toString(), shares: shares.toString() }));
  } catch {
    /* storage unavailable — P&L just falls back to "current value only" */
  }
}

// Returns { assets, shares } as BigNumbers, or null if nothing recorded here.
export function loadBasis(account) {
  const p = readRaw(account);
  if (!p) return null;
  try {
    return { assets: ethers.BigNumber.from(p.assets), shares: ethers.BigNumber.from(p.shares) };
  } catch {
    return null;
  }
}

// Add a deposit: bump both recorded assets (mUSD in) and shares (pLP minted).
export function recordDeposit(account, assetsRaw, sharesRaw) {
  if (!account || assetsRaw == null || sharesRaw == null) return;
  const cur = loadBasis(account);
  const assets = (cur ? cur.assets : ethers.constants.Zero).add(assetsRaw);
  const shares = (cur ? cur.shares : ethers.constants.Zero).add(sharesRaw);
  writeRaw(account, assets, shares);
}

// Remove a withdrawal: burn `sharesBurnedRaw` shares and reduce the recorded basis
// PROPORTIONALLY (average-cost) so the remaining basis still matches the remaining
// shares. Fully exiting zeroes the record.
export function recordWithdraw(account, sharesBurnedRaw) {
  if (!account || sharesBurnedRaw == null) return;
  const cur = loadBasis(account);
  if (!cur || cur.shares.lte(0)) return;
  const burned = ethers.BigNumber.from(sharesBurnedRaw);
  if (burned.gte(cur.shares)) {
    writeRaw(account, ethers.constants.Zero, ethers.constants.Zero);
    return;
  }
  const remainShares = cur.shares.sub(burned);
  const remainAssets = cur.assets.mul(remainShares).div(cur.shares); // proportional basis
  writeRaw(account, remainAssets, remainShares);
}
