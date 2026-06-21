import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUsd, fmtUsdPx } from "../lib/format.js";
import { MIN_COLLATERAL, signedPnl } from "../lib/engine.js";

// "Add TP/SL" modal for an open position. Places a single RESTING exit (take-profit
// or stop-loss) via requestTriggerClose (full) / requestTriggerDecrease (partial).
// The TP/SL toggle only seeds a sensible default + a hint; the actual gate direction
// (triggerAbove) and stop-vs-limit buffer are derived from trigger-vs-mark in the
// controller, so the "Rests as" badge below always shows the on-chain truth.
export default function TpSlModal({ position, mark, trade, onClose }) {
  const p = position;
  const closeRef = useRef(null);
  const [intent, setIntent] = useState("tp"); // "tp" | "sl" — UI seed only
  const [size, setSize] = useState("full"); // "full" | 2500 | 5000
  const [price, setPrice] = useState("");
  const [touched, setTouched] = useState(false);

  // Seed the trigger price from the position direction + intent the first time, and on
  // intent change before the user types. TP fires on a favourable move, SL adverse.
  const seed = useMemo(() => {
    if (!mark) return "";
    const fav = p.isLong ? intent === "tp" : intent === "sl"; // price needs to go UP?
    const pct = intent === "tp" ? 0.05 : 0.05;
    const v = fav ? mark * (1 + pct) : mark * (1 - pct);
    return v.toFixed(v < 10 ? 4 : 2);
  }, [mark, intent, p.isLong]);

  useEffect(() => {
    if (!touched) setPrice(seed);
  }, [seed, touched]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trig = parseFloat(price) || 0;
  const valid = trig > 0 && mark != null;

  // Derived ON-CHAIN truth (same rule the controller encodes).
  const triggerAbove = valid ? trig >= mark : false;
  const isStop = triggerAbove !== p.isLong;
  const restsAs = isStop ? "Stop-loss" : "Take-profit";

  // Dust guard for partial closes (mirrors requestDecrease): the remainder must stay
  // >= MIN_COLLATERAL collateral.
  const dust = (bps) => p.collateral * (1 - bps / 10000) < MIN_COLLATERAL;
  const sizeBad = size !== "full" && dust(size);

  // Sanity hint: a TP that would fire instantly (already past), or pnl direction.
  const wouldFireNow = valid && (triggerAbove ? mark >= trig : mark <= trig);
  const estPnl = valid ? signedPnl(p, trig) : null;

  const busy = trade?.inProgress;
  const canSubmit = valid && !sizeBad && !busy;

  function submit() {
    if (!canSubmit) return;
    const kind = size === "full" ? "close" : "decrease";
    trade.submitTriggerExit({ symbol: p.symbol, isLong: p.isLong, kind, closeBps: size === "full" ? 0 : size, triggerPrice: trig, mark });
    onClose();
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tpslTitle">
        <div className="modal-head">
          <h3 id="tpslTitle">
            Add TP / SL · {p.name} <span className={"sidetag " + (p.isLong ? "long" : "short")}>{p.isLong ? "Long" : "Short"}</span>
          </h3>
          <button className="x" ref={closeRef} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-intro">
            A single <b>resting exit</b> that fills when the mark crosses your trigger. Only <b>one</b> per position (the engine's
            close mutex — no OCO), and while it rests the market Close / partial buttons are locked.
          </p>

          <div className="otabs" role="tablist" aria-label="Exit type" style={{ marginBottom: 14 }}>
            <button className={intent === "tp" ? "on" : ""} onClick={() => { setIntent("tp"); setTouched(false); }}>
              Take-profit
            </button>
            <button className={intent === "sl" ? "on" : ""} onClick={() => { setIntent("sl"); setTouched(false); }}>
              Stop-loss
            </button>
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="trigInput">Trigger price</label>
              <span className="bal" style={{ cursor: "default" }}>
                Mark <b>{mark != null ? fmtUsdPx(mark) : "—"}</b>
              </span>
            </div>
            <div className="input-wrap">
              <input
                id="trigInput"
                type="text"
                inputMode="decimal"
                value={price}
                aria-label="Trigger price"
                onChange={(e) => {
                  setTouched(true);
                  setPrice(e.target.value.replace(/[^0-9.]/g, ""));
                }}
              />
              <span className="ccy">USD</span>
            </div>
          </div>

          <div className="field slip-field">
            <div className="field-head">
              <label>Close size</label>
            </div>
            <div className="slip">
              <button className={size === 2500 ? "on" : ""} disabled={dust(2500)} onClick={() => setSize(2500)} type="button" title={dust(2500) ? "Would leave dust collateral" : ""}>
                25%
              </button>
              <button className={size === 5000 ? "on" : ""} disabled={dust(5000)} onClick={() => setSize(5000)} type="button" title={dust(5000) ? "Would leave dust collateral" : ""}>
                50%
              </button>
              <button className={size === "full" ? "on" : ""} onClick={() => setSize("full")} type="button">
                Full
              </button>
            </div>
          </div>

          <div className="readout" style={{ marginBottom: 14 }}>
            <div className="row">
              <span className="k">Rests as</span>
              <span className={"v " + (isStop ? "neg" : "pos")}>{valid ? restsAs : "—"}</span>
            </div>
            <div className="row">
              <span className="k">Gate</span>
              <span className="v mono">{valid ? `mark ${triggerAbove ? "≥" : "≤"} ${fmtUsdPx(trig)}` : "—"}</span>
            </div>
            <div className="row">
              <span className="k">Est. P&L at trigger</span>
              <span className={"v " + (estPnl >= 0 ? "pos" : "neg")}>{estPnl != null ? (estPnl >= 0 ? "+" : "−") + fmtUsd(Math.abs(estPnl)) : "—"}</span>
            </div>
            <div className="row">
              <span className="k">Locked escrow</span>
              <span className="v">0.5 mUSD fee (reclaimed at fill)</span>
            </div>
          </div>

          {wouldFireNow && <div className="ticket-warn">This trigger is already on the fill side of the mark — it would fill on the next keeper poll.</div>}
          {sizeBad && <div className="ticket-warn">That partial close would leave less than {MIN_COLLATERAL} mUSD collateral — use Full.</div>}

          <button className={"open-btn " + (p.isLong ? "long" : "short")} disabled={!canSubmit} onClick={submit}>
            {busy ? "Working…" : `Place ${valid ? restsAs.toLowerCase() : "exit"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
