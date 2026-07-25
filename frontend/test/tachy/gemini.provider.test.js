import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { callGemini } from "../../api/_lib/providers/gemini.js";
import { REASON } from "../../api/_lib/fallbacks.js";

const BASE = {
  apiKey: "test-key",
  model: "gemini-3.6-flash",
  systemInstruction: "be helpful",
  turns: [{ role: "user", text: "hi" }],
  timeoutMs: 1000,
};

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function candidate(text, finishReason = "STOP") {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }] };
}

describe("gemini driver", () => {
  test("returns the model text on success", async () => {
    const out = await callGemini({
      ...BASE,
      fetchImpl: async () => jsonResponse(candidate('{"explanation":"ok"}')),
    });

    assert.equal(out.ok, true);
    assert.equal(out.text, '{"explanation":"ok"}');
  });

  test("sends the key as a header, never in the URL", async () => {
    let seenUrl;
    let seenHeaders;
    await callGemini({
      ...BASE,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return jsonResponse(candidate("{}"));
      },
    });

    assert.ok(!seenUrl.includes("test-key"), "key must not appear in the URL");
    assert.equal(seenHeaders["x-goog-api-key"], "test-key");
    assert.match(seenUrl, /\/v1beta\/models\/gemini-3\.6-flash:generateContent$/);
  });

  test("requests structured JSON output", async () => {
    let body;
    await callGemini({
      ...BASE,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse(candidate("{}"));
      },
    });

    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseSchema, "schema is sent");
    assert.equal(body.systemInstruction.parts[0].text, "be helpful");
  });

  // Regression guard. Without this, Gemini 3.x spends the maxOutputTokens budget on
  // thinking (measured 572 thoughts vs 9 answer tokens against a 600 cap) and returns
  // truncated JSON, which the validator then rejects — surfacing as intermittent
  // "I didn't quite catch that" for longer or non-English questions.
  test("keeps thinking minimal so the token budget goes to the answer", async () => {
    let body;
    await callGemini({
      ...BASE,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse(candidate("{}"));
      },
    });

    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
    assert.ok(
      body.generationConfig.maxOutputTokens >= 1000,
      "budget is shared with thinking, so it needs headroom",
    );
  });

  test("maps a missing key to NOT_CONFIGURED without calling out", async () => {
    let called = false;
    const out = await callGemini({
      ...BASE,
      apiKey: "",
      fetchImpl: async () => {
        called = true;
        return jsonResponse(candidate("{}"));
      },
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON.NOT_CONFIGURED);
    assert.equal(called, false, "no request attempted without a key");
  });

  test("maps upstream statuses to reason codes", async () => {
    const cases = [
      [429, REASON.UPSTREAM_RATE_LIMIT],
      [500, REASON.UPSTREAM_ERROR],
      [503, REASON.UPSTREAM_ERROR],
      [400, REASON.UPSTREAM_ERROR],
      [403, REASON.UPSTREAM_ERROR],
    ];

    for (const [status, expected] of cases) {
      const out = await callGemini({
        ...BASE,
        fetchImpl: async () => jsonResponse({ error: { message: "boom" } }, { ok: false, status }),
      });
      assert.equal(out.ok, false, `status ${status}`);
      assert.equal(out.reason, expected, `status ${status}`);
      assert.equal(out.text, undefined, "no provider text is returned");
    }
  });

  test("maps a timeout distinctly from a network error", async () => {
    const timeout = await callGemini({
      ...BASE,
      fetchImpl: async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });
    assert.equal(timeout.reason, REASON.TIMEOUT);

    const network = await callGemini({
      ...BASE,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(network.reason, REASON.UPSTREAM_ERROR);
  });

  test("treats safety blocks as BLOCKED", async () => {
    const prompt = await callGemini({
      ...BASE,
      fetchImpl: async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    assert.equal(prompt.reason, REASON.BLOCKED);

    for (const finish of ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST"]) {
      const out = await callGemini({
        ...BASE,
        fetchImpl: async () => jsonResponse(candidate("", finish)),
      });
      assert.equal(out.reason, REASON.BLOCKED, finish);
    }
  });

  test("treats an empty or partless candidate as an invalid response", async () => {
    const empty = await callGemini({ ...BASE, fetchImpl: async () => jsonResponse({}) });
    assert.equal(empty.reason, REASON.INVALID_RESPONSE);

    const noParts = await callGemini({
      ...BASE,
      fetchImpl: async () => jsonResponse({ candidates: [{ finishReason: "STOP", content: {} }] }),
    });
    assert.equal(noParts.reason, REASON.INVALID_RESPONSE);
  });

  test("joins multi-part text", async () => {
    const out = await callGemini({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: '{"expla' }, { text: 'nation":"ok"}' }] } },
          ],
        }),
    });

    assert.equal(out.text, '{"explanation":"ok"}');
  });

  test("survives an unparseable envelope", async () => {
    const out = await callGemini({
      ...BASE,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("nope");
        },
      }),
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON.UPSTREAM_ERROR);
  });
});
