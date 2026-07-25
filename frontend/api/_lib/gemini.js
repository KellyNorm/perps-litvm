// Gemini client. Raw `fetch` rather than the @google/genai SDK: this is one POST with a
// JSON body, and a serverless function pays for every dependency in cold-start time.
// Node 22 (see package.json engines, and Vercel's runtime) has fetch and
// AbortSignal.timeout natively, so this module has zero dependencies.
//
// API shape verified against ai.google.dev/api/generate-content:
//   POST /v1beta/models/{model}:generateContent
//   body: { contents[], systemInstruction, generationConfig }
//   text: candidates[0].content.parts[].text
//
// The contract with callers: this NEVER throws and NEVER returns provider error text.
// It returns { ok: true, text } or { ok: false, reason } where reason is a REASON code.
// Diagnostics go to the server log, not to the response.

import { GEMINI_ENDPOINT, maxOutputTokens } from "./config.js";
import { REASON } from "./fallbacks.js";
import { TACHY_RESPONSE_SCHEMA } from "./schema.js";

export async function callGemini({
  apiKey,
  model,
  systemInstruction,
  contents,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) {
    // Loud, because this is a deploy misconfiguration and silent degradation would hide
    // it behind a friendly mascot message for as long as nobody checks.
    console.error("[tachy] GEMINI_API_KEY is not set — every request will fall back.");
    return { ok: false, reason: REASON.NOT_CONFIGURED };
  }

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      // Gate 1 of the validation layer: constrain generation to our schema so
      // well-formed JSON is the default. Gate 2 (schema.js) re-checks it regardless.
      responseMimeType: "application/json",
      responseSchema: TACHY_RESPONSE_SCHEMA,
      maxOutputTokens: maxOutputTokens(),
      // Low but not zero: explanations should be stable and factual, with just enough
      // variation that repeat questions don't read like a canned FAQ.
      temperature: 0.4,
      // REQUIRED, not an optimisation. Gemini 3.x thinks by default and thinking tokens
      // are charged against maxOutputTokens — measured at 572 thoughts vs 9 answer
      // tokens against a 600 cap, which truncated the JSON mid-string and made Gate 2
      // reject perfectly good answers. Worse, it was content-dependent: short answers
      // survived and longer or non-English ones did not, so it read as flakiness.
      // "minimal" takes thinking to 0 tokens. Verified against the live API; note that
      // the 2.5-era `thinkingBudget: 0` is rejected with HTTP 400 on 3.x.
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };

  let res;
  try {
    res = await fetchImpl(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      // Key travels in a header, not the `?key=` query param the docs also allow —
      // query strings leak into access logs, proxies and error traces.
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with TimeoutError; a manual abort gives AbortError.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    console.error(`[tachy] gemini ${timedOut ? "timeout" : "network error"}: ${err?.name}`);
    return { ok: false, reason: timedOut ? REASON.TIMEOUT : REASON.UPSTREAM_ERROR };
  }

  if (!res.ok) {
    // Body is read for the log only. It never travels back to the browser.
    const detail = await safeText(res);
    console.error(`[tachy] gemini HTTP ${res.status}: ${detail}`);
    return {
      ok: false,
      reason: res.status === 429 ? REASON.UPSTREAM_RATE_LIMIT : REASON.UPSTREAM_ERROR,
    };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[tachy] gemini returned unparseable JSON envelope");
    return { ok: false, reason: REASON.UPSTREAM_ERROR };
  }

  // Safety filtering can drop the prompt outright, in which case there are no
  // candidates at all — distinct from a malformed answer, and worth its own message.
  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    console.warn(`[tachy] prompt blocked upstream: ${blockReason}`);
    return { ok: false, reason: REASON.BLOCKED };
  }

  const candidate = payload?.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST"].includes(finish)) {
    console.warn(`[tachy] candidate suppressed: ${finish}`);
    return { ok: false, reason: REASON.BLOCKED };
  }

  // Parts can legitimately be split; join the text ones. A MAX_TOKENS finish leaves
  // truncated JSON here, which Gate 2 rejects — that path lands on INVALID_RESPONSE,
  // which is the correct user-facing outcome anyway.
  const text = (candidate?.content?.parts ?? [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!text) {
    console.error(`[tachy] gemini returned no text (finishReason=${finish ?? "none"})`);
    return { ok: false, reason: REASON.INVALID_RESPONSE };
  }

  return { ok: true, text };
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
