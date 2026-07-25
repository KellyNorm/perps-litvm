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

/** A scanForEvent result. */
const scan = ({ found = false, complete = false, exhausted = false, reason = null } = {}) => ({
  found,
  complete,
  exhausted,
  reason,
  chunksUsed: 1,
  scannedFrom: 33_000_000,
  scannedDownTo: 32_990_000,
});

describe("tier 1 → tier 2 escalation", () => {
  test("a Tier 1 positive short-circuits: Tier 2 is never run", async () => {
    let scanned = false;
    const out = await verifyQuest(
      {
        tier1: async () => tier1(true),
        tier2: async () => {
          scanned = true;
          return scan({ found: true });
        },
      },
      ADDRESS,
    );

    assert.equal(out.completed, true);
    assert.equal(out.source, SOURCE.TIER1);
    assert.equal(scanned, false, "a proven positive must not pay for a scan");
  });

  test("a Tier 1 negative escalates and a scan hit CONFIRMS completion", async () => {
    const out = await verifyQuest(
      { tier1: async () => tier1(false), tier2: async () => scan({ found: true }) },
      ADDRESS,
    );

    assert.equal(out.completed, true);
    assert.equal(out.status, STATUS.CONFIRMED);
    assert.equal(out.source, SOURCE.TIER2);
  });

  // The ONLY route to a confirmed false.
  test("a COMPLETE scan finding nothing is the one path to a confirmed false", async () => {
    const out = await verifyQuest(
      { tier1: async () => tier1(false), tier2: async () => scan({ complete: true }) },
      ADDRESS,
    );

    assert.equal(out.completed, false);
    assert.equal(out.status, STATUS.CONFIRMED);
    assert.equal(out.source, SOURCE.TIER2);
  });

  test("an exhausted scan stays INDETERMINATE and carries the reason", async () => {
    const out = await verifyQuest(
      {
        tier1: async () => tier1(false),
        tier2: async () => scan({ exhausted: true, reason: "budget_exhausted" }),
      },
      ADDRESS,
    );

    assert.equal(out.completed, false);
    assert.equal(out.status, STATUS.INDETERMINATE);
    assert.equal(out.reason, "budget_exhausted");
  });

  test("a floor-unverified scan cannot produce a confirmed false", async () => {
    const out = await verifyQuest(
      {
        tier1: async () => tier1(false),
        tier2: async () => scan({ exhausted: true, reason: "floor_unverified" }),
      },
      ADDRESS,
    );

    assert.equal(out.status, STATUS.INDETERMINATE);
    assert.equal(out.reason, "floor_unverified");
  });

  // An unreliable Tier 1 says nothing — not even enough to justify the scan's cost.
  test("an unreliable Tier 1 does not escalate", async () => {
    let scanned = false;
    const out = await verifyQuest(
      {
        tier1: async () => tier1(false, { reliable: false }),
        tier2: async () => {
          scanned = true;
          return scan({ complete: true });
        },
      },
      ADDRESS,
    );

    assert.equal(out.status, STATUS.INDETERMINATE);
    assert.equal(out.reason, "tier1_unreliable");
    assert.equal(scanned, false);
  });

  test("Tier 2 reuses Tier 1's head rather than re-reading it", async () => {
    let headSeen = null;
    await verifyQuest(
      {
        tier1: async () => tier1(false, { checkedThroughBlock: 33_123_456 }),
        tier2: async (_addr, ctx) => {
          headSeen = ctx.head;
          return scan({ complete: true });
        },
      },
      ADDRESS,
    );

    assert.equal(headSeen, 33_123_456);
  });
});

