import { useEffect, useState } from "react";
import { fmtUsd, fmtUsd2, countdown } from "../lib/format.js";

// Resting-orders table (Orders tab). Lists the wallet's open trigger orders, surfaces
// the browser-keeper readiness (a "Fill now" appears only when the read-only poll says
// the order WOULD fill), and offers Cancel once the 180s refund lock elapses. The
// type label is derived from the on-chain (kind, triggerAbove) — Limit/Stop/TP/SL are
// presentation only, never the gate.
const CANCEL_DELAY = 180;

export default function OrdersTable({ account, orders, readiness, trade, wrongChain }) {
  const colSpan = 7;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  function emptyRow(content) {
    return (
      <tr>
        <td colSpan={colSpan} className="empty">
          {content}
        </td>
      </tr>
    );
  }

  function sizeCell(o) {
    if (o.kindClass === "entry") return fmtUsd(o.sizeUsd) + (o.leverage ? ` · ${o.leverage}×` : "");
    if (o.kind === 1) return "Close 100%";
    if (o.closeBps != null) return `Close ${(o.closeBps / 100).toFixed(o.closeBps % 100 ? 2 : 0)}%`;
    return "—";
  }

  function statusCell(o) {
    // This order's fill/cancel currently in-flight in the global flow?
    const f = trade?.flow;
    const inFlight = f && f.id === o.id && (f.phase === "executing" || f.phase === "requesting");
    if (inFlight) {
      return (
        <span className="row-status">
          <span className="spin" aria-hidden="true" />
          Working…
        </span>
      );
    }
    const state = readiness[o.id];
    const disabled = wrongChain || trade?.inProgress;
    if (state === "ready") {
      return (
        <button className="rowbtn fill" disabled={disabled} onClick={() => trade.fillOrder(o)} title="The keeper poll says this would fill now — send the execute">
          Fill now ⚡
        </button>
      );
    }
    // Resting — show why, honestly.
    const why = /SlippageNotMet/.test(state || "")
      ? "Trigger hit — waiting for the price to come back inside slippage"
      : /TriggerNotMet/.test(state || "")
        ? "Resting — mark hasn't crossed the trigger yet"
        : state
          ? "Resting — watching"
          : "Watching…";
    return (
      <span className="row-status" title={why}>
        <span className="dot watching" aria-hidden="true" />
        Watching
      </span>
    );
  }

  function cancelCell(o) {
    const cancelAt = o.requestTs + CANCEL_DELAY;
    const eta = cancelAt - now;
    const ready = eta <= 0;
    const disabled = !ready || wrongChain || trade?.inProgress;
    return (
      <button
        className="rowbtn close"
        disabled={disabled}
        onClick={() => ready && trade.cancelOrder(o)}
        title={ready ? "Cancel this order and refund the escrow" : "Cancel locks for 180s after placing"}
      >
        {ready ? "Cancel" : `Cancel ${countdown(eta)}`}
      </button>
    );
  }

  let body;
  if (!account) {
    body = emptyRow(
      <>
        Connect a wallet to view your resting orders.
        <span className="sub">Orders live on-chain; reading them needs your address.</span>
      </>,
    );
  } else if (orders === null) {
    body = emptyRow(<span className="loading-dim">Reading orders…</span>);
  } else if (orders.length === 0) {
    body = emptyRow(
      <>
        No resting orders.
        <span className="sub">Place a limit/stop from the ticket, or a TP/SL from a position.</span>
      </>,
    );
  } else {
    body = orders.map((o) => (
      <tr key={o.id}>
        <td>
          <span className={"ordtype " + (o.isStop ? "stop" : "limit")}>{o.typeLabel}</span>
        </td>
        <td>
          <span className="pair">{o.name}</span>
          <span className={"sidetag " + (o.isLong ? "long" : "short")} style={{ marginLeft: 8 }}>
            {o.isLong ? "Long" : "Short"}
          </span>
        </td>
        <td className="mono">
          {o.triggerAbove ? "≥ " : "≤ "}
          {fmtUsd(o.triggerPrice)}
        </td>
        <td className="mono">{sizeCell(o)}</td>
        <td className="mono">{fmtUsd2(o.locked)} mUSD</td>
        <td style={{ textAlign: "right" }}>{statusCell(o)}</td>
        <td style={{ textAlign: "right" }}>{cancelCell(o)}</td>
      </tr>
    ));
  }

  return (
    <>
      {account && orders && orders.length > 0 && (
        <div className="orders-note">
          Resting orders are watched <b>only while this tab is open</b> — your browser plays keeper (a read-only fillability poll;
          no gas, no prompt). A standalone keeper bot is Phase 3.
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Market</th>
            <th>Trigger</th>
            <th>Size</th>
            <th>Locked</th>
            <th style={{ textAlign: "right" }}>Keeper</th>
            <th style={{ textAlign: "right" }}>Manage</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </>
  );
}
