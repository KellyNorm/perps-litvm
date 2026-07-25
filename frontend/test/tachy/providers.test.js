import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { limits, modelId } from "../../api/_lib/config.js";
import {
  DEFAULT_PROVIDER,
  activeProvider,
  geminiProvider,
  groqProvider,
  selectProvider,
} from "../../api/_lib/providers/index.js";

const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("provider registry", () => {
  test("every driver implements the full contract", () => {
    for (const p of [geminiProvider, groqProvider]) {
      assert.equal(typeof p.id, "string", "id");
      assert.equal(typeof p.keyEnv, "string", `${p.id} keyEnv`);
      assert.ok(p.defaultModel, `${p.id} defaultModel`);
      assert.equal(typeof p.defaultRpm, "number", `${p.id} defaultRpm`);
      assert.equal(typeof p.defaultRph, "number", `${p.id} defaultRph`);
      assert.equal(typeof p.apiKey, "function", `${p.id} apiKey`);
      assert.equal(typeof p.generate, "function", `${p.id} generate`);
    }
  });

  test("selects by name", () => {
    assert.equal(selectProvider("groq").id, "groq");
    assert.equal(selectProvider("gemini").id, "gemini");
    assert.equal(selectProvider("GROQ").id, "groq", "case-insensitive");
    assert.equal(selectProvider("  groq  ").id, "groq", "trimmed");
  });

  // Pinned deliberately. The soft-launch default is Groq for a concurrency reason
  // (Gemini's free tier is 5 req/min GLOBAL, so two simultaneous users both get
  // fallbacks) — not because the rails differ. Both providers pass them. If this ever
  // needs to change, change it here on purpose, with .env.example and the note in
  // providers/index.js updated to match.
  test("the shipped default provider is groq", () => {
    assert.equal(DEFAULT_PROVIDER, "groq");
    withEnv({ TACHY_PROVIDER: undefined }, () => {
      assert.equal(activeProvider().id, "groq", "an unset env must land on Groq");
    });
  });

  test("an unknown or empty provider falls back to the default rather than failing", () => {
    assert.equal(selectProvider("openai").id, DEFAULT_PROVIDER);
    assert.equal(selectProvider("").id, DEFAULT_PROVIDER);
    assert.equal(selectProvider(undefined).id, DEFAULT_PROVIDER);
  });

  test("TACHY_PROVIDER drives the selection", () => {
    withEnv({ TACHY_PROVIDER: "groq" }, () => assert.equal(activeProvider().id, "groq"));
    withEnv({ TACHY_PROVIDER: undefined }, () =>
      assert.equal(activeProvider().id, DEFAULT_PROVIDER),
    );
  });

  test("each provider reads its own key env var", () => {
    withEnv({ GEMINI_API_KEY: "g-key", GROQ_API_KEY: "q-key" }, () => {
      assert.equal(geminiProvider.apiKey(), "g-key");
      assert.equal(groqProvider.apiKey(), "q-key");
    });
  });

  // The point of the split: a Groq deploy must not inherit Gemini's tighter limit, and
  // vice versa. These numbers are each provider's real measured free-tier ceiling.
  test("rate limits default to the ACTIVE provider's tier, not a shared guess", () => {
    withEnv({ TACHY_RPM: undefined, TACHY_RPH: undefined }, () => {
      assert.equal(limits(geminiProvider).perMinute, geminiProvider.defaultRpm);
      assert.equal(limits(groqProvider).perMinute, groqProvider.defaultRpm);
      assert.ok(
        groqProvider.defaultRpm > geminiProvider.defaultRpm,
        "Groq's free tier is the more generous of the two",
      );
    });
  });

  test("TACHY_RPM still overrides the provider default", () => {
    withEnv({ TACHY_RPM: "20" }, () => assert.equal(limits(groqProvider).perMinute, 20));
  });

  test("model defaults to the provider's pin and is overridable", () => {
    withEnv({ TACHY_MODEL: undefined }, () => {
      assert.equal(modelId(groqProvider), "llama-3.3-70b-versatile");
      assert.equal(modelId(geminiProvider), "gemini-3.6-flash");
    });
    withEnv({ TACHY_MODEL: "openai/gpt-oss-120b" }, () => {
      assert.equal(modelId(groqProvider), "openai/gpt-oss-120b");
    });
  });
});
