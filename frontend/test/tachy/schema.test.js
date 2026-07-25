import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { FIELD_LIMITS, parseAndValidate, validateShape } from "../../api/_lib/schema.js";

describe("tachy response validation", () => {
  test("accepts a well-formed response", () => {
    const out = parseAndValidate(
      JSON.stringify({
        explanation: "A liquidation closes your position when losses eat your collateral.",
        clarificationQuestion: "",
        language: "en",
        knowsAnswer: true,
      }),
    );

    assert.equal(out.ok, true);
    assert.match(out.reply.explanation, /liquidation/);
    assert.equal(out.reply.clarificationQuestion, null, "empty string normalises to null");
    assert.equal(out.reply.language, "en");
    assert.equal(out.reply.knowsAnswer, true);
  });

  test("rejects unparseable JSON rather than throwing", () => {
    assert.doesNotThrow(() => parseAndValidate("{not json"));
    assert.equal(parseAndValidate("{not json").ok, false);
  });

  test("rejects non-string and empty input", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      assert.equal(parseAndValidate(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test("rejects a response with no usable explanation", () => {
    assert.equal(validateShape({ language: "en" }).ok, false, "missing");
    assert.equal(validateShape({ explanation: "   " }).ok, false, "whitespace only");
    assert.equal(validateShape({ explanation: 123 }).ok, false, "wrong type");
    assert.equal(validateShape({ explanation: ["a"] }).ok, false, "array");
  });

  test("rejects non-object payloads", () => {
    for (const bad of [null, "string", 7, ["a"], true]) {
      assert.equal(validateShape(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  // The core safety property: nothing the model invents can reach the client.
  test("strips unknown keys instead of passing them through", () => {
    const out = validateShape({
      explanation: "ok",
      language: "en",
      knowsAnswer: true,
      // A model that has decided to improvise an action for us.
      tradeIntent: "open",
      side: "long",
      amount: 1000,
      __proto__: { polluted: true },
    });

    assert.equal(out.ok, true);
    assert.deepEqual(Object.keys(out.reply).sort(), [
      "clarificationQuestion",
      "explanation",
      "knowsAnswer",
      "language",
    ]);
    assert.equal(out.reply.tradeIntent, undefined);
    assert.equal(out.reply.amount, undefined);
    assert.equal({}.polluted, undefined, "no prototype pollution");
  });

  test("clamps oversized strings to the field limits", () => {
    const out = validateShape({
      explanation: "x".repeat(FIELD_LIMITS.explanation + 500),
      clarificationQuestion: "y".repeat(FIELD_LIMITS.clarificationQuestion + 500),
      language: "z".repeat(FIELD_LIMITS.language + 50),
      knowsAnswer: false,
    });

    assert.equal(out.ok, true);
    assert.equal(out.reply.explanation.length, FIELD_LIMITS.explanation);
    assert.equal(out.reply.clarificationQuestion.length, FIELD_LIMITS.clarificationQuestion);
    assert.equal(out.reply.language.length, FIELD_LIMITS.language);
  });

  test("defaults optional fields rather than failing on them", () => {
    const out = validateShape({ explanation: "ok" });

    assert.equal(out.ok, true);
    assert.equal(out.reply.language, "en", "missing language defaults");
    assert.equal(out.reply.knowsAnswer, true, "missing knowsAnswer defaults");
    assert.equal(out.reply.clarificationQuestion, null);
  });

  test("ignores a non-boolean knowsAnswer", () => {
    assert.equal(validateShape({ explanation: "ok", knowsAnswer: "yes" }).reply.knowsAnswer, true);
    assert.equal(validateShape({ explanation: "ok", knowsAnswer: false }).reply.knowsAnswer, false);
  });
});
