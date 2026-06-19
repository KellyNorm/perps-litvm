import { useEffect, useState } from "react";
import { countdown } from "../lib/format.js";

// Global two-step status banner. While a trade is in flight it shows the live step
// ("Step 2 of 2 — waiting for a fresh price…"); when an order is left unfinished
// (refresh, dismissed prompt, or a revert) it offers the recovery actions: Resume
// the keeper leg, or — once CANCEL_DELAY has elapsed — Cancel & refund on-chain.
export default function TradeStatus({ flow, cancelDelay, onResume, onCancel, onDismiss }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const recoverable = flow && (flow.phase === "resume" || flow.phase === "error");
  useEffect(() => {
    if (!recoverable || flow?.requestTs == null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [recoverable, flow?.requestTs]);

  if (!flow) return null;

  const working = ["approving", "requesting", "waiting", "executing"].includes(flow.phase);
  const isDone = flow.phase === "done";
  const isErr = flow.phase === "error";

  // Refund window: cancelRequest is allowed at requestTs + CANCEL_DELAY.
  const cancelAt = flow.requestTs != null ? flow.requestTs + cancelDelay : null;
  const cancelEta = cancelAt != null ? cancelAt - now : 0;
  const cancelReady = cancelAt != null && cancelEta <= 0;

  return (
    <div className={"trade-status" + (isErr ? " err" : "") + (isDone ? (flow.ok ? " ok" : " warn") : "")} role="status" aria-live="polite">
      <div className="ts-body">
        {working && <span className="spin" aria-hidden="true" />}
        <span className="ts-msg">{flow.message}</span>
      </div>
      <div className="ts-acts">
        {recoverable && (
          <>
            <button className="btn ts-resume" onClick={onResume}>
              Resume
            </button>
            <button className="btn ts-cancel" onClick={onCancel} disabled={!cancelReady} title={cancelReady ? "Reclaim the escrow on-chain" : "Refund window not open yet"}>
              {cancelReady ? "Cancel & refund" : `Cancel in ${countdown(cancelEta)}`}
            </button>
          </>
        )}
        {!working && (
          <button className="btn ts-dismiss" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
