// End-to-end routing through the handler with TACHY_PROVIDER=groq.
//
// Separate file rather than more cases in handler.test.js because `node --test` runs
// each file in its own process, and both the provider and the module-scoped limiter are
// resolved from env — mixing the two providers in one process would leak state between
// them and make the results depend on test order.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { REASON } from "../../api/_lib/fallbacks.js";

process.env.TACHY_PROVIDER = "groq";
process.env.GROQ_API_KEY = "test-groq-key";
// Deliberately set too, to prove it is unused on this path.
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.TACHY_RPM = "5";
process.env.TACHY_RPH = "100";
process.env.TACHY_MAX_CHARS = "100";

const { default: handler } = await import("../../api/tachy.js");

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

let ipCounter = 0;
function mockReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers: { "x-forwarded-for": `10.1.0.${++ipCounter}`, ...headers } };
}

function mockRes() {
  const res = { statusCode: null, headers: {}, body: null };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return calls;
}

function groqSays(content, { ok = true, status = 200 } = {}) {
  const payload = ok
    ? { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }
    : content;
  return async () => ({
    ok,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

const GOOD_REPLY = {
  explanation: "A perp is a leveraged bet on price with no expiry.",
  clarificationQuestion: null,
  language: "en",
  knowsAnswer: true,
};

describe("POST /api/tachy with TACHY_PROVIDER=groq", () => {
  test("calls Groq, not Gemini, and never sends the Gemini key", async () => {
    const calls = stubFetch(groqSays(JSON.stringify(GOOD_REPLY)));
    const res = mockRes();
    await handler(mockReq({ body: { message: "what is a perp?" } }), res);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer test-groq-key");
    assert.equal(
      calls[0].init.headers["x-goog-api-key"],
      undefined,
      "no Gemini auth header on the Groq path",
    );
    assert.doesNotMatch(JSON.stringify(calls[0].init), /test-gemini-key/);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.fallback, false);
    assert.equal(res.body.reply.explanation, GOOD_REPLY.explanation);
  });

  test("sends the identical system prompt, unmodified by provider", async () => {
    const calls = stubFetch(groqSays(JSON.stringify(GOOD_REPLY)));
    await handler(mockReq({ body: { message: "hi", view: "perps" } }), mockRes());

    const sent = JSON.parse(calls[0].init.body);
    const system = sent.messages[0].content;

    // Spot-check the rails that the smoke test then exercises live. If these are not in
    // the prompt Groq receives, a passing smoke run would prove nothing about them.
    assert.match(system, /You are Tachy/);
    assert.match(system, /THERE IS NO 5-MINUTE FRAME/);
    assert.match(system, /EDUCATION, NEVER ADVICE/);
    assert.match(system, /never invent/i);
    assert.match(system, /Detect the user's language/);
  });

  test("maps history to OpenAI roles in order", async () => {
    const calls = stubFetch(groqSays(JSON.stringify(GOOD_REPLY)));
    await handler(
      mockReq({
        body: {
          message: "and shorts?",
          history: [
            { role: "user", text: "what is a long?" },
            { role: "tachy", text: "betting price rises" },
          ],
        },
      }),
      mockRes(),
    );

    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(
      sent.messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
  });

  // The rails below the provider are shared code, so these assert that swapping the
  // driver did not route around them.
  test("still strips model-invented fields", async () => {
    stubFetch(
      groqSays(
        JSON.stringify({ ...GOOD_REPLY, tradeIntent: "open", side: "long", amount: 500 }),
      ),
    );
    const res = mockRes();
    await handler(mockReq({ body: { message: "buy btc for me" } }), res);

    assert.deepEqual(Object.keys(res.body.reply).sort(), [
      "clarificationQuestion",
      "explanation",
      "knowsAnswer",
      "language",
    ]);
  });

  test("still falls back in character on unparseable model output", async () => {
    stubFetch(groqSays("Sure! Here's the answer you wanted:"));
    const res = mockRes();
    await handler(mockReq({ body: { message: "hi" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.fallback, true);
    assert.equal(res.body.meta.reason, REASON.INVALID_RESPONSE);
    assert.doesNotMatch(res.body.reply.explanation, /Here's the answer/);
  });

  test("still turns an upstream 429 into a 200 fallback with no provider text", async () => {
    stubFetch(
      groqSays({ error: { message: "Rate limit reached for org abc123" } }, { ok: false, status: 429 }),
    );
    const res = mockRes();
    await handler(mockReq({ body: { message: "hi" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.reason, REASON.UPSTREAM_RATE_LIMIT);
    assert.doesNotMatch(JSON.stringify(res.body), /org abc123/);
  });

  test("still caps oversized input before spending a Groq call", async () => {
    const calls = stubFetch(groqSays(JSON.stringify(GOOD_REPLY)));
    const res = mockRes();
    await handler(mockReq({ body: { message: "x".repeat(101) } }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(calls.length, 0);
  });
});
