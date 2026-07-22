import { useCallback, useEffect, useMemo, useState } from "react";
import FlameBackdrop from "./FlameBackdrop.jsx";
import EyesMascot from "./EyesMascot.jsx";
import MarketCard from "./MarketCard.jsx";
import BetModal from "./BetModal.jsx";
import { usePredictionBoard } from "../../hooks/prediction/usePredictionBoard.js";
import { usePredictionActions } from "../../hooks/prediction/usePredictionActions.js";
import { useWallet } from "../../hooks/useWallet.js";
import { PHASE } from "../../lib/prediction/predictionConfig.js";
import { hasIcon } from "./CoinIcon.jsx";
import "../../styles/prediction.css";

// Root of the prediction view. Entirely self-contained: it shares nothing with the
// perps tree except the read-only RPC provider, the mUSD token helpers, and the wallet
// hook in lib/hooks. Nothing here imports a perps *component*, and no perps file imports
// this — the money path is wired independently of the perps trade path.

const FILTERS = [
  { key: "live", label: "Live" },
  { key: "open", label: "Open" },
  { key: "locked", label: "In play" },
  { key: "settled", label: "Settled" },
];

export default function PredictionApp() {
  // Self-sourced wallet — the board reads with no wallet; betting/claiming needs one.
  // A second useWallet() instance alongside perps' is harmless: both just read
  // window.ethereum and share the disconnect flag via localStorage.
  const { account, wrongChain, hasWallet, connect, connecting, getSigner } = useWallet();

  const { markets, error, loading, chainTime, refresh } = usePredictionBoard(account);
  const [filter, setFilter] = useState("live");

  // Lightweight toast, self-contained (the perps toast lives in the perps tree).
  const [toast, setToast] = useState({ msg: "", err: false, show: false });
  const showToast = useCallback((msg, err = false) => {
    setToast({ msg, err, show: true });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 2800);
  }, []);

  // A single 1s clock drives every countdown, rather than one timer per card. "now" is
  // anchored to CHAIN time (chainTime.ts, sampled at chainTime.at) and interpolated with
  // elapsed wall-clock between the 12s polls — so the displayed countdowns hit zero when
  // the keeper actually locks/settles, not when the browser clock (which leads chain
  // time on LitVM) says so. Before the first poll lands we fall back to wall-clock.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const tick = () => {
      if (chainTime) {
        setNow(Math.floor(chainTime.ts + (Date.now() - chainTime.at) / 1000));
      } else {
        setNow(Math.floor(Date.now() / 1000));
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [chainTime]);

  // Money-path actions (approve → bet, claim). onDone refreshes the board so pools, phase
  // and claimable reflect the tx immediately.
  const { flow, busy, placeBet, claim } = usePredictionActions({
    account,
    getSigner,
    wrongChain,
    chainNow: now,
    toast: showToast,
    onDone: refresh,
  });

  // Bet ticket state: which market + which side the user clicked.
  const [ticket, setTicket] = useState(null); // { market, side } | null
  const openBet = useCallback(
    (market, side) => {
      if (!account) {
        showToast("Connect a wallet to bet.", true);
        connect();
        return;
      }
      setTicket({ market, side });
    },
    [account, connect, showToast],
  );

  // Keep the open ticket's market row fresh as the board polls (pools/countdown move).
  const ticketMarket = useMemo(() => {
    if (!ticket) return null;
    return markets?.find((m) => m.id === ticket.market.id) || ticket.market;
  }, [ticket, markets]);

  const submitBet = useCallback(
    async (market, side, amount) => {
      const ok = await placeBet(market, side, amount);
      if (ok) setTicket(null);
    },
    [placeBet],
  );

  const claimingId = flow && flow.kind === "claim" && (flow.phase === "working" || busy) ? flow.marketId : null;

  const shown = useMemo(() => {
    if (!markets) return [];
    const by = {
      live: (m) => m.phase === PHASE.OPEN || m.phase === PHASE.LOCKED,
      open: (m) => m.phase === PHASE.OPEN,
      locked: (m) => m.phase === PHASE.LOCKED,
      settled: (m) => m.phase === PHASE.SETTLED || m.phase === PHASE.VOID,
    };
    return markets
      .filter(by[filter] || by.live)
      .sort((a, b) => (a.phase !== b.phase ? a.phase - b.phase : a.tLock - b.tLock));
  }, [markets, filter]);

  // Surfaces which live assets are still on the monogram fallback, so a missing logo
  // is visible during the preview instead of being quietly absorbed.
  const missingLogos = useMemo(() => {
    if (!markets) return [];
    return [...new Set(markets.map((m) => m.symbol))].filter((s) => !hasIcon(s)).sort();
  }, [markets]);

  return (
    <div className="pm-root">
      <FlameBackdrop />

      <div className="pm-content">
        <header className="pm-header">
          <img src="/logo.png" alt="TachyonFi" className="pm-logo" width={52} height={52} />
          <div className="pm-header-text">
            <div className="pm-title-row">
              <h1 className="pm-title">Predictions</h1>
              {/* Bigger so the steady cursor-tracking reads clearly; no idle bounce. */}
              <EyesMascot size={56} mode="track" />
              <span className="pm-pill pm-pill-testnet">TESTNET · LitVM</span>
            </div>
            <p className="pm-sub">
              Binary price markets. Pick a side, split the pool, settles automatically. Test tokens only (mUSD) — no
              real money.
            </p>
          </div>

          <div className="pm-wallet">
            {account ? (
              <span className="pm-acct mono" title={account}>
                {wrongChain ? "WRONG NETWORK" : `${account.slice(0, 6)}…${account.slice(-4)}`}
              </span>
            ) : (
              <button type="button" className="pm-connect" onClick={connect} disabled={connecting || !hasWallet}>
                {!hasWallet ? "No wallet" : connecting ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </header>

        <div className="pm-boardbar">
          <div className="pm-lbl mono">01 · PREDICTIONS BOARD</div>
          <div className="pm-filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`pm-tab ${filter === f.key ? "is-on" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="pm-note pm-note-warn">
            Board read degraded — showing last known state. ({error})
          </div>
        )}

        {loading && <div className="pm-note">Reading the board from chain 4441…</div>}

        {!loading && !shown.length && <div className="pm-note">No markets in this view right now.</div>}

        <div className="pm-grid">
          {shown.map((m) => (
            <MarketCard
              key={m.id}
              market={m}
              now={now}
              onBet={openBet}
              onClaim={claim}
              pending={claimingId === m.id}
            />
          ))}
        </div>

        {missingLogos.length > 0 && (
          <div className="pm-note pm-note-dim">
            Monogram fallback in use for: <strong>{missingLogos.join(", ")}</strong> — drop{" "}
            <code>{missingLogos[0].toLowerCase()}.svg</code> into <code>src/assets/coins/</code> to replace.
          </div>
        )}
      </div>

      {ticketMarket && (
        <BetModal
          market={ticketMarket}
          initialSide={ticket.side}
          account={account}
          chainNow={now}
          flow={flow}
          busy={busy}
          onSubmit={submitBet}
          onClose={() => setTicket(null)}
        />
      )}

      <div className={"pm-toast" + (toast.show ? " show" : "") + (toast.err ? " err" : "")}>{toast.msg}</div>
    </div>
  );
}
