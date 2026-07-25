// Groq driver. OpenAI-compatible chat completions, so nothing about the wire format is
// shared with the Gemini driver beyond the contract in ./index.js.
//
// API shape verified against console.groq.com/docs/api-reference and live calls:
//   POST https://api.groq.com/openai/v1/chat/completions
//   auth: Authorization: Bearer <key>
//   body: { model, messages[{role,content}], response_format, max_completion_tokens }
//   text: choices[0].message.content
//
// THE STRUCTURED-OUTPUT GAP (measured 2026-07-25, this is the important part):
// Groq supports strict schema-constrained decoding ONLY on the GPT-OSS models. Every
// Llama model — including llama-3.3-70b-versatile — rejects `response_format:
// json_schema` outright with HTTP 400 ("This model does not support response format
// `json_schema`"). Llama gets `json_object`, which guarantees syntactically valid JSON
// but enforces NO schema: field names, types and nullability are left to the prompt.
//
// So Gate 1 is materially weaker here than on Gemini, where responseSchema is a real
// decoding constraint. Two consequences, both handled below:
//   1. supportsStrictSchema() picks the strongest mode the chosen model actually has,
//      so pointing TACHY_MODEL at a GPT-OSS model upgrades Gate 1 with no code change.
//   2. Under json_object the schema is appended to the system message as prose
//      (schemaInstruction), because a shape nobody states is a shape the model invents.
// Gate 2 (schema.js) is unchanged and unconditional either way — it rebuilds the reply
// field by field regardless of which provider or mode produced it.

import { maxOutputTokens } from "../config.js";
import { REASON } from "../fallbacks.js";
import { TACHY_JSON_SCHEMA, schemaInstruction } from "../schema.js";

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// The largest Llama available on this account (verified against GET /openai/v1/models:
// the list is llama-3.3-70b-versatile and llama-3.1-8b-instant — no Llama 4 tier).
// 70B rather than 8B because instruction-following under a long system prompt is
// exactly where the small model degrades, and every rail here is an instruction.
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// Free-tier limits for llama-3.3-70b-versatile, cross-checked against the docs table
// and this key's live x-ratelimit-* headers (2026-07-25):
//   RPM 30 | RPD 1,000 | TPM 12,000 | TPD 100,000
//
// RPM IS NOT THE BINDING LIMIT. A Tachy call costs ~1,430 prompt tokens (the system
// instruction is long) plus ~60-250 completion, so TPM 12,000 runs out at roughly 7-8
// requests/minute — well before the 30 RPM ceiling. Hence 7, not 30: a limiter set to
// the headline RPM would forward the overflow and collect 429s.
//
// The TPD 100,000 ceiling is the harsher one: ~65 exchanges per DAY, key-global, which
// a per-IP limiter cannot enforce at all. Same structural caveat as Gemini's global cap
// — see .env.example.
const DEFAULT_RPM = 7;
const DEFAULT_RPH = 60;

export const groqProvider = {
  id: "groq",
  keyEnv: "GROQ_API_KEY",
  defaultModel: DEFAULT_MODEL,
  defaultRpm: DEFAULT_RPM,
  defaultRph: DEFAULT_RPH,

  apiKey() {
    return (process.env.GROQ_API_KEY || "").trim();
  },

  generate: callGroq,
};

// Strict mode is a property of the model, not the account. Prefix match because the
// whole GPT-OSS family supports it (120b, 20b, safeguard-20b) and nothing else does.
export function supportsStrictSchema(model) {
  return String(model ?? "").startsWith("openai/gpt-oss");
}

