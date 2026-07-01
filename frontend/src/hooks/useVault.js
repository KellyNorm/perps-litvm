import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { pmRead, poolRead, musdRead } from "../lib/contracts.js";
import { assetToNum } from "../lib/engine.js";
import { withRetry } from "../lib/withRetry.js";
import { addressesConfigured } from "../config.js";
import { loadBasis } from "../lib/lpBasis.js";

const POLL_MS = 15_000;

// LiquidityPool (ERC-4626) read surface: share price (via convertToAssets, decimals-
// correct), utilization (reserved / pool balance), and TVL. Plus, when a wallet is
// connected, its LP position: pLP shares, current mUSD value (convertToAssets), the
// instantly-withdrawable amount (maxWithdraw = free/unreserved liquidity), and P&L vs the
// locally-recorded cost basis. Shares are 24-dec (asset 18 + _DECIMALS_OFFSET 6) — never
// format them as 18.
export function useVault(account) {
  const [data, setData] = useState(null); // {totalAssets, totalSupply, sharePrice, utilization, tvl, reserved, balance}
  const [yourDeposit, setYourDeposit] = useState(null);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const timer = useRef(null);

  // Manual re-poll (e.g. right after a deposit/withdraw) without waiting for the 15s tick.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!addressesConfigured()) return;
    let cancelled = false;
    const pool = poolRead();
    const pm = pmRead();
    const musd = musdRead();

    // Shares are 24-dec on this ERC-4626 pool (asset 18 + _DECIMALS_OFFSET 6), NOT 18
    // like the asset. Fetched once (constant) and used to format every share quantity.
    // assetToNum (18-dec) is for ASSETS only.
    let shareDecimals = null;
    const sharesToNum = (bn) => parseFloat(ethers.utils.formatUnits(bn, shareDecimals));

    async function poll() {
      try {
        if (shareDecimals == null) shareDecimals = await withRetry(() => pool.decimals());
        // 1.0 share in raw units → its asset value is the decimals-correct share price
        // straight from the vault math (handles an empty pool via virtual shares).
        const oneShare = ethers.BigNumber.from(10).pow(shareDecimals);
        const [totalAssetsBn, totalSupplyBn, reservedBn, balanceBn, assetPerShareBn] = await Promise.all([
          withRetry(() => pool.totalAssets()),
          withRetry(() => pool.totalSupply()),
          withRetry(() => pm.totalReserved()),
          withRetry(() => musd.balanceOf(pool.address)),
          withRetry(() => pool.convertToAssets(oneShare)),
        ]);
        const totalAssets = assetToNum(totalAssetsBn);
        const totalSupply = sharesToNum(totalSupplyBn); // 24-dec shares
        const reserved = assetToNum(reservedBn);
        const balance = assetToNum(balanceBn);
        const sharePrice = assetToNum(assetPerShareBn); // assets (18-dec) per 1.0 share
        const utilization = balance > 0 ? reserved / balance : 0;

        let deposit = null;
        if (account) {
          const sharesBn = await withRetry(() => pool.balanceOf(account));
          const [assetsBn, maxWithdrawBn] = await Promise.all([
            withRetry(() => pool.convertToAssets(sharesBn)),
            withRetry(() => pool.maxWithdraw(account)),
          ]);
          deposit = buildDeposit({ account, sharesBn, assetsBn, maxWithdrawBn, sharesToNum });
        }
        if (cancelled) return;
        setData({ totalAssets, totalSupply, sharePrice, utilization, tvl: totalAssets, reserved, balance });
        setYourDeposit(deposit);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    }

    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer.current);
    };
  }, [account, nonce]);

  return { data, yourDeposit, error, refresh };
}

// Reconcile the wallet's live pLP shares against the browser-local cost basis to produce
// an honest P&L. `tracked`:
//   'none'    — holds no recorded basis (fresh wallet, or basis on another device) → P&L
//               can't be shown; only current value is meaningful.
//   'full'    — recorded shares cover (>=) the held shares; basis is scaled to the held
//               shares (handles shares moved out untracked) and P&L is exact.
//   'partial' — holds MORE shares than recorded (deposited elsewhere / received a
//               transfer); P&L is computed on the tracked slice only and flagged.
function buildDeposit({ account, sharesBn, assetsBn, maxWithdrawBn, sharesToNum }) {
  const shares = sharesToNum(sharesBn);
  const value = assetToNum(assetsBn); // current mUSD value of all held shares
  const maxWithdrawable = assetToNum(maxWithdrawBn); // instantly withdrawable (free liq)
  const base = { shares, sharesRaw: sharesBn, value, maxWithdrawable, deposited: null, earnings: null, earningsPct: null, tracked: "none" };

  if (sharesBn.lte(0)) return base;
  const basis = loadBasis(account);
  if (!basis || basis.shares.lte(0)) return base;

  if (sharesBn.lte(basis.shares)) {
    // Fully tracked. Scale recorded basis down to the shares actually held now.
    const effBasisRaw = basis.assets.mul(sharesBn).div(basis.shares);
    const deposited = assetToNum(effBasisRaw);
    const earnings = value - deposited;
    return { ...base, deposited, earnings, earningsPct: deposited > 0 ? earnings / deposited : null, tracked: "full" };
  }
  // Partial: basis only covers `basis.shares` of the held shares.
  const trackedValueRaw = assetsBn.mul(basis.shares).div(sharesBn);
  const deposited = assetToNum(basis.assets);
  const earnings = assetToNum(trackedValueRaw) - deposited;
  return { ...base, deposited, earnings, earningsPct: deposited > 0 ? earnings / deposited : null, tracked: "partial" };
}
