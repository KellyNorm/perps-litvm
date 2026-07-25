// In-character fallbacks. The rule this module exists to enforce: a user NEVER sees a
// raw provider error, a stack trace, or an HTTP status string from Gemini. Every
// failure resolves to something Tachy would plausibly say.
//
// KNOWN LIMITATION (v2): these strings are English-only. A Spanish-speaking user who
// hits a Gemini outage gets an English apology. Localising them needs either a
// pre-translated table per supported language or a model call — and a model call is by
// definition the thing that just failed. Accepted for v1.

export const REASON = {
  UPSTREAM_RATE_LIMIT: "upstream_rate_limit",
  UPSTREAM_ERROR: "upstream_error",
  TIMEOUT: "timeout",
  INVALID_RESPONSE: "invalid_response",
  BLOCKED: "blocked",
  NOT_CONFIGURED: "not_configured",
};

const MESSAGES = {
  [REASON.UPSTREAM_RATE_LIMIT]:
    "I'm getting a lot of questions right now and need a breather. Try me again in a moment.",
  [REASON.UPSTREAM_ERROR]:
    "My brain's buffering — something went wrong on my side. Give it another go in a moment.",
  [REASON.TIMEOUT]: "That one took me too long to think through. Mind asking again?",
  [REASON.INVALID_RESPONSE]:
    "I didn't quite catch that one. Could you rephrase it for me?",
  [REASON.BLOCKED]:
    "I can't help with that one, sorry. Ask me about how perps or predictions work and I'm all yours.",
  [REASON.NOT_CONFIGURED]:
    "I'm not quite awake yet — my connection isn't set up. The team's been told.",
};

const DEFAULT_MESSAGE = MESSAGES[REASON.UPSTREAM_ERROR];

// Client-error messages. Separate from the list above because these ARE the user's
// doing, and saying so plainly is more useful than a generic apology.
export const CLIENT_MESSAGES = {
  tooLong: "That's a lot to read in one go — could you trim it down and ask me again?",
  rateLimited:
    "Whoa, slow down! I need a second to keep up. Try me again in a few seconds.",
  badRequest: "Something about that message didn't come through right. Mind trying again?",
};

// Shaped exactly like a validated model reply so the handler can return it through the
// same envelope with no branching downstream. `knowsAnswer: false` is honest here: a
// fallback is by definition Tachy not answering the question.
export function fallbackReply(reason) {
  return {
    explanation: MESSAGES[reason] ?? DEFAULT_MESSAGE,
    clarificationQuestion: null,
    language: "en",
    knowsAnswer: false,
  };
}

export function clientReply(text) {
  return {
    explanation: text,
    clarificationQuestion: null,
    language: "en",
    knowsAnswer: false,
  };
}
