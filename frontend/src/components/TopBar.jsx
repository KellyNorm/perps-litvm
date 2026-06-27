import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { readProvider } from "../lib/contracts.js";
import { CHAIN_ID } from "../config.js";
import { shortAddr } from "../lib/format.js";

function FlameMark() {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30" fill="none">
        <defs>
          <linearGradient id="tfg" x1="0" y1="0" x2="32" y2="32">
            <stop offset="0" stopColor="#FFE7CF" />
            <stop offset=".55" stopColor="#FF8A4C" />
            <stop offset="1" stopColor="#E5402A" />
          </linearGradient>
        </defs>
        <path d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" stroke="#27313F" strokeWidth="1.4" fill="#0E131B" />
        <path d="M16 8 L11 17 H15 L13 24 L21 14 H16 L19 8 Z" fill="url(#tfg)" />
      </svg>
    </span>
  );
}

export default function TopBar({ account, wrongChain, connecting, hasWallet, onConnect, onDisconnect, onSwitch, onFaucet }) {
  const [gas, setGas] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const gp = await readProvider().getGasPrice();
        if (!cancelled) setGas(parseFloat(ethers.utils.formatUnits(gp, "gwei")));
      } catch {
        /* leave null */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="topbar">
      <div className="brand">
        <FlameMark />
        <span>
          <div className="name">
            TACHYON<b>FI</b>
          </div>
          <div className="sub">Perps · LitVM</div>
        </span>
      </div>
      <span className="net-badge">
        <span className={"dot" + (wrongChain ? " warn" : "")}></span> LiteForge{" "}
        <span className="chain mono">· {CHAIN_ID}</span>
      </span>
      <div className="spacer"></div>
      <span className="gas">
        zkLTC gas <b>{gas == null ? "—" : (gas < 0.001 ? gas.toExponential(1) : gas.toFixed(3)) + " gwei"}</b>
      </span>
      <button className="btn faucet" onClick={onFaucet}>
        Get test tokens
      </button>
      {wrongChain ? (
        <button className="btn warnchain" onClick={onSwitch}>
          Switch to 4441
        </button>
      ) : account ? (
        <button className="btn wallet-pill" onClick={onDisconnect} title={`${account} — click to disconnect`}>
          <span className="mono">{shortAddr(account)}</span>
          <span className="disconnect-x" aria-hidden="true"> ✕</span>
        </button>
      ) : (
        <button className="btn connect" onClick={onConnect} disabled={connecting}>
          {connecting ? "Connecting…" : hasWallet ? "Connect wallet" : "Install wallet"}
        </button>
      )}
    </div>
  );
}
