// Handler + validation + the tier→status mapping.
//
// FULLY OFFLINE. No RPC is reached: the tests register their own quest definitions in the
// registry, so every path through the handler — cache, verify, envelope, both 503s — is
// exercised without a network call. The real chain reads are covered by chain.test.js
// (pure derivations) and, at the integration level, by the smoke script.
//
// Mutating the exported QUESTS object is deliberate and is why the registry is a plain
// object: it lets the handler be tested end-to-end without a production test seam.

import assert from "node:assert/strict";
import test, { after, afterEach, before, describe } from "node:test";

process.env.QUEST_RPM = "3";
process.env.QUEST_RPH = "100";
// Deliberately NOT set: the address env vars stay unset for the whole file, proving the
// handler never reaches the chain on any tested path.
delete process.env.QUEST_POSITION_MANAGER_ADDRESS;

const { default: handler, normalizeQuestBody, verifyQuest, _resetCache } = await import("../../api/quest/verify.js");
const { QUESTS, STATUS, SOURCE, QUEST_KIND } = await import("../../api/_lib/quest/quests.js");
const { ConfigError } = await import("../../api/_lib/quest/chain.js");

const ADDRESS = "0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292";

// The 503 paths log deliberately; silenced so a passing run stays readable.
const realError = console.error;
before(() => {
  console.error = () => {};
});
after(() => {
  console.error = realError;
});

// Every registered test quest is removed after each case, so no test can leak a
// definition into another's registry.
const registered = new Set();
function registerQuest(id, definition) {
  QUESTS[id] = { id, kind: QUEST_KIND.ONE_TIME, tier1: null, tier2: null, ...definition };
  registered.add(id);
  return id;
}
afterEach(() => {
  for (const id of registered) delete QUESTS[id];
  registered.clear();
  // The cache is module-scoped and survives between requests by design; drop it so one
  // test's stored completion cannot answer another's.
  _resetCache();
});

let ipCounter = 0;
const nextIp = () => `10.1.0.${++ipCounter}`;

/** A Tier 1 check's return shape — see the contract at the top of _lib/quest/checks.js. */
const tier1 = (completed, { reliable = true, checkedThroughBlock = 33_000_000 } = {}) => ({
  completed,
  reliable,
  checkedThroughBlock,
});

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

async function call(reqInit) {
  const res = mockRes();
  await handler(mockReq(reqInit), res);
  return res;
}

describe("request validation", () => {
  test("accepts a well-formed body", () => {
    const out = normalizeQuestBody({ address: ADDRESS, quest: "first_trade" });
    assert.equal(out.ok, true);
    assert.deepEqual(out.value, { address: ADDRESS, quest: "first_trade" });
  });

  test("parses a string body (client omitted the content-type header)", () => {
    const out = normalizeQuestBody(JSON.stringify({ address: ADDRESS, quest: "first_trade" }));
    assert.equal(out.ok, true);
  });

  test("rejects unparseable and non-object bodies", () => {
    assert.equal(normalizeQuestBody("{nope").reason, "unparseable_body");
    assert.equal(normalizeQuestBody(null).reason, "invalid_body");
    assert.equal(normalizeQuestBody([]).reason, "invalid_body");
  });

  test("rejects a missing or malformed address rather than guessing", () => {
    assert.equal(normalizeQuestBody({ quest: "first_trade" }).reason, "missing_address");
    assert.equal(normalizeQuestBody({ address: "  ", quest: "first_trade" }).reason, "missing_address");
    assert.equal(normalizeQuestBody({ address: "0xdead", quest: "first_trade" }).reason, "invalid_address");
    assert.equal(normalizeQuestBody({ address: 42, quest: "first_trade" }).reason, "missing_address");
  });

  test("rejects an unknown quest id instead of answering false", () => {
    assert.equal(normalizeQuestBody({ address: ADDRESS, quest: "nope" }).reason, "unknown_quest");
    assert.equal(normalizeQuestBody({ address: ADDRESS }).reason, "missing_quest");
  });

  // The id is caller-controlled, so a bare property read would return Object.prototype
  // members and turn a bad request into a 500.
  test("does not resolve inherited Object properties as quests", () => {
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(normalizeQuestBody({ address: ADDRESS, quest: id }).reason, "unknown_quest", id);
    }
  });
});

