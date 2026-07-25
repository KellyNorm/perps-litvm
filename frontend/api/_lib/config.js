// Server-side Tachy config. NOTHING in this module reaches the browser: it lives
// under `api/`, which Vercel builds as a serverless function, not as part of the
// Vite bundle. `GEMINI_API_KEY` is deliberately NOT `VITE_`-prefixed — Vite only
// exposes `VITE_*` to client code, so the name itself is the guard against the key
// ever being bundled.
//
// Every value is read lazily inside a function rather than at module scope, so unit
// tests can set `process.env` per case without fighting the ESM module cache.

// Pinned to a stable Flash id rather than the `gemini-flash-latest` alias: that alias
// tracks preview and experimental releases, and an assistant whose behaviour can shift
// under a live app without a deploy is a debugging trap. Override via TACHY_MODEL to
// move deliberately.
export const DEFAULT_MODEL = "gemini-3.6-flash";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function apiKey() {
  return (process.env.GEMINI_API_KEY || "").trim();
}

export function modelId() {
  return (process.env.TACHY_MODEL || DEFAULT_MODEL).trim();
}

// Held under the function's `maxDuration` (10s in vercel.json) so we time out and
// return an in-character fallback rather than letting the platform kill the
// invocation, which would surface to the browser as a raw 504.
export function geminiTimeoutMs() {
  return positiveInt(process.env.TACHY_TIMEOUT_MS, 8500);
}

export function limits() {
  return {
    // Per-request input caps. Enforced server-side because a client-side cap is a
    // suggestion.
    maxMessageChars: positiveInt(process.env.TACHY_MAX_CHARS, 1000),
    maxHistoryTurns: positiveInt(process.env.TACHY_MAX_TURNS, 8),
    maxTotalChars: positiveInt(process.env.TACHY_MAX_TOTAL_CHARS, 6000),
    maxBodyBytes: positiveInt(process.env.TACHY_MAX_BODY_BYTES, 16 * 1024),

    // Rate limit, per client IP.
    //
    // Held UNDER the upstream quota on purpose. The Gemini free tier allows 5
    // generate_content requests/minute for gemini-3.6-flash, so a per-IP allowance of 8
    // could not protect it even from one user — we would simply forward the overflow and
    // burn quota to receive 429s. See the note in .env.example about the global-vs-per-IP
    // gap, which raising the paid tier is the real fix for.
    perMinute: positiveInt(process.env.TACHY_RPM, 4),
    perHour: positiveInt(process.env.TACHY_RPH, 60),
  };
}

// Caps the model's own output so a runaway generation can't blow the timeout or the
// token budget.
//
// Sized with headroom rather than tightly: this budget is shared with the model's
// thinking tokens, and a cap that is merely "enough for the answer" truncates the JSON
// the moment the model thinks at all (see the thinkingConfig note in gemini.js). With
// thinking at "minimal" a reply measures ~150 tokens, so this is ~8x headroom and the
// cap only ever catches genuine runaways.
export function maxOutputTokens() {
  return positiveInt(process.env.TACHY_MAX_OUTPUT_TOKENS, 1200);
}
