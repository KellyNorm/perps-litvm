import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { REASON } from "../../api/_lib/fallbacks.js";
import { callGroq, supportsStrictSchema } from "../../api/_lib/providers/groq.js";

const BASE = {
  apiKey: "test-key",
  model: "llama-3.3-70b-versatile",
  systemInstruction: "be helpful",
  turns: [{ role: "user", text: "hi" }],
  timeoutMs: 1000,
};

// The failure paths log deliberately; silenced so a passing run stays readable.
const realError = console.error;
const realWarn = console.warn;
before(() => {
  console.error = () => {};
  console.warn = () => {};
});
after(() => {
  console.error = realError;
  console.warn = realWarn;
});

function jsonResponse(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function completion(content, finish_reason = "stop") {
  return { choices: [{ finish_reason, message: { role: "assistant", content } }] };
}

// Captures the outgoing request body for assertions about the wire format.
async function sendAndCapture(overrides = {}) {
  let body;
  let headers;
  const out = await callGroq({
    ...BASE,
    ...overrides,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      headers = init.headers;
      return jsonResponse(completion("{}"));
    },
  });
  return { body, headers, out };
}

describe("groq driver", () => {
  test("returns the model text on success", async () => {
    const out = await callGroq({
      ...BASE,
      fetchImpl: async () => jsonResponse(completion('{"explanation":"ok"}')),
    });

    assert.equal(out.ok, true);
    assert.equal(out.text, '{"explanation":"ok"}');
  });

  test("sends the key as a bearer header, never in the URL", async () => {
    let seenUrl;
    let seenHeaders;
    await callGroq({
      ...BASE,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return jsonResponse(completion("{}"));
      },
    });

    assert.equal(seenHeaders.authorization, "Bearer test-key");
    assert.ok(!seenUrl.includes("test-key"), "key must not appear in the URL");
    assert.equal(seenUrl, "https://api.groq.com/openai/v1/chat/completions");
  });

  test("uses the OpenAI-compatible chat shape, not Gemini's", async () => {
    const { body } = await sendAndCapture({
      turns: [
        { role: "user", text: "what is a long?" },
        { role: "model", text: "betting price rises" },
        { role: "user", text: "and shorts?" },
      ],
    });

    // System instruction is a message, not a top-level field.
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /be helpful/);
    // Our neutral "model" role must become OpenAI's "assistant".
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(body.messages.at(-1).content, "and shorts?");
    assert.equal(body.model, "llama-3.3-70b-versatile");
    // Groq's current field name; max_tokens is deprecated.
    assert.ok(body.max_completion_tokens >= 1000);
    assert.equal(body.contents, undefined, "no Gemini fields leak into the Groq body");
  });

  // The core provider-gap test. Llama models reject json_schema with a 400, so the
  // driver must ask for json_object and state the schema in the prompt instead.
  test("falls back to json_object and states the schema for models without strict mode", async () => {
    const { body } = await sendAndCapture();

    assert.equal(body.response_format.type, "json_object");
    assert.equal(body.reasoning_effort, undefined, "Llama has no reasoning_effort");
    // The shape has to be stated somewhere, since json_object enforces none of it.
    for (const field of ["explanation", "clarificationQuestion", "language", "knowsAnswer"]) {
      assert.match(body.messages[0].content, new RegExp(field), `${field} is specified`);
    }
  });

  test("uses strict json_schema on models that support it", async () => {
    const { body } = await sendAndCapture({ model: "openai/gpt-oss-120b" });

    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    // Reasoning tokens bill against the completion budget — same failure mode the
    // Gemini driver avoids with thinkingLevel "minimal".
    assert.equal(body.reasoning_effort, "low");
  });

  test("knows which models support strict schema", () => {
    assert.equal(supportsStrictSchema("openai/gpt-oss-120b"), true);
    assert.equal(supportsStrictSchema("openai/gpt-oss-20b"), true);
    assert.equal(supportsStrictSchema("llama-3.3-70b-versatile"), false);
    assert.equal(supportsStrictSchema(undefined), false);
  });

  test("maps a missing key to NOT_CONFIGURED without calling out", async () => {
    let called = false;
    const out = await callGroq({
      ...BASE,
      apiKey: "",
      fetchImpl: async () => {
        called = true;
        return jsonResponse(completion("{}"));
      },
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON.NOT_CONFIGURED);
    assert.equal(called, false, "no request attempted without a key");
  });

  test("maps upstream statuses to reason codes without leaking provider text", async () => {
    const cases = [
      [429, REASON.UPSTREAM_RATE_LIMIT],
      [500, REASON.UPSTREAM_ERROR],
      [503, REASON.UPSTREAM_ERROR],
      [401, REASON.UPSTREAM_ERROR],
      [400, REASON.UPSTREAM_ERROR],
    ];

    for (const [status, expected] of cases) {
      const out = await callGroq({
        ...BASE,
        fetchImpl: async () =>
          jsonResponse({ error: { message: "boom" } }, { ok: false, status }),
      });
      assert.equal(out.ok, false, `status ${status}`);
      assert.equal(out.reason, expected, `status ${status}`);
      assert.equal(out.text, undefined, "no provider text is returned");
    }
  });

  // Strict mode fails closed rather than returning off-schema text. That is a bad model
  // response, not a bad request, and the reason code has to say so.
  test("maps a strict-schema validation failure to INVALID_RESPONSE, not a generic error", async () => {
    const out = await callGroq({
      ...BASE,
      model: "openai/gpt-oss-120b",
      fetchImpl: async () =>
        jsonResponse(
          { error: { code: "json_validate_failed", message: "Failed to validate JSON." } },
          { ok: false, status: 400 },
        ),
    });

    assert.equal(out.reason, REASON.INVALID_RESPONSE);
  });

  test("maps a timeout distinctly from a network error", async () => {
    const timeout = await callGroq({
      ...BASE,
      fetchImpl: async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });
    assert.equal(timeout.reason, REASON.TIMEOUT);

    const network = await callGroq({
      ...BASE,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(network.reason, REASON.UPSTREAM_ERROR);
  });

  test("treats a content filter as BLOCKED", async () => {
    const out = await callGroq({
      ...BASE,
      fetchImpl: async () => jsonResponse(completion("", "content_filter")),
    });
    assert.equal(out.reason, REASON.BLOCKED);
  });

  test("treats an empty or missing choice as an invalid response", async () => {
    const empty = await callGroq({ ...BASE, fetchImpl: async () => jsonResponse({}) });
    assert.equal(empty.reason, REASON.INVALID_RESPONSE);

    const blank = await callGroq({
      ...BASE,
      fetchImpl: async () => jsonResponse(completion("   ")),
    });
    assert.equal(blank.reason, REASON.INVALID_RESPONSE);
  });

  // Open models fence their JSON even when told not to. Recovering that is worth it;
  // guessing JSON out of surrounding prose is not.
  test("strips a markdown fence wrapping the whole response", async () => {
    for (const wrapped of [
      '```json\n{"explanation":"ok"}\n```',
      '```\n{"explanation":"ok"}\n```',
      '  ```json\n{"explanation":"ok"}```  ',
    ]) {
      const out = await callGroq({
        ...BASE,
        fetchImpl: async () => jsonResponse(completion(wrapped)),
      });
      assert.equal(out.ok, true, wrapped);
      assert.equal(out.text, '{"explanation":"ok"}', wrapped);
    }
  });

  test("does not try to rescue JSON embedded in prose", async () => {
    const out = await callGroq({
      ...BASE,
      fetchImpl: async () => jsonResponse(completion('Sure! {"explanation":"ok"}')),
    });

    // Passed through verbatim, so Gate 2 rejects it. The driver must not invent a
    // parse the model did not commit to.
    assert.equal(out.text, 'Sure! {"explanation":"ok"}');
  });

  test("survives an unparseable envelope", async () => {
    const out = await callGroq({
      ...BASE,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("nope");
        },
      }),
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON.UPSTREAM_ERROR);
  });
});