describe("handler envelope", () => {
  test("rejects non-POST with an Allow header", async () => {
    const res = await call({ method: "GET" });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "POST");
    assert.equal(res.body.error, "method_not_allowed");
  });

  test("400 lists the valid quest ids so a typo is self-answering", async () => {
    const res = await call({ body: { address: ADDRESS, quest: "frist_trade" } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "unknown_quest");
    assert.ok(res.body.validQuests.includes("first_trade"));
  });

  test("rejects an oversized declared body before parsing it", async () => {
    const res = await call({ headers: { "content-length": String(64 * 1024) } });
    assert.equal(res.statusCode, 413);
  });

  test("never lets a verdict be HTTP-cached", async () => {
    const quest = registerQuest("t_nostore", { tier1: async () => tier1(true) });
    const res = await call({ body: { address: ADDRESS, quest } });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("rate-limits per IP and says when to retry", async () => {
    const quest = registerQuest("t_limit", { tier1: async () => tier1(true) });
    const ip = nextIp();
    for (let i = 0; i < 3; i++) {
      assert.equal((await call({ body: { address: ADDRESS, quest }, ip })).statusCode, 200);
    }
    const res = await call({ body: { address: ADDRESS, quest }, ip });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, "rate_limited_minute");
    assert.ok(Number(res.headers["retry-after"]) >= 1);
  });
});

describe("verdicts", () => {
  test("a Tier 1 positive is a CONFIRMED completion", async () => {
    const quest = registerQuest("t_yes", { tier1: async () => tier1(true) });
    const res = await call({ body: { address: ADDRESS, quest } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.completed, true);
    assert.equal(res.body.status, STATUS.CONFIRMED);
    assert.equal(res.body.source, SOURCE.TIER1);
    assert.equal(res.body.checkedThroughBlock, 33_000_000);
    assert.equal(res.body.address, ADDRESS);
    assert.equal(res.body.quest, quest);
    assert.ok(!Number.isNaN(Date.parse(res.body.asOf)));
  });

  // THE CENTRAL RULE. Until the Tier 2 scan exists, a Tier 1 false cannot tell "never
  // traded" from "traded and closed" — so it must not be reported as a settled no.
  test("a Tier 1 negative is INDETERMINATE, never a confirmed false", async () => {
    const quest = registerQuest("t_no", { tier1: async () => tier1(false) });
    const res = await call({ body: { address: ADDRESS, quest } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.completed, false);
    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.notEqual(res.body.status, STATUS.CONFIRMED);
  });

  test("missing contract config is UNAVAILABLE (503), not a false", async () => {
    const quest = registerQuest("t_cfg", {
      tier1: async () => {
        throw new ConfigError("QUEST_POSITION_MANAGER_ADDRESS is not set");
      },
    });
    const res = await call({ body: { address: ADDRESS, quest } });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, STATUS.UNAVAILABLE);
    assert.equal(res.body.reason, "not_configured");
    assert.equal(res.body.source, null);
    assert.equal(res.body.checkedThroughBlock, null);
  });

  test("an RPC failure is UNAVAILABLE (503) with a distinct reason", async () => {
    const quest = registerQuest("t_rpc", {
      tier1: async () => {
        throw new Error("missing response");
      },
    });
    const res = await call({ body: { address: ADDRESS, quest } });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, STATUS.UNAVAILABLE);
    assert.equal(res.body.reason, "rpc_unavailable");
  });
});

describe("cache-first", () => {
  test("a proven completion is served from cache without re-checking the chain", async () => {
    let checks = 0;
    const quest = registerQuest("t_cache_hit", {
      tier1: async () => {
        checks++;
        return tier1(true);
      },
    });

    const first = await call({ body: { address: ADDRESS, quest } });
    assert.equal(first.body.source, SOURCE.TIER1);

    const second = await call({ body: { address: ADDRESS, quest } });
    assert.equal(second.body.completed, true);
    assert.equal(second.body.status, STATUS.CONFIRMED);
    assert.equal(second.body.source, SOURCE.CACHE);
    assert.equal(checks, 1, "the second request must not re-read the chain");
  });

  // The whole point of the storage-layer policy: a scan that could not prove anything is
  // re-run next time rather than being remembered as "no".
  test("an indeterminate is NOT cached — the next request re-checks", async () => {
    let checks = 0;
    const quest = registerQuest("t_cache_miss", {
      tier1: async () => {
        checks++;
        return tier1(false);
      },
    });

    await call({ body: { address: ADDRESS, quest } });
    const second = await call({ body: { address: ADDRESS, quest } });

    assert.equal(second.body.status, STATUS.INDETERMINATE);
    assert.equal(second.body.source, SOURCE.TIER1, "must not be served from cache");
    assert.equal(checks, 2);
  });

  test("one wallet's completion never answers for another", async () => {
    const quest = registerQuest("t_cache_scope", {
      tier1: async (address) => tier1(address === ADDRESS),
    });

    await call({ body: { address: ADDRESS, quest } });
    const other = await call({
      body: { address: "0x0000000000000000000000000000000000000001", quest },
    });

    assert.equal(other.body.completed, false);
    assert.equal(other.body.status, STATUS.INDETERMINATE);
  });

  test("a completion for one quest never answers for another", async () => {
    const done = registerQuest("t_cache_q1", { tier1: async () => tier1(true) });
    const notDone = registerQuest("t_cache_q2", { tier1: async () => tier1(false) });

    await call({ body: { address: ADDRESS, quest: done } });
    const res = await call({ body: { address: ADDRESS, quest: notDone } });

    assert.equal(res.body.completed, false);
  });
});

describe("verifyQuest", () => {
  test("maps the tiers without touching HTTP", async () => {
    const yes = await verifyQuest({ tier1: async () => tier1(true), tier2: null }, ADDRESS);
    assert.deepEqual(
      { completed: yes.completed, status: yes.status },
      { completed: true, status: STATUS.CONFIRMED },
    );

    const no = await verifyQuest({ tier1: async () => tier1(false), tier2: null }, ADDRESS);
    assert.deepEqual(
      { completed: no.completed, status: no.status },
      { completed: false, status: STATUS.INDETERMINATE },
    );
  });
});
