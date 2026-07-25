// The validation layer — the boundary that stops raw model output reaching the browser.
//
// Two independent gates, because either one alone is insufficient:
//
//   Gate 1 is the provider-side generation constraint, which makes well-formed JSON the
//   default rather than a hope. Its STRENGTH VARIES BY PROVIDER — see the note on
//   TACHY_JSON_SCHEMA below — which is exactly why it cannot be the only gate.
//   Gate 2 (parseAndValidate) re-checks everything anyway. A provider-side schema is a
//   generation constraint, not a security guarantee — it can change, degrade, or be
//   bypassed by a safety-truncated response, and we still have to hold the shape.
//
// V1 SAFETY PROPERTY: this schema has NO trade, intent, amount, or address field. That
// is deliberate and structural — a confused or adversarially-steered model response has
// no field in which to smuggle an action, so nothing downstream can misread it as one.
// Adding such a field is a money-path change and must not be done casually.

export const FIELD_LIMITS = {
  explanation: 1200,
  clarificationQuestion: 240,
  language: 12,
};

// Sent to Gemini via generationConfig.responseSchema.
export const TACHY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description: "The educational answer, in the user's own language.",
    },
    clarificationQuestion: {
      type: "string",
      // nullable so the model can emit the `string | null` the system prompt specifies.
      // Without it the schema and the prompt disagree, and the model has to pick one.
      nullable: true,
      description:
        "A single short follow-up question, only if the request was genuinely ambiguous. Null otherwise.",
    },
    language: {
      type: "string",
      description: "BCP-47-ish tag of the language used in `explanation`, e.g. 'en', 'es'.",
    },
    knowsAnswer: {
      type: "boolean",
      description:
        "False when declining to answer because the fact is not in the grounded facts block.",
    },
  },
  required: ["explanation", "language", "knowsAnswer"],
};

// The same contract in strict JSON Schema, for OpenAI-compatible providers (Groq).
// It is a SEPARATE constant rather than a transform of the one above because the two
// dialects genuinely disagree: Gemini uses OpenAPI's `nullable: true`, strict JSON
// Schema wants a `["string","null"]` union; and strict mode additionally demands
// `additionalProperties: false` with EVERY property listed in `required`. Deriving one
// from the other would hide those differences behind a converter that has to be right
// about both — two explicit literals are easier to check against the wire format.
//
// Keep the field set in sync with TACHY_RESPONSE_SCHEMA and validateShape(). The
// v1 safety property holds identically here: no trade, intent, amount or address field.
export const TACHY_JSON_SCHEMA = {
  type: "object",
  properties: {
    explanation: { type: "string" },
    // Required-but-nullable, because strict mode has no notion of an optional property:
    // everything must be in `required`, so "absent" has to be expressed as null.
    clarificationQuestion: { type: ["string", "null"] },
    language: { type: "string" },
    knowsAnswer: { type: "boolean" },
  },
  required: ["explanation", "clarificationQuestion", "language", "knowsAnswer"],
  additionalProperties: false,
};

// A compact restatement of the contract, in prose, for providers that accept only
// `json_object` (valid JSON, no schema enforcement) — which on Groq is every Llama
// model. There the shape is a REQUEST, not a constraint, so it has to be stated in the
// prompt or the model is guessing at field names.
//
// Generated from TACHY_JSON_SCHEMA so it cannot drift from the real contract. It is
// appended by the driver, NOT added to systemPrompt.js: the shared prompt stays
// model-agnostic, and each driver compensates for its own provider's gaps.
export function schemaInstruction() {
  const fields = Object.entries(TACHY_JSON_SCHEMA.properties)
    .map(([name, def]) => {
      const type = Array.isArray(def.type) ? def.type.join(" | ") : def.type;
      return `  "${name}": ${type}`;
    })
    .join(",\n");

  return [
    "RESPONSE FORMAT (hard requirement):",
    "Reply with a single JSON object and nothing else — no prose before or after it, no",
    "markdown code fences. Exactly these keys, no others:",
    "{",
    fields,
    "}",
    'Use null — not the string "null" and not an omitted key — when clarificationQuestion',
    "does not apply.",
  ].join("\n");
}

function cleanString(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Clamp rather than reject: an over-long but otherwise good answer is still useful,
  // and rejecting it would spend a Gemini call for nothing.
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

// Takes the model's raw text. Returns { ok: true, reply } or { ok: false } — never
// throws, because the caller's only sane response to bad input here is a fallback, and
// an exception escaping this function would become a 500.
export function parseAndValidate(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }

  return validateShape(parsed);
}

export function validateShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };

  const explanation = cleanString(parsed.explanation, FIELD_LIMITS.explanation);
  // The one genuinely required field: without it there is nothing to show.
  if (!explanation) return { ok: false };

  // Optional. The schema asks for "" when unused, so an empty string is normal, not an
  // error — cleanString turns both "" and whitespace into null.
  const clarificationQuestion = cleanString(
    parsed.clarificationQuestion,
    FIELD_LIMITS.clarificationQuestion,
  );

  const language = cleanString(parsed.language, FIELD_LIMITS.language) ?? "en";
  const knowsAnswer = typeof parsed.knowsAnswer === "boolean" ? parsed.knowsAnswer : true;

  // Built field by field into a NEW object rather than spread from `parsed`. This is
  // what makes unknown keys impossible rather than merely unlikely: anything the model
  // invented simply has no path into the result.
  return {
    ok: true,
    reply: { explanation, clarificationQuestion, language, knowsAnswer },
  };
}
