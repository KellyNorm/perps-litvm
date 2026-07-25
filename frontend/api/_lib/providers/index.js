// Provider registry. Tachy's model backend is swappable so the safety rails can be
// re-validated against a different vendor without touching the rails themselves —
// which is the whole point of the split: if a rail only holds on one provider, it was
// never a rail, it was that model being agreeable.
//
// THE CONTRACT every driver implements:
//
//   id            string, matches its TACHY_PROVIDER value
//   keyEnv        name of the env var holding its API key (for diagnostics only)
//   defaultModel  pinned model id, overridable via TACHY_MODEL
//   defaultRpm    per-IP requests/minute, sized against that provider's real free tier
//   defaultRph    per-IP requests/hour
//   apiKey()      reads the key from process.env, lazily
//   generate({ apiKey, model, systemInstruction, turns, timeoutMs, fetchImpl })
//                 -> { ok: true, text } | { ok: false, reason }
//
// `generate` NEVER throws and NEVER returns provider error text. `reason` is always a
// REASON code from fallbacks.js. Diagnostics go to the server log, not the response.
//
// `turns` is the provider-neutral conversation shape from request.js — [{ role, text }]
// with role "user" | "model". Each driver maps it to its own wire format; nothing
// upstream of here knows what that format is.

import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";

const PROVIDERS = {
  [geminiProvider.id]: geminiProvider,
  [groqProvider.id]: groqProvider,
};

// Groq is the default for the soft launch, and the reason is CONCURRENCY, not quality.
// Both drivers pass the same rails with the same clean JSON (37/37 live samples, 0%
// malformed — see scripts/tachy-json-audit.mjs). What separates them is what an early
// user actually hits: Gemini's free tier is 5 requests/minute GLOBAL, so two people
// chatting at once both get fallback messages and the app reads as broken. Groq's
// budget allows ~7-8/min, which absorbs that.
//
// This is a soft-launch choice with a hard ceiling behind it — Groq's free tier is
// capped at ~65 exchanges/DAY, which is a demo allowance, not a launch allowance. See
// .env.example: a paid tier is a pre-scale requirement on either provider.
//
// Gemini remains fully supported and is one env var away (TACHY_PROVIDER=gemini).
export const DEFAULT_PROVIDER = groqProvider.id;

// Which model backend serves this deploy, from TACHY_PROVIDER. Read lazily, like
// everything else in config.js, so tests can set env per case.
export function activeProvider() {
  return selectProvider(process.env.TACHY_PROVIDER || DEFAULT_PROVIDER);
}

export function selectProvider(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return PROVIDERS[DEFAULT_PROVIDER];

  const provider = PROVIDERS[key];
  if (provider) return provider;

  // Loud and then continue on the default. A typo'd provider name is a deploy mistake,
  // and falling back silently would mean serving a whole deploy from the wrong model
  // with nothing in the logs to say so.
  console.error(
    `[tachy] unknown TACHY_PROVIDER "${key}"; falling back to ${DEFAULT_PROVIDER}. ` +
      `Known providers: ${Object.keys(PROVIDERS).join(", ")}`,
  );
  return PROVIDERS[DEFAULT_PROVIDER];
}

export { geminiProvider, groqProvider };
