import { useEffect, useRef, useState } from "react";
import { musdWrite } from "../lib/contracts.js";
import { LITEFORGE_FAUCET_URL } from "../config.js";
import { countdown } from "../lib/format.js";

// Two-step faucet. Step 1: external link to LitVM's zkLTC gas faucet (new tab).
// Step 2: the only write in 11a — MockERC20.faucet() (10,000 mUSD, 8h cooldown),
// gated on faucetAvailableAt.
export default function FaucetModal({
  open,
  onClose,
  account,
  hasWallet,
  wrongChain,
  connecting,
  onConnect,
  onSwitch,
  faucetAvailableAt,
  getSigner,
  onClaimed,
  toast,
}) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearInterval(id);
    };
  }, [open, onClose]);

  if (!open) return null;

  const onCooldown = faucetAvailableAt != null && faucetAvailableAt > now;
  const cooldownSecs = onCooldown ? faucetAvailableAt - now : 0;

  async function mint() {
    setBusy(true);
    try {
      const signer = getSigner();
      const tx = await musdWrite(signer).faucet();
      await tx.wait();
      toast("Minted 10,000 mUSD ✓");
      onClaimed?.();
    } catch (e) {
      const reason = e?.reason || e?.data?.message || e?.message || String(e);
      toast(/cooldown/i.test(reason) ? "Faucet on cooldown" : "Mint failed: " + reason.slice(0, 60), true);
    } finally {
      setBusy(false);
    }
  }

  function step2() {
    if (!account) {
      return (
        <button className="act mint" onClick={onConnect} disabled={connecting}>
          {hasWallet ? (connecting ? "Connecting…" : "Connect wallet first") : "Install a wallet"}
        </button>
      );
    }
    if (wrongChain) {
      return (
        <button className="act mint" onClick={onSwitch}>
          Switch to LiteForge (4441)
        </button>
      );
    }
    if (onCooldown) {
      return <span className="cooldown">Claimed — next in {countdown(cooldownSecs)}</span>;
    }
    return (
      <button className="act mint" onClick={mint} disabled={busy}>
        {busy ? "Minting…" : "Mint 10,000 mUSD"}
      </button>
    );
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="faucetTitle">
        <div className="modal-head">
          <div className="modal-title">
            <img src="/logo.png" alt="" className="modal-logo" aria-hidden="true" />
            <h3 id="faucetTitle">Get test tokens</h3>
          </div>
          <button className="x" ref={closeRef} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-intro">
            TachyonFi runs on the LiteForge testnet. You need two things to trade: <b>zkLTC</b> to pay gas, and <b>mUSD</b> as
            collateral. They come from two different faucets.
          </p>
          <div className="step">
            <span className="num">1</span>
            <div className="body">
              <h4>Claim zkLTC for gas</h4>
              <p>The network's gas token, from LitVM's own faucet. Opens in a new tab.</p>
              <a className="act gas" href={LITEFORGE_FAUCET_URL} target="_blank" rel="noopener noreferrer">
                Open LiteForge faucet ↗
              </a>
            </div>
          </div>
          <div className="step">
            <span className="num">2</span>
            <div className="body">
              <h4>Mint mUSD collateral</h4>
              <p>Test stablecoin you trade with — minted straight from the mUSD contract to your wallet. 8h cooldown per address.</p>
              {step2()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
