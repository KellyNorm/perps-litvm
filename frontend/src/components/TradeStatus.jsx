import { useEffect, useState } from "react";
import { countdown } from "../lib/format.js";

// Global status banner. A market order is now ONE signature (the request) — the keeper
// fills it. While the keeper works this shows "Submitted — waiting for the keeper…"
// (phase "watching"); the wallet is idle. If the keeper doesn't resolve it within the
// grace window (flow.fallbackReady) — or a manual self-execute reverted (phase "error")
// — it offers the recovery actions: "Execute it yourself" (the self-execute fallback),
// or, once CANCEL_DELAY has elapsed, Cancel & refund on-chain.
export default function TradeStatus({ flow, cancelDelay, onExecute, onCancel, onDismiss }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // "watching" (keeper in flight) and "error" both need the live cancel countdown.
  const recoverable = flow && (flow.phase === "watching" || flow.phase === "error");
  useEffect(() => {
    if (!recoverable || flow?.requestTs == null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [recoverable, flow?.requestTs]);

  if (!flow) return null;

  const isWatching = flow.phase === "watching";
  const working = ["approving", "requesting", "waiting", "executing"].includes(flow.phase);
  const isDone = flow.phase === "done";
  const isErr = flow.phase === "error";

  // Refund window: cancelRequest is allowed at requestTs + CANCEL_DELAY.
  const cancelAt = flow.requestTs != null ? flow.requestTs + cancelDelay : null;
  const cancelEta = cancelAt != null ? cancelAt - now : 0;
  const cancelReady = cancelAt != null && cancelEta <= 0;

  // The self-execute fallback shows once the keeper grace has lapsed (or on a revert).
  const showExecute = recoverable && flow.fallbackReady;

  return (
    <div className={"trade-status" + (isErr ? " err" : "") + (isDone ? (flow.ok ? " ok" : " warn") : "")} role="status" aria-live="polite">
      <div className="ts-body">
        {(working || isWatching) && <span className="spin" aria-hidden="true" />}
        <span className="ts-msg">{flow.message}</span>
      </div>
      <div className="ts-acts">
        {showExecute && (
          <button className="btn ts-resume" onClick={onExecute} title="Run the keeper step yourself (a second signature)">
            Execute it yourself
          </button>
        )}
        {recoverable && (
          <button className="btn ts-cancel" onClick={onCancel} disabled={!cancelReady} title={cancelReady ? "Reclaim the escrow on-chain" : "Refund window not open yet"}>
            {cancelReady ? "Cancel & refund" : `Cancel in ${countdown(cancelEta)}`}
          </button>
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
