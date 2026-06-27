import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { readProvider } from "../lib/contracts.js";
import { CHAIN_ID } from "../config.js";
import { shortAddr } from "../lib/format.js";

function FlameMark() {
  return (
    <span className="mark" aria-hidden="true">
      <img src="/logo.png" alt="" className="brand-logo" width="34" height="34" />
    </span>
  );
}

export default function TopBar({ account, wrongChain, connecting, hasWallet, onConnect, onDisconnect, onSwitch, onFaucet, onHome }) {
  const [gas, setGas] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Esc closes the mobile/tablet menu (touch + keyboard accessible).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="topbar">
      <div
        className="brand"
        onClick={onHome}
        role="button"
        tabIndex={0}
        aria-label="Go to dashboard"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onHome?.();
          }
        }}
      >
        <FlameMark />
        <span>
          <div className="name">
            TACHYON<b>FI</b>
          </div>
          <div className="sub">Perps · LitVM</div>
        </span>
      </div>

      <div className="spacer"></div>

      {/* Secondary / nav items — inline on desktop, collapse into the hamburger ≤1024px.
          The core trade form is NOT here; it lives in OrderTicket. */}
      <nav id="topbar-menu" className={"topbar-menu" + (menuOpen ? " open" : "")}>
        <span className="net-badge">
          <span className={"dot" + (wrongChain ? " warn" : "")}></span> LiteForge{" "}
          <span className="chain mono">· {CHAIN_ID}</span>
        </span>
        <span className="gas">
          zkLTC gas <b>{gas == null ? "—" : (gas < 0.001 ? gas.toExponential(1) : gas.toFixed(3)) + " gwei"}</b>
        </span>
        <button
          className="btn faucet"
          onClick={() => {
            onFaucet();
            setMenuOpen(false);
          }}
        >
          Get test tokens
        </button>
      </nav>

      {wrongChain ? (
        <button className="btn warnchain" onClick={onSwitch}>
          Switch to 4441
        </button>
      ) : account ? (
        <button className="btn wallet-pill" onClick={onDisconnect} title={`${account} — click to disconnect`}>
          <span className="mono">{shortAddr(account)}</span>
          <span className="disconnect-x" aria-hidden="true">✕</span>
        </button>
      ) : (
        <button className="btn connect" onClick={onConnect} disabled={connecting}>
          {connecting ? "Connecting…" : hasWallet ? "Connect wallet" : "Install wallet"}
        </button>
      )}

      <button
        className="hamburger"
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        aria-expanded={menuOpen}
        aria-controls="topbar-menu"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="bar"></span>
        <span className="bar"></span>
        <span className="bar"></span>
      </button>

      {menuOpen && <div className="menu-overlay" aria-hidden="true" onClick={() => setMenuOpen(false)}></div>}
    </div>
  );
}
