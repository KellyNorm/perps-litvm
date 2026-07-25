import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CLIENT_REASON, MAX_HISTORY_TURNS, askTachy, trimHistory } from "../../src/lib/tachy/askTachy.js";

// The client wrapper's contract in one line: whatever happens, the caller gets a
// renderable `reply.explanation` and never an exception. These tests exist mainly to
// hold the failure branches, because those are the ones a user actually hits once the
// free-tier quota runs out — and the ones that would otherwise surface as a raw error.
//
// No DOM and no network: `fetchImpl` is injected, which is the only reason this file can
// run under plain `node --test` alongside the server-side suites.

// A stub shaped like the real Response surface this module touches: ok, status, json().
function response(status, payload, { html = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (html) throw new SyntaxError("Unexpected token '<'");
      return payload;
    },
  };
}

const GOOD = {
  ok: true,
  reply: {
    explanation: "Leverage lets you control a larger position than your collateral.",
    clarificationQuestion: null,
    language: "en",
    knowsAnswer: true,
  },
  meta: { fallback: false, reason: null },
};

describe("askTachy — happy path", () => {
  test("returns the validated reply and reports it as a real answer", async () => {
    const out = await askTachy({
      message: "what is leverage?",
      view: "perps",
      fetchImpl: async () => response(200, GOOD),
    });

    assert.equal(out.fallback, false);
    assert.equal(out.reason, null);
    assert.equal(out.reply.explanation, GOOD.reply.explanation);
    assert.equal(out.reply.clarificationQuestion, null);
    assert.equal(out.reply.language, "en");
  });

  test("sends the message, the allowlisted view and the trimmed history", async () => {
    let sent;
    await askTachy({
      message: "  and shorts?  ",
      view: "predictions",
      locale: "es-ES",
      history: [
        { role: "user", text: "what is leverage?" },
        { role: "tachy", text: "It lets you..." },
      ],
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return response(200, GOOD);
      },
    });

    assert.equal(sent.message, "  and shorts?  ", "the server trims; we send verbatim");
    assert.equal(sent.view, "predictions");
    assert.equal(sent.locale, "es-ES");
    assert.equal(sent.history.length, 2);
  });

  test("drops a view the server would not accept rather than sending it", async () => {
    let sent;
    await askTachy({
      message: "hi",
      view: "admin",
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return response(200, GOOD);
      },
    });

    assert.equal("view" in sent, false);
  });

  test("keeps a clarification question when the model asked one", async () => {
    const out = await askTachy({
      message: "is it risky?",
      fetchImpl: async () =>
        response(200, {
          ...GOOD,
          reply: { ...GOOD.reply, clarificationQuestion: "  Do you mean perps or predictions?  " },
        }),
    });

    assert.equal(out.reply.clarificationQuestion, "Do you mean perps or predictions?");
  });

  test("ignores fields the model invented — they have no path into the UI", async () => {
    const out = await askTachy({
      message: "hi",
      fetchImpl: async () =>
        response(200, {
          ...GOOD,
          reply: { ...GOOD.reply, trade: { side: "long", size: "1000" }, address: "0xdead" },
        }),
    });

    assert.deepEqual(Object.keys(out.reply).sort(), [
      "clarificationQuestion",
      "explanation",
      "knowsAnswer",
      "language",
    ]);
  });
});

describe("askTachy — degraded paths never surface an error", () => {
  test("a provider fallback is passed through in character and flagged", async () => {
    const out = await askTachy({
      message: "hi",
      fetchImpl: async () =>
        response(200, {
          ok: true,
          reply: {
            explanation: "I'm getting a lot of questions right now and need a breather.",
            clarificationQuestion: null,
            language: "en",
            knowsAnswer: false,
          },
          meta: { fallback: true, reason: "upstream_rate_limit" },
        }),
    });

    assert.equal(out.fallback, true);
    assert.equal(out.reason, "upstream_rate_limit");
    assert.match(out.reply.explanation, /breather/);
  });

  test("a 429 is flagged even though meta.fallback is false", async () => {
    // The handler treats rate limiting as a client error, so meta.fallback stays false.
    // From the user's side it is still "no answer this time", so the status has to count.
    const out = await askTachy({
      message: "hi",
      fetchImpl: async () =>
        response(429, {
          ok: false,
          reply: {
            explanation: "Whoa, slow down! I need a second to keep up.",
            clarificationQuestion: null,
            language: "en",
            knowsAnswer: false,
          },
          meta: { fallback: false, reason: "rate_limited_minute" },
        }),
    });

    assert.equal(out.fallback, true);
    assert.equal(out.reason, "rate_limited_minute");
    assert.match(out.reply.explanation, /slow down/);
  });

  test("an HTML page from a dev server with no /api route becomes an in-character reply", async () => {
    const out = await askTachy({ message: "hi", fetchImpl: async () => response(200, null, { html: true }) });

    assert.equal(out.fallback, true);
    assert.equal(out.reason, CLIENT_REASON.UNREADABLE);
    assert.match(out.reply.explanation, /slow right now/);
  });

  test("a dead network resolves rather than throwing", async () => {
    const out = await askTachy({
      message: "hi",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    assert.equal(out.fallback, true);
    assert.equal(out.reason, CLIENT_REASON.NETWORK);
    assert.ok(out.reply.explanation.trim().length > 0);
  });

  test("an abort is re-thrown, so a cancelled request is not logged as a failure", async () => {
    await assert.rejects(
      askTachy({
        message: "hi",
        fetchImpl: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
      /aborted/,
    );
  });

  test("a well-formed envelope with an unusable explanation still yields something to render", async () => {
    for (const reply of [undefined, null, {}, { explanation: "" }, { explanation: "   " }, { explanation: 7 }]) {
      const out = await askTachy({ message: "hi", fetchImpl: async () => response(200, { ok: true, reply }) });
      assert.equal(out.fallback, true, JSON.stringify(reply));
      assert.ok(out.reply.explanation.trim().length > 0);
    }
  });
});

describe("trimHistory", () => {
  test("keeps the newest turns only", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "tachy",
      text: `turn ${i}`,
    }));

    const out = trimHistory(long);
    assert.ok(out.length <= MAX_HISTORY_TURNS);
    assert.equal(out.at(-1).text, "turn 19");
  });

  test("opens on a user turn, because both providers require it", () => {
    const out = trimHistory([
      { role: "tachy", text: "leading model turn" },
      { role: "user", text: "then me" },
    ]);

    assert.equal(out[0].role, "user");
  });

  test("drops malformed turns and non-array input", () => {
    assert.deepEqual(trimHistory(null), []);
    assert.deepEqual(trimHistory("nope"), []);
    assert.deepEqual(
      trimHistory([{ role: "system", text: "x" }, { role: "user", text: "  " }, null, { role: "user" }]),
      [],
    );
  });
});
