import { useEffect, useMemo, useState } from "react";
import LeverageSlider from "./LeverageSlider.jsx";
import { fmtUsd, fmt2 } from "../lib/format.js";
import { borrowDayFrac, fundingDayFrac, liqPrice, MIN_COLLATERAL } from "../lib/engine.js";
import { SLIPPAGE_OPTIONS } from "../lib/trade.js";

// Trade ticket. Market tab runs the 11b two-step open/increase. Limit & Stop tabs
// (11c) place a RESTING trigger-open via the shared controller — one leg, then the
// order rests on-chain until the browser-keeper poll fills it. triggerAbove is derived
// from trigger-vs-mark, NOT the Limit/Stop label (which only seeds the default + buffer
// intent); the "Rests as" badge shows the on-chain truth. A resting open is only
// offered when there's no position AND no existing resting open on this market+side
// (the contract reverts PositionAlreadyOpen / one entry per key).
export default function OrderTicket({ meta, mark, state, musdBalance, nativeBalance, positions, orders, trade, account, wrongChain, onConnect, onSwitch, onFaucet }) {
  const [side, setSide] = useState("long");
  const [otype, setOtype] = useState("market"); // "market" | "limit" | "stop"
  const [coll, setColl] = useState(100);
  const [lev, setLev] = useState(2);
  const [slip, setSlip] = useState(SLIPPAGE_OPTIONS[1]); // default 0.5%
  const [trigPrice, setTrigPrice] = useState("");
  const [trigTouched, setTrigTouched] = useState(false);
  const [igniting, setIgniting] = useState(false);

  const isLong = side === "long";
  const price = mark && !mark.error ? mark.price : null;
  const size = coll * lev;

  // Existing position on THIS market+side ⇒ the Market action is Increase. Trigger
  // entries can't sit behind a live position (use it as a market increase instead), so
  // Limit/Stop are disabled while one is open.
  const existing = useMemo(
    () => (positions || []).find((p) => p.symbol === meta.symbol && p.isLong === isLong),
    [positions, meta.symbol, isLong],
  );
  // A resting trigger-OPEN already on this market+side blocks a second (one entry/key).
  const restingOpen = useMemo(
    () => (orders || []).find((o) => o.symbol === meta.symbol && o.isLong === isLong && o.kindClass === "entry"),
    [orders, meta.symbol, isLong],
  );

  // Force back to Market if the side change makes a trigger entry impossible.
  useEffect(() => {
    if (otype !== "market" && existing) setOtype("market");
  }, [existing, otype]);

  const isTrigger = otype !== "market";
  const action = existing ? "increase" : "open";

  // Seed the trigger price from side + Limit/Stop the first time / on tab change.
  // Limit buys below / sells above; Stop the reverse. (Encoding still comes from the
  // number, not this seed.)
  const trigSeed = useMemo(() => {
    if (price == null) return "";
    const below = otype === "limit" ? isLong : !isLong; // want the trigger below mark?
    const v = below ? price * 0.97 : price * 1.03;
    return v.toFixed(v < 10 ? 4 : 2);
  }, [price, otype, isLong]);

  useEffect(() => {
    if (isTrigger && !trigTouched) setTrigPrice(trigSeed);
  }, [trigSeed, isTrigger, trigTouched]);

  const trig = parseFloat(trigPrice) || 0;
  const trigValid = !isTrigger || (trig > 0 && price != null);
  const triggerAbove = isTrigger && trig > 0 && price != null ? trig >= price : false;
  const restsAs = isTrigger ? (triggerAbove === isLong ? "Stop" : "Limit") : null;

  // Preview liquidation off the entry the position will actually take: the trigger for
  // a resting order, the live mark for a market order.
  const entryPreview = isTrigger && trig > 0 ? trig : price;
  const liq = entryPreview ? liqPrice({ collateral: coll, sizeUsd: size, entryPrice: entryPreview, isLong }, 0, 0) : null;
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
  const needsGas = account && !wrongChain && nativeBalance != null && nativeBalance <= 0;
  const needsMusd = account && !wrongChain && musdBalance != null && musdBalance <= 0;
  const needsTokens = needsGas || needsMusd;
  const blockedByResting = isTrigger && Boolean(restingOpen);
  const canSubmit =
    account && !wrongChain && !needsTokens && price != null && !tooSmall && !overBalance && !busy && trigValid && !blockedByResting;

  function submit() {
    if (!account) return onConnect?.();
    if (wrongChain) return onSwitch?.();
    if (needsTokens) return onFaucet?.();
    if (isTrigger) {
      trade.submitTriggerOpen({ symbol: meta.symbol, isLong, collateral: collNum, leverage: lev, triggerPrice: trig, mark: price, slipFrac: slip });
    } else {
      trade.submit({ action, symbol: meta.symbol, isLong, collateral: collNum, leverage: lev, slipFrac: slip });
    }
  }

  const verb = isTrigger ? `Place ${restsAs ? restsAs.toLowerCase() : otype}` : action === "increase" ? "Increase" : "Open";
  let btnLabel;
  if (!account) btnLabel = "Connect wallet to trade";
  else if (wrongChain) btnLabel = "Switch to LiteForge (4441)";
  else if (needsGas) btnLabel = "Get zkLTC gas to trade →";
  else if (needsMusd) btnLabel = "Get mUSD to trade →";
  else if (busy && myFlow) btnLabel = myFlow.phase === "approving" ? "Approving…" : myFlow.phase === "executing" ? "Executing…" : "Working…";
  else if (blockedByResting) btnLabel = "Order already resting";
  else btnLabel = `${verb} ${side} · ${meta.symbol}`;

  return (
    <div className="panel">
      <div className="otabs" role="tablist" aria-label="Order type">
        <button className={otype === "market" ? "on" : ""} onClick={() => setOtype("market")}>
          Market
        </button>
        <button
          className={otype === "limit" ? "on" : ""}
          disabled={Boolean(existing)}
          title={existing ? "You hold this side — limit entries can't sit behind a live position" : "Rest a limit entry below/above the mark"}
          onClick={() => { setOtype("limit"); setTrigTouched(false); }}
        >
          Limit
        </button>
        <button
          className={otype === "stop" ? "on" : ""}
          disabled={Boolean(existing)}
          title={existing ? "You hold this side — stop entries can't sit behind a live position" : "Rest a stop entry that fires on a breakout"}
          onClick={() => { setOtype("stop"); setTrigTouched(false); }}
        >
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

      {existing && !isTrigger && (
        <div className="ticket-note">
          You hold a {isLong ? "long" : "short"} {meta.symbol} — this will <b>add</b> to it (blended entry).
        </div>
      )}
      {blockedByResting && (
        <div className="ticket-note">
          A {restingOpen.typeLabel.toLowerCase()} order is already resting on {meta.symbol} {isLong ? "long" : "short"}. Cancel it
          in the Orders tab to place another (<b>one entry per market + side</b>).
        </div>
      )}

      <div className="field">
        <div className="field-head">
          <label htmlFor="collInput">{action === "increase" && !isTrigger ? "Add collateral" : "Collateral"}</label>
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

      {isTrigger && (
        <div className="field">
          <div className="field-head">
            <label htmlFor="trigInput">Trigger price</label>
            <span className="bal" style={{ cursor: "default" }}>
              Mark <b>{price != null ? fmtUsd(price) : "—"}</b>
            </span>
          </div>
          <div className="input-wrap">
            <input
              id="trigInput"
              type="text"
              inputMode="decimal"
              value={trigPrice}
              aria-label="Trigger price"
              onChange={(e) => { setTrigTouched(true); setTrigPrice(e.target.value.replace(/[^0-9.]/g, "")); }}
            />
            <span className="ccy">USD</span>
          </div>
        </div>
      )}

      <LeverageSlider value={lev} onChange={setLev} />

      <div className="field slip-field">
        <div className="field-head">
          <label>Max slippage</label>
          <span className="hint" title="The fill must land within this of the trigger/mark, or — for a market order — the request auto-cancels and refunds. Stop orders widen this automatically so the catch isn't blocked.">
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
        {isTrigger && (
          <div className="row">
            <span className="k">Rests as</span>
            <span className="v">
              {trigValid && trig > 0 ? (
                <>
                  {restsAs} {isLong ? "long" : "short"} · fires mark {triggerAbove ? "≥" : "≤"} {fmtUsd(trig)}
                </>
              ) : (
                <span className="loading-dim">enter a trigger</span>
              )}
            </span>
          </div>
        )}
        <div className="row">
          <span className="k">{action === "increase" && !isTrigger ? "Added size" : "Position size"}</span>
          <span className="v">{fmtUsd(size)}</span>
        </div>
        <div className="row">
          <span className="k">{isTrigger ? "Entry (at trigger)" : "Entry price (live mark)"}</span>
          <span className="v">{entryPreview != null ? fmtUsd(entryPreview) : <span className="loading-dim">…</span>}</span>
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
          <span className="v">0.5 mUSD (reclaimed at fill)</span>
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
        {isTrigger
          ? "Collateral + the 0.5 mUSD fee are escrowed now; the order rests on-chain until the mark crosses your trigger, then your browser keeper fills it. Cancel for a full refund after 180s."
          : "Collateral + the 0.5 mUSD keeper fee are escrowed at request and settled against the RedStone mark at execute. Two-step keeper execution protects the fill price."}
      </div>
    </div>
  );
}
