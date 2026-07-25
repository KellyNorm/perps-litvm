// Request normalisation and input caps. Split out of the handler so the caps are unit
// testable without spinning up a server or stubbing Gemini.
//
// Everything here runs BEFORE the provider call. That ordering is the point: a cap that
// runs after the spend protects nothing.

const VALID_VIEWS = new Set(["perps", "predictions"]);
const VALID_ROLES = new Set(["user", "tachy"]);

// Identifies the caller for rate limiting. Vercel sets x-forwarded-for at the edge.
//
// The client may also send a session id, but it is NOT used here and must never be:
// it is client-controlled, so anyone rate-limited could mint a fresh one and walk
// straight past the limiter. IP is imperfect (shared NATs, VPN hopping) but it is at
// least not chosen by the person being limited.
export function clientKey(req) {
  const xff = req.headers?.["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0].trim() : "";
  return first || req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function sanitizeLocale(raw) {
  if (typeof raw !== "string") return null;
  // BCP-47 shapes only. Anything else is either a mistake or an injection attempt, and
  // this string is interpolated into the system instruction.
  const match = raw.trim().match(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/);
  return match ? match[0] : null;
}

// Returns { ok: true, value } or { ok: false, status, reason }.
export function normalizeBody(rawBody, limits) {
  let body = rawBody;

  // Vercel parses JSON bodies automatically, but only when the content-type says so.
  // A client that forgets the header would otherwise get a confusing 400.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, reason: "unparseable_body" };
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }

  if (typeof body.message !== "string") {
    return { ok: false, status: 400, reason: "missing_message" };
  }

  const message = body.message.trim();
  if (!message) return { ok: false, status: 400, reason: "empty_message" };

  // 413 rather than a silent truncation: the user should know their question was not
  // fully read, instead of getting an answer to the first 1000 characters of it.
  if (message.length > limits.maxMessageChars) {
    return { ok: false, status: 413, reason: "message_too_long" };
  }

  let history = Array.isArray(body.history) ? body.history : [];

  history = history
    .filter(
      (turn) =>
        turn &&
        typeof turn === "object" &&
        VALID_ROLES.has(turn.role) &&
        typeof turn.text === "string" &&
        turn.text.trim(),
    )
    .map((turn) => ({
      role: turn.role,
      text: turn.text.trim().slice(0, limits.maxMessageChars),
    }))
    .slice(-limits.maxHistoryTurns);

  // Both providers expect the conversation to open on a user turn.
  while (history.length && history[0].role === "tachy") history.shift();

  // Total-size cap. History is dropped oldest-first rather than 413'd, because a long
  // conversation is the user behaving normally — unlike a single oversized message.
  // The message itself is already capped above, so this always terminates.
  let total = message.length + history.reduce((n, t) => n + t.text.length, 0);
  while (history.length && total > limits.maxTotalChars) {
    total -= history[0].text.length;
    history.shift();
    while (history.length && history[0].role === "tachy") {
      total -= history[0].text.length;
      history.shift();
    }
  }

  return {
    ok: true,
    value: {
      message,
      history,
      locale: sanitizeLocale(body.locale),
      // Allowlisted, not passed through: this string reaches the system instruction.
      view: VALID_VIEWS.has(body.view) ? body.view : null,
    },
  };
}

// Maps our wire format to the PROVIDER-NEUTRAL conversation shape the drivers consume:
// [{ role: "user" | "model", text }]. Our "tachy" role becomes "model" here; each
// driver renames it again if its API disagrees (Groq's OpenAI-compatible API calls it
// "assistant"). Nothing above the driver layer knows any provider's wire format.
export function buildTurns({ message, history }) {
  return [
    ...history.map((turn) => ({
      role: turn.role === "tachy" ? "model" : "user",
      text: turn.text,
    })),
    { role: "user", text: message },
  ];
}
