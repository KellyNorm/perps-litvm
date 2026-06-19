import { useState } from "react";
import LeverageSlider from "./LeverageSlider.jsx";
import { fmtUsd, fmt2, fmtPrice } from "../lib/format.js";
import { borrowDayFrac, fundingDayFrac, liqPrice } from "../lib/engine.js";

// Read-only trade-ticket PREVIEW. No on-chain writes in 11a — the Open button is
// disabled; all numbers (size, liq, borrow/day, funding/day) are computed from the
// LIVE mark and the engine math so the leverage flame + readout behave for real.
export default function OrderTicket({ meta, mark, state, musdBalance }) {
  const [side, setSide] = useState("long");
  const [coll, setColl] = useState(100);
  const [lev, setLev] = useState(2);

  const isLong = side === "long";
  const price = mark && !mark.error ? mark.price : null;
  const size = coll * lev;

  const liq = price ? liqPrice({ collateral: coll, sizeUsd: size, entryPrice: price, isLong }, 0, 0) : null;
  const borrowDay = size * borrowDayFrac();
  const fundFrac = state ? fundingDayFrac(state.longOI, state.shortOI) : null;
  // pay > 0 ⇒ this side pays funding (shown as −$); < 0 ⇒ receives (+$).
  const pay = fundFrac == null ? null : (isLong ? fundFrac : -fundFrac) * size;

  return (
    <div className="panel">
      <div className="panel-banner">
        <b>Preview only.</b> This read-only build wires every number to chain & the RedStone mark. Placing orders lands in a
        later PR.
      </div>

      <div className="otabs" role="tablist" aria-label="Order type">
        <button className="on" disabled>
          Market
        </button>
        <button disabled title="Trigger orders land in a later PR">
          Limit
        </button>
        <button disabled title="Trigger orders land in a later PR">
          Stop
        </button>
      </div>

      <div className="toggle">
        <button className={"long" + (isLong ? " on" : "")} onClick={() => setSide("long")}>
          Long
        </button>
        <button className={"short" + (!isLong ? " on" : "")} onClick={() => setSide("short")}>
          Short
        </button>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="collInput">Collateral</label>
          <button
            className="bal"
            type="button"
            onClick={() => musdBalance != null && setColl(Math.max(0, Math.floor(musdBalance)))}
          >
            Balance <b>{musdBalance == null ? "— mUSD" : fmt2(musdBalance) + " mUSD"}</b>
          </button>
        </div>
        <div className="input-wrap">
          <input
            id="collInput"
            type="text"
            inputMode="decimal"
            value={coll}
            aria-label="Collateral in mUSD"
            onChange={(e) => setColl(parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
          />
          <span className="ccy">mUSD</span>
        </div>
      </div>

      <LeverageSlider value={lev} onChange={setLev} />

      <div className="readout">
        <div className="row">
          <span className="k">Position size</span>
          <span className="v">{fmtUsd(size)}</span>
        </div>
        <div className="row">
          <span className="k">Entry price (live mark)</span>
          <span className="v">{price != null ? fmtUsd(price) : <span className="loading-dim">…</span>}</span>
        </div>
        <div className="row">
          <span className="k">
            Est. liquidation price <span className="hint" title="At the 10% maintenance margin, fees excluded at entry">?</span>
          </span>
          <span className="v liq">{liq != null ? fmtUsd(liq) : <span className="loading-dim">…</span>}</span>
        </div>
        <div className="row">
          <span className="k">
            Borrow fee <span className="hint" title="~10%/yr on notional, accrued per second, paid to LPs">?</span>
          </span>
          <span className="v">${borrowDay.toFixed(3)} / day</span>
        </div>
        <div className="row">
          <span className="k">
            Funding <span className="hint" title="Paid to / from the other side based on live OI skew">?</span>
          </span>
          <span className="v">
            {pay == null ? (
              <span className="loading-dim">—</span>
            ) : (
              (pay >= 0 ? "−$" : "+$") + Math.abs(pay).toFixed(3) + " / day"
            )}
          </span>
        </div>
      </div>

      <button className={"open-btn " + side} disabled title="Trading is enabled in a later PR">
        Open {side} · {meta.symbol}
      </button>
      <div className="panel-foot">
        Collateral is held by the position manager and settled against the RedStone mark on close. Two-step keeper execution
        protects the fill price.
      </div>
    </div>
  );
}