describe("unavailable quests", () => {
  // daily_active cannot be a live scan: ~345,600 blocks ≈ 104s of getLogs against a 30s
  // limit, with no Tier 1 shortcut. It answers honestly rather than fabricating falses.
  test("daily_active answers 200 INDETERMINATE, not a false and not a 400", async () => {
    const res = await call({ body: { address: ADDRESS, quest: "daily_active" } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.completed, false);
    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.equal(res.body.source, null);
    assert.equal(res.body.reason, "needs_indexer");
  });

  test("an unavailable quest is never cached, so it cannot harden into a false", async () => {
    await call({ body: { address: ADDRESS, quest: "daily_active" } });
    const second = await call({ body: { address: ADDRESS, quest: "daily_active" } });

    assert.equal(second.body.source, null, "must not be served from cache");
    assert.equal(second.body.status, STATUS.INDETERMINATE);
  });
});

describe("composite quests", () => {
  const composite = (parts) => ({ id: "t_comp", kind: QUEST_KIND.COMPOSITE, parts });

  test("both parts complete → CONFIRMED complete", async () => {
    registerQuest("t_p1", { tier1: async () => tier1(true) });
    registerQuest("t_p2", { tier1: async () => tier1(true) });

    const out = await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(out.completed, true);
    assert.equal(out.status, STATUS.CONFIRMED);
    assert.equal(out.source, SOURCE.COMPOSED);
  });

  test("a PROVEN incomplete part → confirmed false", async () => {
    registerQuest("t_p1", { tier1: async () => tier1(true) });
    registerQuest("t_p2", {
      tier1: async () => tier1(false),
      tier2: async () => scan({ complete: true }),
    });

    const out = await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(out.completed, false);
    assert.equal(out.status, STATUS.CONFIRMED);
  });

  // Three-valued AND: unknown ∧ false is FALSE — a proven-false part settles the whole no
  // matter how uncertain the other part is. (Nothing is cached either way: a confirmed
  // false is not a cacheable result.)
  test("a proven false settles the composite even alongside an indeterminate part", async () => {
    registerQuest("t_p1", { tier1: async () => tier1(false) }); // indeterminate
    registerQuest("t_p2", {
      tier1: async () => tier1(false),
      tier2: async () => scan({ complete: true }),
    }); // proven false

    const out = await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(out.completed, false);
    assert.equal(out.status, STATUS.CONFIRMED);
  });

  // ...but unknown ∧ true is UNKNOWN: an unsettled part with nothing to short-circuit on
  // must not yield a settled whole.
  test("an indeterminate part alongside a complete one stays indeterminate", async () => {
    registerQuest("t_p1", { tier1: async () => tier1(false) }); // indeterminate
    registerQuest("t_p2", { tier1: async () => tier1(true) }); // confirmed complete

    const out = await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(out.status, STATUS.INDETERMINATE);
    assert.equal(out.reason, "part_indeterminate");
  });

  test("reports the LEAST-checked part's block, not the most", async () => {
    registerQuest("t_p1", { tier1: async () => tier1(true, { checkedThroughBlock: 100 }) });
    registerQuest("t_p2", { tier1: async () => tier1(true, { checkedThroughBlock: 90 }) });

    const out = await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(out.checkedThroughBlock, 90);
  });

  test("parts resolve through the cache, so a repeat composite is free", async () => {
    let p1Checks = 0;
    registerQuest("t_p1", {
      tier1: async () => {
        p1Checks++;
        return tier1(true);
      },
    });
    registerQuest("t_p2", { tier1: async () => tier1(true) });

    await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);
    await verifyQuest(composite(["t_p1", "t_p2"]), ADDRESS);

    assert.equal(p1Checks, 1, "the second composite must reuse the cached part");
  });
});

describe("the registry", () => {
  test("registers exactly the five planned quests", () => {
    assert.deepEqual(Object.keys(QUESTS).filter((id) => !id.startsWith("t_")).sort(), [
      "both_products",
      "daily_active",
      "first_prediction",
      "first_trade",
      "provide_liquidity",
    ]);
  });

  test("every one-time quest has both tiers wired", () => {
    for (const id of ["first_trade", "first_prediction", "provide_liquidity"]) {
      assert.equal(typeof QUESTS[id].tier1, "function", `${id} tier1`);
      assert.equal(typeof QUESTS[id].tier2, "function", `${id} tier2`);
    }
  });

  test("both_products composes the two product quests", () => {
    assert.deepEqual(QUESTS.both_products.parts, ["first_trade", "first_prediction"]);
    assert.equal(QUESTS.both_products.kind, QUEST_KIND.COMPOSITE);
  });
});
