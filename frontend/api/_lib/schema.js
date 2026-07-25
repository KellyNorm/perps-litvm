// The validation layer — the boundary that stops raw model output reaching the browser.
//
// Two independent gates, because either one alone is insufficient:
//
//   Gate 1 (TACHY_RESPONSE_SCHEMA) is sent to Gemini as `responseSchema`, which makes
//   well-formed JSON the default rather than a hope.
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
      description:
        "A single short follow-up question, only if the request was ambiguous. Empty string otherwise.",
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
