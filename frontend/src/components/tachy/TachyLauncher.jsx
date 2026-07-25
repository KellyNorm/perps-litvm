import { useEffect, useRef, useState } from "react";
import TachyAvatar from "./TachyAvatar.jsx";
import TachyPanel from "./TachyPanel.jsx";
import { useTachyChat } from "../../lib/tachy/useTachyChat.js";
import "../../styles/tachy.css";

// Tachy's mount point: a floating mascot that sits above both products and belongs to
// neither.
//
// ISOLATION — the same contract Shell.jsx states for the two apps applies here:
//  1. Nothing in this subtree imports perps or prediction LOGIC. The one thing it does
//     import from another tree is EyesMascot (via TachyAvatar), read-only, unmodified.
//  2. It renders no prices, holds no wallet, signs nothing. There is no money path to
//     get wrong: the endpoint's response schema has no field that could carry an action.
//  3. `view` comes in as a prop from Shell. Tachy does not reach into either app to ask
//     what mode it is in, so neither app needs to know Tachy exists.
//
// BOTTOM-LEFT, not bottom-right, and that is not an aesthetic choice: bottom-right is
// already occupied in both products — `.pm-modeswitch` (fixed, right:22 bottom:22) and
// perps' `.rpc-reconnect` (right:16 bottom:14). Moving Tachy there would cover the app
// switcher. If the switcher ever moves into the nav, this can be reconsidered.
//
// Chat state lives HERE rather than in the panel, so closing Tachy keeps the thread.

export default function TachyLauncher({ view = "perps" }) {
  const [open, setOpen] = useState(false);
  const { messages, pending, send, reset } = useTachyChat(view);
  const fabRef = useRef(null);

  // Escape closes, and focus goes back to the button that opened it — otherwise focus is
  // orphaned on a removed node and keyboard users land back at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        fabRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="tachy-root">
      {open && (
        <TachyPanel
          view={view}
          messages={messages}
          pending={pending}
          onSend={send}
          onClear={reset}
          onClose={() => {
            setOpen(false);
            fabRef.current?.focus();
          }}
        />
      )}

      <button
        ref={fabRef}
        type="button"
        className={`tachy-fab ${open ? "is-open" : ""} ${pending ? "is-thinking" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close Tachy" : "Ask Tachy"}
      >
        {/* Cursor tracking stays on while the panel is open — the mascot watching the
            pointer is the whole character, and it costs one pointermove listener. */}
        <TachyAvatar size={54} expression={pending ? "thinking" : "calm"} />
        <span className="tachy-fab-hint" aria-hidden="true">
          Ask Tachy
        </span>
      </button>
    </div>
  );
}
