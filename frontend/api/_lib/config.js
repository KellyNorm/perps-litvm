// Server-side Tachy config. NOTHING in this module reaches the browser: it lives
// under `api/`, which Vercel builds as a serverless function, not as part of the
// Vite bundle. Provider API keys are deliberately NOT `VITE_`-prefixed — Vite only
// exposes `VITE_*` to client code, so the name itself is the guard against a key
// ever being bundled.
//
// Every value is read lazily inside a function rather than at module scope, so unit
// tests can set `process.env` per case without fighting the ESM module cache.
//
// Provider-SPECIFIC settings (model id, endpoint, tier limits, API key) do not live
// here — they belong to the driver that has to be right about them, under
// ./providers/. This module applies env overrides on top of whichever driver it is
// handed.
//
// It deliberately does NOT import the provider registry, and provider selection lives
// in providers/index.js instead. The drivers depend on this module (maxOutputTokens),
// so a dependency the other way would be a cycle — and an ESM cycle here fails at
// import time with a TDZ error, i.e. the whole endpoint 500s on cold start. Every
// function below takes the active provider as an argument for that reason.

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// TACHY_MODEL overrides the selected provider's pinned default. It is NOT
// provider-namespaced on purpose: one deploy runs one provider, and a per-provider
// model var would let a stale override for the inactive provider sit in the
// environment looking meaningful.
export function modelId(activeProvider) {
  return (process.env.TACHY_MODEL || activeProvider.defaultModel).trim();
}

// Held under the function's `maxDuration` (10s in vercel.json) so we time out and
// return an in-character fallback rather than letting the platform kill the
// invocation, which would surface to the browser as a raw 504.
export function providerTimeoutMs() {
  return positiveInt(process.env.TACHY_TIMEOUT_MS, 8500);
}

export function limits(activeProvider) {
  return {
    // Per-request input caps. Enforced server-side because a client-side cap is a
    // suggestion. Provider-independent: they bound what a caller can send us, which
    // has nothing to do with who we forward it to.
    maxMessageChars: positiveInt(process.env.TACHY_MAX_CHARS, 1000),
    maxHistoryTurns: positiveInt(process.env.TACHY_MAX_TURNS, 8),
    maxTotalChars: positiveInt(process.env.TACHY_MAX_TOTAL_CHARS, 6000),
    maxBodyBytes: positiveInt(process.env.TACHY_MAX_BODY_BYTES, 16 * 1024),

    // Rate limit, per client IP. The defaults come from the active provider, because
    // the number that matters is that provider's real free-tier ceiling — see the
    // sizing notes in providers/gemini.js and providers/groq.js. Both sit UNDER the
    // upstream quota: a limiter above it would forward the overflow and burn quota to
    // collect 429s.
    perMinute: positiveInt(process.env.TACHY_RPM, activeProvider.defaultRpm),
    perHour: positiveInt(process.env.TACHY_RPH, activeProvider.defaultRph),
  };
}

// Caps the model's own output so a runaway generation can't blow the timeout or the
// token budget.
//
// Sized with headroom rather than tightly: on providers where the budget is shared with
// thinking/reasoning tokens, a cap that is merely "enough for the answer" truncates the
// JSON the moment the model thinks at all (see the thinkingConfig note in
// providers/gemini.js). A reply measures ~150 tokens, so this is ~8x headroom and the
// cap only ever catches genuine runaways.
export function maxOutputTokens() {
  return positiveInt(process.env.TACHY_MAX_OUTPUT_TOKENS, 1200);
}
