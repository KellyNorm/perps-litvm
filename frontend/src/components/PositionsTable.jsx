import { fmtUsd, fmtUsdPx, fmtSigned } from "../lib/format.js";
import { signedPnl, liqPrice, health, healthColor, MIN_COLLATERAL } from "../lib/engine.js";
import { KIND_INCREASE } from "../lib/triggers.js";

// Default slippage for close / partial-close (the order panel carries the selector
// for opens; closes use a sensible 0.5% bound). The two-step loop auto-cancels +
// refunds the fee if the fill lands outside this.
const CLOSE_SLIP = 0.005;

export default function PositionsTable({ account, positions, marks, live, orders, trade, wrongChain, onAddTpSl }) {
  const colSpan = 9;

  // Display price for PnL / the Live column: prefer the fast exchange ticker (so PnL
  // ticks smoothly), fall back to the RedStone mark, then entry. INDICATIVE — positions
  // execute & realize against the RedStone mark, not this feed.
  function displayPrice(p) {
    const lv = live && live[p.symbol];
    if (lv && isFinite(lv.price)) return { price: lv.price, ok: true };
    const mk = marks[p.symbol];
    if (mk && !mk.error) return { price: mk.price, ok: true };
    return { price: p.entryPrice, ok: false };
  }

  // A resting trigger-edit on this position — a TP/SL exit OR a trigger increase. Both
  // take the engine's closePending mutex at request time, so while one rests the market
  // Close / partial / +TP/SL controls would revert CloseAlreadyPending — lock them and
  // point at the Orders tab.
  function restingEditFor(p) {
    return (orders || []).find(
      (o) => o.symbol === p.symbol && o.isLong === p.isLong && (o.kindClass === "exit" || o.kind === KIND_INCREASE),
    );
  }

  function emptyRow(content) {
    return (
      <tr>
        <td colSpan={colSpan} className="empty">
          {content}
        </td>
      </tr>
    );
  }

  // Status line for the row whose close/decrease is currently in-flight.
  function rowFlowFor(p) {
    const f = trade?.flow;
    if (!f || (f.action !== "close" && f.action !== "decrease")) return null;
    return f.symbol === p.symbol && f.isLong === p.isLong ? f : null;
  }

  function act(p, action, closeBps) {
    if (!account || wrongChain || trade?.inProgress) return;
    trade.submit({ action, symbol: p.symbol, isLong: p.isLong, closeBps, slipFrac: CLOSE_SLIP });
  }

  function actionCell(p) {
    const rf = rowFlowFor(p);
    if (rf) {
      const working = rf.phase !== "error";
      return (
        <span className={"row-status" + (rf.phase === "error" ? " err" : "")}>
          {working ? <span className="spin" aria-hidden="true" /> : null}
          {rf.phase === "approving"
            ? "Approving…"
            : rf.phase === "watching"
              ? "Waiting for keeper…"
              : rf.phase === "executing"
                ? "Executing…"
                : rf.phase === "error"
                  ? "Failed — see banner"
                  : "Working…"}
        </span>
      );
    }
    const resting = restingEditFor(p);
    const locked = Boolean(resting);
    const isExit = resting?.kindClass === "exit";
    const disabled = wrongChain || trade?.inProgress || locked;
    // Dust guard (mirrors requestDecrease): a partial close that would leave the
    // remainder below MIN_COLLATERAL reverts on-chain, so disable it here.
    const dust25 = p.collateral * 0.75 < MIN_COLLATERAL;
    const dust50 = p.collateral * 0.5 < MIN_COLLATERAL;
    const dustTip = `Would leave less than ${MIN_COLLATERAL} mUSD collateral — use Close instead`;
    const lockTip = isExit
      ? "A TP/SL is resting on this position — cancel it in the Orders tab to close manually"
      : "A trigger increase is resting on this position — cancel it in the Orders tab to close manually";
    return (
      <span className="row-acts">
        <button
          className="rowbtn"
          disabled={disabled || dust25}
          onClick={() => act(p, "decrease", 2500)}
          title={locked ? lockTip : dust25 ? dustTip : "Close 25% of this position"}
        >
          −25%
        </button>
        <button
          className="rowbtn"
          disabled={disabled || dust50}
          onClick={() => act(p, "decrease", 5000)}
          title={locked ? lockTip : dust50 ? dustTip : "Close 50% of this position"}
        >
          −50%
        </button>
        <button className="rowbtn close" disabled={disabled} onClick={() => act(p, "close")} title={locked ? lockTip : "Close the whole position"}>
          Close
        </button>
        <button
          className={"rowbtn tpsl" + (isExit ? " set" : "")}
          disabled={wrongChain || trade?.inProgress || locked}
          onClick={() => !locked && onAddTpSl?.(p)}
          title={
            locked
              ? isExit
                ? `${resting.typeLabel} resting at ${fmtUsdPx(resting.triggerPrice)} — one resting trigger-edit per position`
                : `A trigger increase is resting at ${fmtUsdPx(resting.triggerPrice)} — one resting trigger-edit per position (cancel it first)`
              : "Add a resting take-profit / stop-loss"
          }
        >
          {isExit ? "TP/SL ✓" : "+ TP/SL"}
        </button>
      </span>
    );
  }

  let body;
  if (!account) {
    body = emptyRow(
      <>
        Connect a wallet to view your positions.
        <span className="sub">Reads run without one — positions need your address.</span>
      </>,
    );
  } else if (positions === null) {
    body = emptyRow(<span className="loading-dim">Reading positions…</span>);
  } else if (positions.length === 0) {
    body = emptyRow(
      <>
        No open positions.
        <span className="sub">Real empty — every live market × side returned size 0 for this address.</span>
      </>,
    );
  } else {
    body = positions.map((p) => {
      const dp = displayPrice(p);
      const mark = dp.price;
      const lev = p.collateral > 0 ? p.sizeUsd / p.collateral : 0;
      const pnl = signedPnl(p, mark);
      const liq = liqPrice(p, p.borrowFee, p.fundingOwed);
      const h = health(p, mark, liq);
      const hc = healthColor(h);
      const hpc = Math.round(h * 100);
      const netFunding = -p.fundingOwed; // + ⇒ position is owed (receives), − ⇒ owes
      return (
        <tr key={p.key} className={h < 0.25 ? "danger" : undefined}>
          <td data-label="Market">
            <span className="pair">{p.name}</span>
            <span className={"sidetag " + (p.isLong ? "long" : "short")} style={{ marginLeft: 8 }}>
              {p.isLong ? "Long" : "Short"}
            </span>
            <span className="lev">{lev.toFixed(lev % 1 ? 1 : 0)}×</span>
          </td>
          <td className="mono" data-label="Size">{fmtUsd(p.sizeUsd)}</td>
          <td className="mono" data-label="Entry">{fmtUsdPx(p.entryPrice)}</td>
          <td className="mono" data-label="Live">{dp.ok ? fmtUsdPx(mark) : <span className="loading-dim">…</span>}</td>
          <td className="mono neg" data-label="Liq. price">{fmtUsdPx(liq)}</td>
          <td data-label="Health">
            <span className="health">
              <span className="health-track">
                <span className="health-fill" style={{ width: hpc + "%", background: hc }}></span>
              </span>
              <span className="mono" style={{ fontSize: 11, color: hc }}>
                {hpc}%
              </span>
            </span>
          </td>
          <td className={"mono " + (netFunding >= 0 ? "pos" : "neg")} data-label="Net funding">{fmtSigned(netFunding)}</td>
          <td className={"mono " + (pnl >= 0 ? "pos" : "neg")} data-label="uPnL">{fmtSigned(pnl)}</td>
          <td style={{ textAlign: "right" }} data-label="Manage">{actionCell(p)}</td>
        </tr>
      );
    });
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Size</th>
            <th>Entry</th>
            <th>Live</th>
            <th>Liq. price</th>
            <th>Health</th>
            <th>Net funding</th>
            <th>uPnL</th>
            <th style={{ textAlign: "right" }}>Manage</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
      {positions && positions.length > 0 && (
        <div className="chart-source" style={{ margin: "8px 2px 0" }}>
          Live price &amp; uPnL are indicative real-time (public-exchange feed). Liquidation, triggers, and actual
          execution / realized PnL settle against the RedStone mark · execution price.
        </div>
      )}
    </>
  );
}
