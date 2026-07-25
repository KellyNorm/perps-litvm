import { useEffect, useRef, useState } from "react";
import TachyAvatar from "./TachyAvatar.jsx";
import { MAX_MESSAGE_CHARS } from "../../lib/tachy/askTachy.js";

// The chat surface. A pure view over the state TachyLauncher owns — it holds only its
// own draft text, so unmounting it on close loses nothing but the half-typed line.
//
// Starter questions are view-aware: the endpoint already gets `view` for grounding, so
// offering a trader chips about liquidations and a predictions user chips about pools
// costs nothing and makes the first click land somewhere useful. "Perps vs predictions?"
// appears in both — it is the question the two-product shell actually provokes.
const CHIPS = {
  perps: ["What's leverage?", "How do liquidations work?", "Perps vs predictions?"],
  predictions: ["How do prediction markets work?", "What's a parimutuel pool?", "Perps vs predictions?"],
};

export default function TachyPanel({ view, messages, pending, onSend, onClose }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const threadRef = useRef(null);

  // Focus the input on open. Tachy is opened in order to type; making that the first
  // thing that works saves a click every single time.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Pin the thread to the bottom as it grows, including while the thinking bubble is up
  // — otherwise a long answer scrolls in below the fold and reads as no answer at all.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const submit = (text) => {
    const value = String(text ?? "").trim();
    if (!value || pending) return;
    setDraft("");
    onSend(value);
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter breaks the line. Standard for a chat box, and the
    // textarea exists (rather than an input) precisely so the second half is possible.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  const empty = messages.length === 0;

  return (
    // aria-modal is false on purpose: Tachy does not trap focus or block the app behind
    // it. A trader must be able to tab straight back to their order ticket mid-question.
    <div className="tachy-panel" role="dialog" aria-modal="false" aria-label="Ask Tachy">
      <header className="tachy-panel-head">
        <TachyAvatar size={30} expression={pending ? "thinking" : "calm"} track={false} />
        <div className="tachy-panel-id">
          <span className="tachy-panel-name">Tachy</span>
          <span className="tachy-panel-role">Explains things · not financial advice</span>
        </div>
        <button type="button" className="tachy-x" onClick={onClose} aria-label="Close Tachy">
          ×
        </button>
      </header>

      {/* polite, not assertive: replies should be announced when the screen reader is
          free, never interrupt what the user is already listening to. */}
      <div className="tachy-thread" ref={threadRef} aria-live="polite" aria-busy={pending}>
        {empty && (
          <div className="tachy-greeting">
            <p className="tachy-greeting-line">Hey trader, what can we do for you?</p>
            <p className="tachy-greeting-sub">
              Ask me anything about how this place works — in whatever language you like.
            </p>
            <div className="tachy-chips">
              {(CHIPS[view] ?? CHIPS.perps).map((chip) => (
                <button key={chip} type="button" className="tachy-chip" onClick={() => submit(chip)} disabled={pending}>
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="tachy-msg tachy-msg-user">
              {/* dir="auto" on every rendered turn: this thing answers in the user's
                  language, and an Arabic or Hebrew answer laid out left-to-right is
                  unreadable. The browser infers direction from the first strong
                  character, which is exactly the right rule here. */}
              <p className="tachy-bubble" dir="auto">
                {m.text}
              </p>
            </div>
          ) : (
            <div key={m.id} className="tachy-msg tachy-msg-tachy">
              <TachyAvatar size={26} expression={m.fallback ? "sorry" : "calm"} track={false} className="tachy-msg-face" />
              <div className="tachy-msg-body">
                {/* `lang` so screen readers switch voice, and so :lang() styling stays
                    possible later. The value is the model's own report of what it wrote
                    in, clamped server-side to 12 chars. */}
                <p
                  className={`tachy-bubble ${m.fallback ? "is-fallback" : ""}`}
                  dir="auto"
                  lang={m.language || undefined}
                >
                  {m.text}
                </p>
                {m.clarification && (
                  <p className="tachy-clarify" dir="auto" lang={m.language || undefined}>
                    {m.clarification}
                  </p>
                )}
              </div>
            </div>
          ),
        )}

        {pending && (
          <div className="tachy-msg tachy-msg-tachy">
            <TachyAvatar size={26} expression="thinking" track={false} className="tachy-msg-face" />
            <div className="tachy-msg-body">
              <p className="tachy-bubble tachy-thinking">
                <span className="tachy-dot" />
                <span className="tachy-dot" />
                <span className="tachy-dot" />
                <span className="tachy-sr">Tachy is thinking</span>
              </p>
            </div>
          </div>
        )}
      </div>

      <form
        className="tachy-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <textarea
          ref={inputRef}
          className="tachy-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Tachy anything…"
          rows={1}
          // Matches the server's TACHY_MAX_CHARS. Stopping the user at the boundary is
          // kinder than letting them write 1,200 characters and answering with a 413.
          maxLength={MAX_MESSAGE_CHARS}
          aria-label="Your question for Tachy"
          disabled={pending}
        />
        <button type="submit" className="tachy-send" disabled={pending || !draft.trim()} aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  );
}
