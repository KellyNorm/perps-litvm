import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { CHAIN_ID, LITEFORGE_CHAIN } from "../config.js";

// Persisted "the user explicitly disconnected in-app" flag. Injected wallets keep the
// site authorized after a disconnect (eth_accounts still returns the account), so
// without this the mount refresh would immediately re-hydrate and undo the disconnect.
// connect() clears it; refresh() and accountsChanged respect it until the user reconnects.
const DISCONNECT_KEY = "tachyon.walletDisconnected";
const isDisconnected = () => {
  try {
    return localStorage.getItem(DISCONNECT_KEY) === "1";
  } catch {
    return false;
  }
};
const setDisconnected = (v) => {
  try {
    if (v) localStorage.setItem(DISCONNECT_KEY, "1");
    else localStorage.removeItem(DISCONNECT_KEY);
  } catch {
    /* storage unavailable — in-memory state still updates */
  }
};

// Injected-wallet connection. The dashboard reads without this; connecting is only
// needed for positions, balances, and the faucet. Prompts a chain switch/add to
// LiteForge (4441) when the wallet is elsewhere.
export function useWallet() {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const hasWallet = Boolean(eth);
  const wrongChain = account != null && chainId != null && chainId !== CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!eth) return;
    // Honor an explicit in-app disconnect: stay disconnected until the user reconnects,
    // even though the wallet would still report the account via eth_accounts.
    if (isDisconnected()) {
      setAccount(null);
      return;
    }
    try {
      const accs = await eth.request({ method: "eth_accounts" });
      setAccount(accs && accs.length ? ethers.utils.getAddress(accs[0]) : null);
      const cid = await eth.request({ method: "eth_chainId" });
      setChainId(parseInt(cid, 16));
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, [eth]);

  useEffect(() => {
    refresh();
    if (!eth) return;
    const onAccounts = (accs) => {
      // Wallet-initiated disconnect (empty array) → reflect disconnected.
      if (!accs || accs.length === 0) {
        setAccount(null);
        return;
      }
      // A wallet-side account change while we're in the explicit-disconnect state is
      // ignored until the user clicks Connect again.
      if (isDisconnected()) return;
      setAccount(ethers.utils.getAddress(accs[0]));
    };
    const onChain = (cid) => setChainId(parseInt(cid, 16));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth, refresh]);

  const switchChain = useCallback(async () => {
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: LITEFORGE_CHAIN.chainId }] });
    } catch (e) {
      // 4902 = unknown chain → add it.
      if (e?.code === 4902 || /Unrecognized chain/i.test(e?.message || "")) {
        await eth.request({ method: "wallet_addEthereumChain", params: [LITEFORGE_CHAIN] });
      } else {
        setError(e?.message || String(e));
      }
    }
    await refresh();
  }, [eth, refresh]);

  const connect = useCallback(async () => {
    if (!eth) {
      setError("No injected wallet found. Install MetaMask to connect.");
      return;
    }
    setConnecting(true);
    setError(null);
    setDisconnected(false); // user is opting back in — clear the in-app disconnect flag
    try {
      await eth.request({ method: "eth_requestAccounts" });
      const cid = await eth.request({ method: "eth_chainId" });
      if (parseInt(cid, 16) !== CHAIN_ID) await switchChain();
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setConnecting(false);
    }
  }, [eth, refresh, switchChain]);

  // Injected wallets have no programmatic "disconnect" — the correct, standard behavior
  // is to clear the app's own connection state and remember that choice so the mount
  // refresh / accountsChanged don't silently re-connect. The signer is created on demand
  // (getSigner), so there's nothing cached to clear beyond account/chainId.
  const disconnect = useCallback(() => {
    setDisconnected(true);
    setAccount(null);
    setChainId(null);
    setError(null);
  }, []);

  // ethers signer bound to the injected provider (for faucet()).
  const getSigner = useCallback(() => {
    if (!eth) return null;
    return new ethers.providers.Web3Provider(eth).getSigner();
  }, [eth]);

  return { account, chainId, connecting, error, hasWallet, wrongChain, connect, disconnect, switchChain, getSigner, refresh };
}
