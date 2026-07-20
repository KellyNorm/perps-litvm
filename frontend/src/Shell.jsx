import { useState } from "react";
import App from "./App.jsx";
import PredictionApp from "./components/prediction/PredictionApp.jsx";

// Mode switch between the live perps app and the prediction view.
//
// ISOLATION CONTRACT — the perps app is a live money path, so:
//
//  1. BOTH trees stay MOUNTED at all times. The switch toggles CSS visibility, it does
//     not unmount. React therefore keeps all perps state (selected market, tab, open
//     modals, in-flight trade status, chart series) exactly as it was, so leaving and
//     returning is a no-op from perps' point of view.
//  2. `App.jsx` and every perps component are UNMODIFIED. This file wraps them; it
//     does not reach inside. `git diff` on the perps tree is empty.
//  3. The switch lives here, not in perps' TopBar, precisely so no perps component
//     had to be edited. Moving it into the nav later is a deliberate, separate change.
//
// `hidden` (display:none) rather than unmounting also means the perps RPC polls keep
// running in the background — intentional: coming back shows fresh data, not a
// spinner. If that background cost ever matters, pause the hooks; do NOT unmount.

export default function Shell() {
  const [mode, setMode] = useState("perps");

  return (
    <>
      <div hidden={mode !== "perps"}>
        <App />
      </div>

      <div hidden={mode !== "predictions"}>
        <PredictionApp />
      </div>

      <div className="pm-modeswitch" role="group" aria-label="Switch app mode">
        <button
          type="button"
          className={`pm-tab ${mode === "perps" ? "is-on" : ""}`}
          onClick={() => setMode("perps")}
          aria-pressed={mode === "perps"}
        >
          Perps
        </button>
        <button
          type="button"
          className={`pm-tab ${mode === "predictions" ? "is-on" : ""}`}
          onClick={() => setMode("predictions")}
          aria-pressed={mode === "predictions"}
        >
          Predictions
        </button>
      </div>
    </>
  );
}
