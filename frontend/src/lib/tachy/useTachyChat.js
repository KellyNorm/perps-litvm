import { useCallback, useRef, useState } from "react";
import { askTachy } from "./askTachy.js";

// Conversation state for one Tachy session.
//
// Lives in TachyLauncher, NOT in TachyPanel, so closing the panel does not throw the
// thread away — a user who closes Tachy to look at a chart and reopens it finds their
// conversation where they left it. The panel is a pure view over this.
//
// No persistence across reloads. Deliberate for v1: a chat log in localStorage is a
// small privacy surface for zero benefit at this stage.

let nextId = 0;

export function useTachyChat(view) {
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);

  // A ref, not `pending`, because `send` must be able to reject a re-entrant call in the
  // same tick — before React has re-rendered with the new state. Double-submit here
  // would cost a provider call and eat into the rate limit.
  const inFlight = useRef(false);

  // Read at call time rather than captured in the closure, so a send that starts just
  // after the user flips perps↔predictions still reports the view they were actually
  // looking at when they hit enter.
  const viewRef = useRef(view);
  viewRef.current = view;

  const send = useCallback(async (raw) => {
    const text = String(raw ?? "").trim();
    if (!text || inFlight.current) return;

    inFlight.current = true;
    setPending(true);

    // History is taken from the state at send time, and the user's own turn is appended
    // in the same updater — so what goes upstream is exactly what the thread shows, with
    // no window where the two disagree.
    let history = [];
    setMessages((prev) => {
      history = prev.map((m) => ({ role: m.role, text: m.text }));
      return [...prev, { id: `u${nextId++}`, role: "user", text }];
    });

    let result;
    try {
      result = await askTachy({ message: text, view: viewRef.current, history });
    } catch {
      // askTachy only throws on abort, which v1 never triggers. Belt and braces: an
      // exception escaping here would leave `pending` stuck true and the input dead.
      result = null;
    }

    setMessages((prev) => [
      ...prev,
      result
        ? {
            id: `t${nextId++}`,
            role: "tachy",
            text: result.reply.explanation,
            clarification: result.reply.clarificationQuestion,
            language: result.reply.language,
            fallback: result.fallback,
          }
        : {
            id: `t${nextId++}`,
            role: "tachy",
            text: "I'm a bit slow right now — try me again in a moment.",
            clarification: null,
            language: "en",
            fallback: true,
          },
    ]);

    inFlight.current = false;
    setPending(false);
  }, []);

  const reset = useCallback(() => {
    if (inFlight.current) return;
    setMessages([]);
  }, []);

  return { messages, pending, send, reset };
}
