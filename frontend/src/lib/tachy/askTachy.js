// The browser's only contact point with /api/tachy.
//
// THE ONE RULE THIS MODULE ENFORCES: it never throws and never resolves to anything the
// UI has to interpret. Every outcome — a good answer, a 429, a provider outage, a dead
// network, an HTML page served by a dev server that has no /api route — comes back as
// the same `{ reply, fallback, reason }` shape, with `reply.explanation` always a
// non-empty string that is safe to render verbatim. That is what makes "never show a raw
// error" a property of the code rather than a thing the components have to remember.
//
// The server already guarantees a uniform envelope on every status (see api/tachy.js
// `send`), so this module's real job is the cases the server never sees: the request
// that never arrived, and the response that isn't ours.

export const TACHY_ENDPOINT = "/api/tachy";

// Mirrors TACHY_MAX_TURNS on the server. Trimmed here too — not for safety (the server
// re-trims and is the only enforcement that counts) but to avoid paying to upload
// history that will be discarded on arrival.
export const MAX_HISTORY_TURNS = 8;

// Mirrors TACHY_MAX_CHARS. The input uses this as a maxLength so the user is stopped at
// the boundary rather than being 413'd after they finish typing.
export const MAX_MESSAGE_CHARS = 1000;

// Reasons this module invents, for cases that never reached the handler. Kept distinct
// from the server's REASON codes so telemetry can tell "provider fell over" apart from
// "the request never landed".
export const CLIENT_REASON = {
  NETWORK: "client_network",
  UNREADABLE: "client_unreadable_response",
};

// Deliberately in Tachy's voice, and deliberately vague about the cause: the user does
// not care whether it was DNS, CORS, or a missing dev route, and telling them would be
// the raw error by another name. The specifics go in `reason`, for logs.
function offlineReply() {
  return {
    explanation: "I'm a bit slow right now — try me again in a moment.",
    clarificationQuestion: null,
    language: "en",
    knowsAnswer: false,
  };
}

function degraded(reason) {
  return { reply: offlineReply(), fallback: true, reason };
}

// Accepts only what the server's allowlist accepts. Anything else is dropped rather
// than corrected, because a `view` the server doesn't recognise is silently ignored
// there anyway and sending it just makes the two ends disagree about what was asked.
const VALID_VIEWS = new Set(["perps", "predictions"]);

function browserLocale() {
  const raw = typeof navigator !== "undefined" ? navigator.language : null;
  // The server re-validates this against a BCP-47 shape and nulls anything odd; this is
  // just to avoid sending obvious junk.
  return typeof raw === "string" && raw ? raw : null;
}

/**
 * Ask Tachy a question.
 *
 * `fetchImpl` and `endpoint` are injectable purely so the tests can drive every branch
 * without a network or a DOM.
 *
 * Resolves to `{ reply, fallback, reason }`:
 *   reply    — always `{ explanation, clarificationQuestion, language, knowsAnswer }`
 *              with a renderable `explanation`.
 *   fallback — true whenever this is NOT a real answer to the question: the server said
 *              so via `meta.fallback`, or it returned a non-200 (rate limited, too long,
 *              rejected), or we never got a usable response at all. One flag, because
 *              the UI treats all three identically — subdued bubble, offer to retry.
 *   reason   — short code for logs. Never provider text, never shown to the user.
 */
export async function askTachy({
  message,
  view,
  history = [],
  locale = browserLocale(),
  signal,
  fetchImpl,
  endpoint = TACHY_ENDPOINT,
} = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!doFetch) return degraded(CLIENT_REASON.NETWORK);

  const body = {
    message: String(message ?? ""),
    history: trimHistory(history),
    ...(VALID_VIEWS.has(view) ? { view } : {}),
    ...(locale ? { locale } : {}),
  };

  let res;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Includes the user aborting. Re-thrown for aborts only, so a cancelled request does
    // not land in the thread as a failure message the user didn't cause.
    if (err?.name === "AbortError") throw err;
    return degraded(CLIENT_REASON.NETWORK);
  }

  // `res.json()` rather than trusting content-type: a dev server with no /api route
  // answers a POST with the SPA's index.html and a 200, which would otherwise sail
  // through every check below and blow up on a property access.
  let data;
  try {
    data = await res.json();
  } catch {
    return degraded(CLIENT_REASON.UNREADABLE);
  }

  const reply = data?.reply;
  if (!reply || typeof reply.explanation !== "string" || !reply.explanation.trim()) {
    return degraded(CLIENT_REASON.UNREADABLE);
  }

  return {
    // Rebuilt field by field, not spread: the same reason the server does it. Whatever
    // else is in that object has no path into the component tree.
    reply: {
      explanation: reply.explanation.trim(),
      clarificationQuestion:
        typeof reply.clarificationQuestion === "string" && reply.clarificationQuestion.trim()
          ? reply.clarificationQuestion.trim()
          : null,
      language: typeof reply.language === "string" && reply.language.trim() ? reply.language.trim() : "en",
      knowsAnswer: reply.knowsAnswer !== false,
    },
    // A 429 arrives with `meta.fallback: false` — it is a client error, not a provider
    // failure — but from the user's side it is still "no answer this time", so the
    // status check has to be part of this flag rather than a second one the UI branches
    // on.
    fallback: data?.meta?.fallback === true || !res.ok,
    reason: data?.meta?.reason ?? (res.ok ? null : `http_${res.status}`),
  };
}

// Keeps the newest turns and guarantees the slice opens on a user turn, matching what
// the server does. Sending a leading model turn is not fatal (the server drops it) but
// it wastes a slot out of the eight.
export function trimHistory(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === "user" || t.role === "tachy") && typeof t.text === "string" && t.text.trim())
    .map((t) => ({ role: t.role, text: t.text.trim() }))
    .slice(-MAX_HISTORY_TURNS);

  while (turns.length && turns[0].role === "tachy") turns.shift();
  return turns;
}