export async function callGroq({
  apiKey,
  model,
  systemInstruction,
  turns,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) {
    // Loud, for the same reason as the Gemini driver: a missing key otherwise hides
    // behind a friendly mascot message until somebody happens to read the logs.
    console.error("[tachy] GROQ_API_KEY is not set — every request will fall back.");
    return { ok: false, reason: REASON.NOT_CONFIGURED };
  }

  const strict = supportsStrictSchema(model);

  const body = {
    model,
    messages: toMessages(turns, systemInstruction, strict),
    response_format: strict
      ? {
          type: "json_schema",
          json_schema: { name: "tachy_reply", strict: true, schema: TACHY_JSON_SCHEMA },
        }
      : // Guarantees syntactically valid JSON, nothing more. Note Groq inherits OpenAI's
        // requirement that the word "json" appear in the messages for this mode — the
        // system prompt satisfies it, and schemaInstruction() does again.
        { type: "json_object" },
    // Groq's current field name; `max_tokens` is deprecated on this API.
    max_completion_tokens: maxOutputTokens(),
    // Matched to the Gemini driver so a provider switch doesn't silently change how
    // varied the answers are.
    temperature: 0.4,
    stream: false,
  };

  // Same class of problem the Gemini driver solves with thinkingLevel "minimal":
  // GPT-OSS reasoning tokens are billed against the completion budget, so an unbounded
  // reasoning pass can eat the cap and truncate the JSON. Llama models ignore this
  // field, so it is set only where it applies.
  if (strict) body.reasoning_effort = "low";

  let res;
  try {
    res = await fetchImpl(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    console.error(`[tachy] groq ${timedOut ? "timeout" : "network error"}: ${err?.name}`);
    return { ok: false, reason: timedOut ? REASON.TIMEOUT : REASON.UPSTREAM_ERROR };
  }

  if (!res.ok) {
    const detail = await safeText(res);
    console.error(`[tachy] groq HTTP ${res.status}: ${detail}`);

    if (res.status === 429) {
      // Groq reports remaining quota on every response; on a 429 it is the one thing
      // worth having in the log, because it distinguishes "burst" from "daily budget
      // gone" — two very different operational problems.
      console.error(
        `[tachy] groq quota: requests=${res.headers?.get?.("x-ratelimit-remaining-requests")} ` +
          `tokens=${res.headers?.get?.("x-ratelimit-remaining-tokens")}`,
      );
      return { ok: false, reason: REASON.UPSTREAM_RATE_LIMIT };
    }

    // Strict mode fails CLOSED with a 400 `json_validate_failed` rather than returning
    // off-schema text. That is a malformed model response, not a broken request, so it
    // maps to INVALID_RESPONSE — the user gets "I didn't quite catch that", not the
    // generic outage line, and the reason code stays honest in telemetry.
    if (res.status === 400 && detail.includes("json_validate_failed")) {
      return { ok: false, reason: REASON.INVALID_RESPONSE };
    }

    return { ok: false, reason: REASON.UPSTREAM_ERROR };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[tachy] groq returned unparseable JSON envelope");
    return { ok: false, reason: REASON.UPSTREAM_ERROR };
  }

  const choice = payload?.choices?.[0];
  const finish = choice?.finish_reason;

  if (finish === "content_filter") {
    console.warn("[tachy] groq candidate suppressed: content_filter");
    return { ok: false, reason: REASON.BLOCKED };
  }

  const raw = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const text = stripCodeFence(raw);

  if (!text) {
    console.error(`[tachy] groq returned no text (finish_reason=${finish ?? "none"})`);
    return { ok: false, reason: REASON.INVALID_RESPONSE };
  }

  // finish_reason "length" means the answer hit max_completion_tokens and the JSON is
  // truncated. Logged rather than special-cased: Gate 2 rejects it and INVALID_RESPONSE
  // is the right user-facing outcome, but a run of these means the cap is too low.
  if (finish === "length") {
    console.warn("[tachy] groq hit max_completion_tokens — JSON is likely truncated");
  }

  return { ok: true, text };
}

// Neutral turns -> OpenAI-style messages, with the system instruction first.
//
// Roles: our neutral "model" is OpenAI's "assistant". Under json_object the schema is
// appended to the system message rather than sent as a constraint (see the header note).
function toMessages(turns, systemInstruction, strict) {
  const system = strict
    ? systemInstruction
    : `${systemInstruction}\n\n${schemaInstruction()}`;

  return [
    { role: "system", content: system },
    ...(turns ?? []).map((turn) => ({
      role: turn.role === "model" ? "assistant" : "user",
      content: turn.text,
    })),
  ];
}

// Open models wrap JSON in markdown fences even when told not to — a formatting habit,
// not a content problem. Stripping a fence that encloses the WHOLE response recovers an
// otherwise-good answer without weakening anything: the result still has to survive
// JSON.parse and the field-by-field rebuild in Gate 2. Anything more adventurous than
// this (regex-extracting the first {...} from surrounding prose) would be guessing at
// intent, so it is deliberately not done — that case stays a rejection.
function stripCodeFence(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
  const closing = withoutOpen.lastIndexOf("```");
  return (closing === -1 ? withoutOpen : withoutOpen.slice(0, closing)).trim();
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
