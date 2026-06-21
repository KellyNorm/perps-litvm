import { useEffect, useMemo, useState } from "react";
import LeverageSlider from "./LeverageSlider.jsx";
import { fmtUsd, fmtUsdPx, fmt2 } from "../lib/format.js";
import { borrowDayFrac, fundingDayFrac, liqPrice, MIN_COLLATERAL } from "../lib/engine.js";
import { SLIPPAGE_OPTIONS } from "../lib/trade.js";
import { KIND_OPEN, KIND_INCREASE } from "../lib/triggers.js";

// Trade ticket. Market tab runs the 11b two-step open/increase. Limit & Stop tabs
// (11c) place a RESTING trigger entry via the shared controller — one leg, then the
// order rests on-chain until the browser-keeper poll fills it. triggerAbove is derived
// from trigger-vs-mark, NOT the Limit/Stop label (which only seeds the default + buffer
// intent); the "Rests as" badge shows the on-chain truth.
//
// The Limit/Stop tabs are ALWAYS viewable — only the submit is gated, never the tab.
// Routing by selected market+side:
//   • no position, no resting open here  -> requestTriggerOpen (resting OPEN)
//   • position open here                 -> requestTriggerIncrease (resting INCREASE,
//                                           inputs are ADD amounts)
//   • no position but a resting open here -> BLOCK a second open (on-chain a second
//                                           open can never fill once the first creates
//                                           the position)
// MUTEX: requestTriggerIncrease takes the position's closePending mutex, so only ONE
// resting trigger-edit per position (an increase OR a TP/SL close, never both) — if a
// resting exit already rests on this position, the increase submit is blocked.
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

  // Existing position on THIS market+side ⇒ both Market and trigger actions become
  // Increase. A trigger entry with a live position routes to requestTriggerIncrease, so
  // the Limit/Stop tabs stay viewable (no longer disabled) — only the submit is gated.
  const existing = useMemo(
    () => (positions || []).find((p) => p.symbol === meta.symbol && p.isLong === isLong),
    [positions, meta.symbol, isLong],
  );
  // A resting trigger-OPEN already on this market+side blocks a second open: on-chain a
  // second open can never fill once the first creates the position.
  const restingOpenHere = useMemo(
    () => (orders || []).find((o) => o.symbol === meta.symbol && o.isLong === isLong && o.kind === KIND_OPEN),
    [orders, meta.symbol, isLong],
  );
  // The closePending mutex group for THIS position: a resting trigger INCREASE or a
  // resting trigger EXIT (TP/SL). Either one blocks placing the other.
  const restingEditHere = useMemo(
    () =>
      (orders || []).find(
        (o) => o.symbol === meta.symbol && o.isLong === isLong && (o.kind === KIND_INCREASE || o.kindClass === "exit"),
      ),
    [orders, meta.symbol, isLong],
  );

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
  // Gate the SUBMIT (never the tab): a second open can't fill, and the closePending
  // mutex allows only one resting trigger-edit per position. The increase block covers
  // BOTH the trigger increase AND the Market-tab increase — requestIncrease takes the
  // same closePending mutex, so it would revert CloseAlreadyPending (wasted-gas tx)
  // while any resting trigger-edit (increase or exit) rests on this position.
  const blockedOpen = isTrigger && action === "open" && Boolean(restingOpenHere);
  const blockedIncrease = action === "increase" && Boolean(restingEditHere);
  // A market request is one-at-a-time per wallet and is currently being watched for the
  // keeper — block a second market submit until it resolves (the hook toasts otherwise).
  const pendingMarket = !isTrigger && Boolean(trade.pending);
  const blocked = blockedOpen || blockedIncrease || pendingMarket;
  const canSubmit =
    account && !wrongChain && !needsTokens && price != null && !tooSmall && !overBalance && !busy && trigValid && !blocked;

  function submit() {
    if (!account) return onConnect?.();
    if (wrongChain) return onSwitch?.();
    if (needsTokens) return onFaucet?.();
    if (isTrigger) {
      trade.submitTriggerEntry({ kind: action, symbol: meta.symbol, isLong, collateral: collNum, leverage: lev, triggerPrice: trig, mark: price, slipFrac: slip });
    } else {
      trade.submit({ action, symbol: meta.symbol, isLong, collateral: collNum, leverage: lev, slipFrac: slip });
    }
  }

  const verb = isTrigger
    ? `Place ${restsAs ? restsAs.toLowerCase() : otype}${action === "increase" ? " increase" : ""}`
    : action === "increase"
      ? "Increase"
      : "Open";
  let btnLabel;
  if (!account) btnLabel = "Connect wallet to trade";
  else if (wrongChain) btnLabel = "Switch to LiteForge (4441)";
  else if (needsGas) btnLabel = "Get zkLTC gas to trade →";
  else if (needsMusd) btnLabel = "Get mUSD to trade →";
  else if (busy && myFlow) btnLabel = myFlow.phase === "approving" ? "Approving…" : myFlow.phase === "executing" ? "Executing…" : "Working…";
  else if (pendingMarket) btnLabel = "Waiting for keeper…";
  else if (blockedOpen) btnLabel = "Open already resting";
  else if (blockedIncrease) btnLabel = "Position has a resting trigger-edit";
  else btnLabel = `${verb} ${side} · ${meta.symbol}`;

  return (
    <div className="panel">
      <div className="otabs" role="tablist" aria-label="Order type">
        <button className={otype === "market" ? "on" : ""} onClick={() => setOtype("market")}>
          Market
        </button>
        <button
          className={otype === "limit" ? "on" : ""}
          title={existing ? "Rest a limit increase that adds to your live position" : "Rest a limit entry below/above the mark"}
          onClick={() => { setOtype("limit"); setTrigTouched(false); }}
        >
          Limit
        </button>
        <button
          className={otype === "stop" ? "on" : ""}
          title={existing ? "Rest a stop increase that adds on a breakout" : "Rest a stop entry that fires on a breakout"}
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

      {existing && !isTrigger && !blockedIncrease && (
        <div className="ticket-note">
          You hold a {isLong ? "long" : "short"} {meta.symbol} — this will <b>add</b> to it (blended entry).
        </div>
      )}
      {existing && isTrigger && !blockedIncrease && (
        <div className="ticket-note">
          You hold a {isLong ? "long" : "short"} {meta.symbol} — this rests a trigger <b>increase</b> that adds to it (blended
          entry) when the mark crosses your trigger.
        </div>
      )}
      {blockedOpen && (
        <div className="ticket-note">
          A {restingOpenHere.typeLabel.toLowerCase()} already rests here — only one can fill; cancel it in the Orders tab first
          (<b>a second open can never fill</b> once the first creates the position).
        </div>
      )}
      {blockedIncrease && (
        <div className="ticket-note">
          This position already has a resting {restingEditHere.typeLabel.toLowerCase()} — only <b>one</b> resting trigger-edit per
          position (an increase OR a TP/SL close). Cancel it in the Orders tab first.
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

      {isTrigger && (
        <div className="field">
          <div className="field-head">
            <label htmlFor="trigInput">Trigger price</label>
            <span className="bal" style={{ cursor: "default" }}>
              Mark <b>{price != null ? fmtUsdPx(price) : "—"}</b>
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
                  {restsAs} {isLong ? "long" : "short"} · fires mark {triggerAbove ? "≥" : "≤"} {fmtUsdPx(trig)}
                </>
              ) : (
                <span className="loading-dim">enter a trigger</span>
              )}
            </span>
          </div>
        )}
        <div className="row">
          <span className="k">{action === "increase" ? "Added size" : "Position size"}</span>
          <span className="v">{fmtUsd(size)}</span>
        </div>
        <div className="row">
          <span className="k">{isTrigger ? "Entry (at trigger)" : "Entry price (live mark)"}</span>
          <span className="v">{entryPreview != null ? fmtUsdPx(entryPreview) : <span className="loading-dim">…</span>}</span>
        </div>
        <div className="row">
          <span className="k">
            Est. liquidation price <span className="hint" title="At the 10% maintenance margin, fees excluded at entry">?</span>
          </span>
          <span className="v liq">{liq != null ? fmtUsdPx(liq) : <span className="loading-dim">…</span>}</span>
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
          {myFlow.phase === "approving" || myFlow.phase === "requesting" || myFlow.phase === "waiting" || myFlow.phase === "executing" || myFlow.phase === "watching" ? (
            <span className="spin" aria-hidden="true" />
          ) : null}
          <span>{myFlow.message}</span>
        </div>
      )}

      <div className="panel-foot">
        {isTrigger
          ? "Collateral + the 0.5 mUSD fee are escrowed now; the order rests on-chain until the mark crosses your trigger, then the keeper fills it (fall back to filling it yourself if the keeper's down). Cancel for a full refund after 180s."
          : "One signature: collateral + the 0.5 mUSD keeper fee are escrowed at request, then the keeper executes it against the RedStone mark next block. If the keeper's down you can execute it yourself. Two-step execution protects the fill price."}
      </div>
    </div>
  );
}
