import { useEffect, useMemo, useState } from "react";
import FlameBackdrop from "./FlameBackdrop.jsx";
import EyesMascot from "./EyesMascot.jsx";
import MarketCard from "./MarketCard.jsx";
import { usePredictionBoard } from "../../hooks/prediction/usePredictionBoard.js";
import { PHASE } from "../../lib/prediction/predictionConfig.js";
import { hasIcon } from "./CoinIcon.jsx";
import "../../styles/prediction.css";

// Root of the prediction view. Entirely self-contained: it shares nothing with the
// perps tree except the read-only RPC provider in lib/contracts.js. Nothing here
// imports a perps component, and no perps file imports this.

const FILTERS = [
  { key: "live", label: "Live" },
  { key: "open", label: "Open" },
  { key: "locked", label: "In play" },
  { key: "settled", label: "Settled" },
];

export default function PredictionApp({ account }) {
  const { markets, error, loading } = usePredictionBoard(account);
  const [filter, setFilter] = useState("live");

  // PREVIEW ONLY — lets you compare the two mascot behaviours side by side. Drop this
  // toggle (and the state) once you have picked one.
  const [mascotMode, setMascotMode] = useState("idle");

  // A single 1s clock drives every countdown, rather than one timer per card.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

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
              <EyesMascot size={30} mode={mascotMode} />
              <span className="pm-pill pm-pill-testnet">TESTNET · LitVM</span>
            </div>
            <p className="pm-sub">
              Binary price markets. Pick a side, split the pool, settles automatically. Test tokens only (mUSD) — no
              real money.
            </p>
          </div>

          <div className="pm-mascot-toggle" role="group" aria-label="Mascot animation preview">
            <span className="pm-toggle-k mono">EYES</span>
            {["idle", "track"].map((m) => (
              <button
                key={m}
                type="button"
                className={`pm-tab ${mascotMode === m ? "is-on" : ""}`}
                onClick={() => setMascotMode(m)}
              >
                {m === "idle" ? "Idle bounce" : "Cursor track"}
              </button>
            ))}
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
            <MarketCard key={m.id} market={m} now={now} onOpen={() => {}} />
          ))}
        </div>

        {missingLogos.length > 0 && (
          <div className="pm-note pm-note-dim">
            Monogram fallback in use for: <strong>{missingLogos.join(", ")}</strong> — drop{" "}
            <code>{missingLogos[0].toLowerCase()}.svg</code> into <code>src/assets/coins/</code> to replace.
          </div>
        )}
      </div>
    </div>
  );
}
