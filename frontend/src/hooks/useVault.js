import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { pmRead, poolRead, musdRead } from "../lib/contracts.js";
import { assetToNum } from "../lib/engine.js";
import { withRetry } from "../lib/withRetry.js";
import { addressesConfigured } from "../config.js";

const POLL_MS = 15_000;

// LiquidityPool (ERC-4626) read surface: share price (via convertToAssets, decimals-
// correct), utilization (reserved / pool balance), and TVL. Plus optional connected-LP
// deposit. Shares are 24-dec (asset 18 + _DECIMALS_OFFSET 6) — never format them as 18.
export function useVault(account) {
  const [data, setData] = useState(null); // {totalAssets, totalSupply, sharePrice, utilization, tvl, reserved, balance}
  const [yourDeposit, setYourDeposit] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);

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
          const assetsBn = await withRetry(() => pool.convertToAssets(sharesBn));
          deposit = { shares: sharesToNum(sharesBn), assets: assetToNum(assetsBn) };
        }
        if (cancelled) return;
        setData({ totalAssets, totalSupply, sharePrice, utilization, tvl: totalAssets, reserved, balance });
        setYourDeposit(deposit);
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
  }, [account]);

  return { data, yourDeposit, error };
}
