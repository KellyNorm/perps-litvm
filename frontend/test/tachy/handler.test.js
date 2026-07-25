import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { REASON } from "../../api/_lib/fallbacks.js";

// Env must be set before the handler module is evaluated, hence the dynamic import.
//
// TACHY_PROVIDER is pinned rather than left to the default: this file stubs GEMINI's
// wire format specifically, so it has to name the provider it is testing. Leaving it
// implicit meant these tests silently followed whatever the default happened to be —
// which broke the moment the soft-launch default moved to Groq. The Groq path has its
// own file, handler.groq.test.js.
process.env.TACHY_PROVIDER = "gemini";
process.env.GEMINI_API_KEY = "test-key";
process.env.TACHY_RPM = "5";
process.env.TACHY_RPH = "100";
process.env.TACHY_MAX_CHARS = "100";

const { default: handler } = await import("../../api/tachy.js");

// The failure paths log deliberately. Silenced so a passing run stays readable; the
// logging itself is covered by the gemini client tests.
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

// Each test gets its own IP so the module-scoped limiter can't leak between them.
let ipCounter = 0;
function nextIp() {
  return `10.0.0.${++ipCounter}`;
}

function mockReq({ method = "POST", body = {}, headers = {}, ip = nextIp() } = {}) {
  return { method, body, headers: { "x-forwarded-for": ip, ...headers } };
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

// Stubs global fetch, since the handler does not inject one.
function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return calls;
}

function geminiSays(obj, { ok = true, status = 200 } = {}) {
  const payload = ok
    ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] }
    : obj;
  return async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

const GOOD_REPLY = {
  explanation: "A perp is a leveraged bet on price with no expiry.",
  clarificationQuestion: "",
  language: "en",
  knowsAnswer: true,
};

describe("POST /api/tachy", () => {
  test("rejects non-POST with 405 and an Allow header", async () => {
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);

    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "POST");
    assert.equal(res.body.ok, false);
  });

  test("returns 400 for a body with no usable message", async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);

    assert.equal(res.statusCode, 400);
    assert.ok(res.body.reply.explanation, "still speaks in character");
  });

  test("returns 413 for an oversized message, without calling Gemini", async () => {
    const calls = stubFetch(geminiSays(GOOD_REPLY));
    const res = mockRes();
    await handler(mockReq({ body: { message: "x".repeat(101) } }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(calls.length, 0, "capped before the spend");
  });

  test("returns 413 on an oversized content-length before parsing", async () => {
    const calls = stubFetch(geminiSays(GOOD_REPLY));
    const res = mockRes();
    await handler(mockReq({ headers: { "content-length": String(20 * 1024) } }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(calls.length, 0);
  });

  test("returns a validated reply on success", async () => {
    stubFetch(geminiSays(GOOD_REPLY));
    const res = mockRes();
    await handler(mockReq({ body: { message: "what is a perp?" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.meta.fallback, false);
    assert.equal(res.body.reply.explanation, GOOD_REPLY.explanation);
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("never lets model-invented fields reach the client", async () => {
    stubFetch(geminiSays({ ...GOOD_REPLY, tradeIntent: "open", side: "long", amount: 500 }));
    const res = mockRes();
    await handler(mockReq({ body: { message: "buy btc for me" } }), res);

    assert.deepEqual(Object.keys(res.body.reply).sort(), [
      "clarificationQuestion",
      "explanation",
      "knowsAnswer",
      "language",
    ]);
  });

  test("turns an upstream rate limit into a 200 fallback, not an error", async () => {
    stubFetch(geminiSays({ error: { message: "quota exceeded for project 12345" } }, { ok: false, status: 429 }));
    const res = mockRes();
    await handler(mockReq({ body: { message: "hi" } }), res);

    assert.equal(res.statusCode, 200, "provider trouble is not the user's fault");
    assert.equal(res.body.meta.fallback, true);
    assert.equal(res.body.meta.reason, REASON.UPSTREAM_RATE_LIMIT);
    assert.ok(res.body.reply.explanation.length > 0);
    assert.doesNotMatch(
      JSON.stringify(res.body),
      /quota exceeded|project 12345/,
      "provider error text must not leak",
    );
  });

  test("turns a provider 500 into a 200 fallback", async () => {
    stubFetch(geminiSays({ error: "internal" }, { ok: false, status: 500 }));
    const res = mockRes();
    await handler(mockReq({ body: { message: "hi" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.reason, REASON.UPSTREAM_ERROR);
  });

  test("falls back when the model returns unparseable output", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "sure! here you go:" }] } }],
      }),
    }));
    const res = mockRes();
    await handler(mockReq({ body: { message: "hi" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.fallback, true);
    assert.equal(res.body.meta.reason, REASON.INVALID_RESPONSE);
    assert.doesNotMatch(res.body.reply.explanation, /here you go/, "raw text never surfaces");
  });

  test("falls back in character when the key is missing", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const calls = stubFetch(geminiSays(GOOD_REPLY));
      const res = mockRes();
      await handler(mockReq({ body: { message: "hi" } }), res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.meta.reason, REASON.NOT_CONFIGURED);
      assert.equal(calls.length, 0);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });

  test("rate limits a burst and stops calling Gemini once blocked", async () => {
    const ip = nextIp();
    const calls = stubFetch(geminiSays(GOOD_REPLY));

    const statuses = [];
    for (let i = 0; i < 9; i++) {
      const res = mockRes();
      await handler(mockReq({ ip, body: { message: `q${i}` } }), res);
      statuses.push(res.statusCode);
    }

    const allowed = statuses.filter((s) => s === 200).length;
    const blocked = statuses.filter((s) => s === 429).length;

    assert.equal(allowed, 5, "per-minute cap honoured");
    assert.equal(blocked, 4);
    assert.equal(calls.length, 5, "blocked requests never reach Gemini");
  });

  test("sets Retry-After when rate limited", async () => {
    const ip = nextIp();
    stubFetch(geminiSays(GOOD_REPLY));

    let res;
    for (let i = 0; i < 6; i++) {
      res = mockRes();
      await handler(mockReq({ ip, body: { message: "q" } }), res);
    }

    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers["retry-after"]) >= 1);
    assert.match(res.body.meta.reason, /^rate_limited_/);
  });

  test("passes conversation history through to Gemini in the right order", async () => {
    const calls = stubFetch(geminiSays(GOOD_REPLY));
    const res = mockRes();
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
      res,
    );

    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(
      sent.contents.map((c) => c.role),
      ["user", "model", "user"],
    );
    assert.equal(res.statusCode, 200);
  });
});
