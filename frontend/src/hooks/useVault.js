import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { pmRead, poolRead, musdRead } from "../lib/contracts.js";
import { assetToNum } from "../lib/engine.js";
import { withRetry } from "../lib/withRetry.js";
import { addressesConfigured } from "../config.js";

const POLL_MS = 15_000;

// LiquidityPool (ERC-4626) read surface: share price (totalAssets/totalSupply),
// utilization (reserved / pool balance), and TVL. Plus optional connected-LP deposit.
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

    async function poll() {
      try {
        const [totalAssetsBn, totalSupplyBn, reservedBn, balanceBn] = await Promise.all([
          withRetry(() => pool.totalAssets()),
          withRetry(() => pool.totalSupply()),
          withRetry(() => pm.totalReserved()),
          withRetry(() => musd.balanceOf(pool.address)),
        ]);
        const totalAssets = assetToNum(totalAssetsBn);
        const totalSupply = assetToNum(totalSupplyBn);
        const reserved = assetToNum(reservedBn);
        const balance = assetToNum(balanceBn);
        const sharePrice = totalSupply > 0 ? totalAssets / totalSupply : 1;
        const utilization = balance > 0 ? reserved / balance : 0;

        let deposit = null;
        if (account) {
          const sharesBn = await withRetry(() => pool.balanceOf(account));
          const assetsBn = await withRetry(() => pool.convertToAssets(sharesBn));
          deposit = { shares: assetToNum(sharesBn), assets: assetToNum(assetsBn) };
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
