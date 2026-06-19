import { useEffect, useMemo, useState } from "react";
import LeverageSlider from "./LeverageSlider.jsx";
import { fmtUsd, fmt2 } from "../lib/format.js";
import { borrowDayFrac, fundingDayFrac, liqPrice, MIN_COLLATERAL } from "../lib/engine.js";
import { SLIPPAGE_OPTIONS } from "../lib/trade.js";

// Live trade ticket — the 11b open/increase entry. When the wallet already holds a
// position on this market+side the panel becomes an INCREASE (add collateral/size);
// otherwise it OPENS. Both run the two-step loop via the shared `trade` controller
// (request -> wait for a fresh payload -> self-keeper execute). Close / partial-close
// live in the positions table. All preview numbers still come from the live mark +
// engine math so the readout stays honest.
export default function OrderTicket({ meta, mark, state, musdBalance, nativeBalance, positions, trade, account, wrongChain, onConnect, onSwitch, onFaucet }) {
  const [side, setSide] = useState("long");
  const [coll, setColl] = useState(100);
  const [lev, setLev] = useState(2);
  const [slip, setSlip] = useState(SLIPPAGE_OPTIONS[1]); // default 0.5%
  const [igniting, setIgniting] = useState(false);

  const isLong = side === "long";
  const price = mark && !mark.error ? mark.price : null;
  const size = coll * lev;

  // Existing position on THIS market+side ⇒ the action is Increase (add collateral).
  const existing = useMemo(
    () => (positions || []).find((p) => p.symbol === meta.symbol && p.isLong === isLong),
    [positions, meta.symbol, isLong],
  );
  const action = existing ? "increase" : "open";

  const liq = price ? liqPrice({ collateral: coll, sizeUsd: size, entryPrice: price, isLong }, 0, 0) : null;
  const borrowDay = size * borrowDayFrac();
  const fundFrac = state ? fundingDayFrac(state.longOI, state.shortOI) : null;
  const pay = fundFrac == null ? null : (isLong ? fundFrac : -fundFrac) * size;

  // Ignite the button when OUR open/increase fills.
  useEffect(() => {
    const lf = trade.lastFill;
    if (lf && lf.n && lf.symbol === meta.symbol && lf.isLong === isLong && (lf.action === "open" || lf.action === "increase")) {
      setIgniting(true);
      const t = setTimeout(() => setIgniting(false), 900);
      return () => clearTimeout(t);
    }
  }, [trade.lastFill, meta.symbol, isLong]);

  // Inline status for THIS panel's action (open/increase) only.
  const f = trade.flow;
  const myFlow = f && (f.action === "open" || f.action === "increase") && f.symbol === meta.symbol && f.isLong === isLong ? f : null;
  const busy = trade.inProgress;

  const collNum = Number(coll) || 0;
  const tooSmall = collNum < MIN_COLLATERAL;
  const overBalance = musdBalance != null && collNum > musdBalance;
  // Token preconditions: opening/increasing needs zkLTC for gas AND mUSD (collateral +
  // the 0.5 fee). With either missing, route the user to the faucet instead of a dead
  // disabled button.
  const needsGas = account && !wrongChain && nativeBalance != null && nativeBalance <= 0;
  const needsMusd = account && !wrongChain && musdBalance != null && musdBalance <= 0;
  const needsTokens = needsGas || needsMusd;
  const canSubmit = account && !wrongChain && !needsTokens && price != null && !tooSmall && !overBalance && !busy;

  function submit() {
    if (!account) return onConnect?.();
    if (wrongChain) return onSwitch?.();
    if (needsTokens) return onFaucet?.();
    trade.submit({ action, symbol: meta.symbol, isLong, collateral: collNum, leverage: lev, slipFrac: slip });
  }

  const verb = action === "increase" ? "Increase" : "Open";
  let btnLabel;
  if (!account) btnLabel = "Connect wallet to trade";
  else if (wrongChain) btnLabel = "Switch to LiteForge (4441)";
  else if (needsGas) btnLabel = "Get zkLTC gas to trade →";
  else if (needsMusd) btnLabel = "Get mUSD to trade →";
  else if (busy && myFlow) btnLabel = myFlow.phase === "approving" ? "Approving…" : myFlow.phase === "executing" ? "Executing…" : "Working…";
  else btnLabel = `${verb} ${side} · ${meta.symbol}`;

  return (
    <div className="panel">
      <div className="otabs" role="tablist" aria-label="Order type">
        <button className="on">Market</button>
        <button disabled title="Limit / stop orders land in 11c">
          Limit
        </button>
        <button disabled title="Limit / stop orders land in 11c">
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

      {existing && (
        <div className="ticket-note">
          You hold a {isLong ? "long" : "short"} {meta.symbol} — this will <b>add</b> to it (blended entry).
        </div>
      )}

      <div className="field">
        <div className="field-head">
          <label htmlFor="collInput">{action === "increase" ? "Add collateral" : "Collateral"}</label>
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

      <div className="field slip-field">
        <div className="field-head">
          <label>Max slippage</label>
          <span className="hint" title="The fill must land within this of the live mark, or the request auto-cancels and refunds">
            ?
          </span>
        </div>
        <div className="slip">
          {SLIPPAGE_OPTIONS.map((s) => (
            <button key={s} className={slip === s ? "on" : ""} onClick={() => setSlip(s)} type="button">
              {(s * 100).toFixed(s < 0.01 ? 1 : 0)}%
            </button>
          ))}
        </div>
      </div>

      <div className="readout">
        <div className="row">
          <span className="k">{action === "increase" ? "Added size" : "Position size"}</span>
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
            {pay == null ? <span className="loading-dim">—</span> : (pay >= 0 ? "−$" : "+$") + Math.abs(pay).toFixed(3) + " / day"}
          </span>
        </div>
        <div className="row">
          <span className="k">Execution fee</span>
          <span className="v">0.5 mUSD (reclaimed at execute)</span>
        </div>
      </div>

      {account && !wrongChain && !needsTokens && tooSmall && <div className="ticket-warn">Minimum collateral is {MIN_COLLATERAL} mUSD.</div>}
      {account && !wrongChain && !needsTokens && !tooSmall && overBalance && (
        <div className="ticket-warn">Collateral exceeds your mUSD balance.</div>
      )}

      <button
        className={"open-btn " + side + (igniting ? " igniting" : "") + (needsTokens ? " cta" : "")}
        disabled={account && !wrongChain && !needsTokens && !canSubmit}
        onClick={submit}
      >
        {btnLabel}
      </button>

      {myFlow && (
        <div className={"ticket-status" + (myFlow.phase === "error" ? " err" : "")}>
          {myFlow.phase === "approving" || myFlow.phase === "requesting" || myFlow.phase === "waiting" || myFlow.phase === "executing" ? (
            <span className="spin" aria-hidden="true" />
          ) : null}
          <span>{myFlow.message}</span>
        </div>
      )}

      <div className="panel-foot">
        Collateral + the 0.5 mUSD keeper fee are escrowed at request and settled against the RedStone mark at execute. Two-step
        keeper execution protects the fill price.
      </div>
    </div>
  );
}
