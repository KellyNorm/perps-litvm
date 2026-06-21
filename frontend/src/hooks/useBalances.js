import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { musdRead, readProvider } from "../lib/contracts.js";
import { assetToNum } from "../lib/engine.js";
import { withRetry } from "../lib/withRetry.js";

const POLL_MS = 15_000;

// Connected-wallet balances + faucet state: mUSD (MockERC20.balanceOf), native
// zkLTC (provider.getBalance), and faucetAvailableAt for the cooldown UI.
export function useBalances(account) {
  const [musd, setMusd] = useState(null); // number | null
  const [native, setNative] = useState(null); // number | null
  const [faucetAvailableAt, setFaucetAvailableAt] = useState(null); // unix secs (0 = claimable)
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const poll = useCallback(async () => {
    if (!account) return;
    try {
      const token = musdRead();
      const [balBn, natBn, availBn] = await Promise.all([
        withRetry(() => token.balanceOf(account)),
        withRetry(() => readProvider().getBalance(account)),
        withRetry(() => token.faucetAvailableAt(account)),
      ]);
      setMusd(assetToNum(balBn));
      setNative(parseFloat(ethers.utils.formatEther(natBn)));
      setFaucetAvailableAt(availBn.toNumber());
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, [account]);

  useEffect(() => {
    if (!account) {
      setMusd(null);
      setNative(null);
      setFaucetAvailableAt(null);
      return;
    }
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timer.current);
  }, [account, poll]);

  return { musd, native, faucetAvailableAt, error, refresh: poll };
}
