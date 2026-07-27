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

// daily_active used to live here as the one registered-but-unavailable quest. It is now
// answered by the participation index (see dailyActive.test.js for its behaviour, which
// needs injected storage to stay offline). The `available: false` PATH still exists for any
// future quest that needs it, and the property these tests protect — a quest we cannot
// answer says so, and that answer never hardens — has to stay covered.
describe("unavailable quests", () => {
  test("a registered-but-unavailable quest answers 200 INDETERMINATE, not a false and not a 400", async () => {
    const quest = registerQuest("t_unavail", { available: false, unavailableReason: "needs_something" });

    const res = await call({ body: { address: ADDRESS, quest } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.completed, false);
    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.equal(res.body.source, null);
    assert.equal(res.body.reason, "needs_something");
  });

  test("an unavailable quest is never cached, so it cannot harden into a false", async () => {
    const quest = registerQuest("t_unavail2", { available: false, unavailableReason: "needs_something" });

    await call({ body: { address: ADDRESS, quest } });
    const second = await call({ body: { address: ADDRESS, quest } });

    assert.equal(second.body.source, null, "must not be served from cache");
    assert.equal(second.body.status, STATUS.INDETERMINATE);
  });

  // daily_active is a real registry entry again, so this only checks it is ROUTABLE — a
  // valid id rather than a 400. What it answers is dailyActive.test.js's business.
  test("daily_active is a valid quest id", () => {
    assert.equal(normalizeQuestBody({ address: ADDRESS, quest: "daily_active" }).ok, true);
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

// ============================================================================
// TIER 2 RESUME — the endpoint's half of the convergence story.
// ============================================================================
describe("tier 2 resume wiring", () => {
  const exhausted = () => ({
    found: false,
    complete: false,
    exhausted: true,
    coverage: [],
    reason: "budget_exhausted",
  });
  const proven = () => ({ found: false, complete: true, exhausted: false, coverage: [], reason: null });

  test("tier2 is handed the coverage store alongside the head it already fetched", async () => {
    let seen;
    const id = registerQuest("cursor_probe", {
      tier1: async () => tier1(false),
      tier2: async (_address, opts) => {
        seen = opts;
        return exhausted();
      },
    });

    await verifyQuest(QUESTS[id], ADDRESS);

    // Everything the cursor row is keyed by must reach the scan, or coverage would be
    // filed under the wrong key and silently never resumed.
    assert.equal(seen.head, 33_000_000, "still reuses Tier 1's head — one eth_blockNumber");
    assert.equal(seen.quest, id);
    assert.equal(typeof seen.chainId, "number");
    assert.equal(typeof seen.cursors.load, "function");
    assert.equal(typeof seen.cursors.save, "function");
  });

  // The whole point of step 3, seen from outside: the same wallet asking the same question
  // gets a different, better answer as coverage accumulates.
  test("a deep wallet answers indeterminate until coverage settles, then confirmed", async () => {
    let polls = 0;
    const id = registerQuest("converging", {
      tier1: async () => tier1(false),
      tier2: async () => (++polls < 3 ? exhausted() : proven()),
    });

    const answers = [];
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);
      answers.push([res.body.status, res.body.completed, res.body.reason ?? null]);
    }

    assert.deepEqual(answers, [
      [STATUS.INDETERMINATE, false, "budget_exhausted"],
      [STATUS.INDETERMINATE, false, "budget_exhausted"],
      [STATUS.CONFIRMED, false, null],
    ]);
    // If an indeterminate were ever cached, polls would stop at 1 and the wallet would be
    // stuck on "we don't know" forever — the exact failure this endpoint exists to avoid.
    assert.equal(polls, 3, "an indeterminate must never be cached; every poll re-verifies");
  });

  test("even a PROVEN false is re-verified rather than hardened", async () => {
    let polls = 0;
    const id = registerQuest("proven_false", {
      tier1: async () => tier1(false),
      tier2: async () => {
        polls++;
        return proven();
      },
    });

    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);
      assert.equal(res.body.status, STATUS.CONFIRMED);
      assert.equal(res.body.completed, false);
    }

    // A false is only true until the user does the thing — which, on a quest board, is what
    // they are about to do. Coverage is durable; the verdict derived from it is not.
    assert.equal(polls, 2, "a confirmed false must not be cached");
  });

  test("a scan that finds the event still short-circuits to a cached completion", async () => {
    let polls = 0;
    const id = registerQuest("found_then_cached", {
      tier1: async () => tier1(false),
      tier2: async () => {
        polls++;
        return { found: true, complete: true, exhausted: false, coverage: [], reason: null };
      },
    });

    const first = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), first);
    const second = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), second);

    assert.equal(first.body.completed, true);
    assert.equal(first.body.source, SOURCE.TIER2);
    assert.equal(second.body.source, SOURCE.CACHE, "a proven completion is the one thing kept");
    assert.equal(polls, 1, "and it is never re-scanned");
  });
});

// ============================================================================
// SCAN DEPTH IN THE ENVELOPE. A deep indeterminate and a stuck one are otherwise
// indistinguishable from outside, and they call for opposite responses.
// ============================================================================
describe("coverage reporting", () => {
  const scan = (over = {}) => ({
    found: false,
    complete: false,
    exhausted: true,
    reason: "budget_exhausted",
    coverage: [
      { sourceKey: "0xaaa", floorBlock: 23_302_630, scannedFrom: 33_000_000, scannedTo: 33_000_000 - 200_000, dirty: true },
    ],
    ...over,
  });

  test("an indeterminate reports how far each source has been walked", async () => {
    const id = registerQuest("depth", { tier1: async () => tier1(false), tier2: async () => scan() });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.deepEqual(res.body.coverage, [
      {
        source: "0xaaa",
        scannedFrom: 33_000_000,
        scannedTo: 32_800_000,
        floor: 23_302_630,
        // The actionable number: how much is left before this source could support a false.
        remaining: 32_800_000 - 23_302_630,
      },
    ]);
  });

  // Watching this shrink across polls IS the convergence, seen from outside.
  test("remaining shrinks as coverage accumulates", async () => {
    let depth = 33_000_000;
    const id = registerQuest("shrinking", {
      tier1: async () => tier1(false),
      tier2: async () => {
        depth -= 200_000;
        return scan({ coverage: [{ sourceKey: "0xaaa", floorBlock: 23_302_630, scannedFrom: 33_000_000, scannedTo: depth, dirty: true }] });
      },
    });

    const seen = [];
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);
      seen.push(res.body.coverage[0].remaining);
    }

    assert.ok(seen[0] > seen[1] && seen[1] > seen[2], `expected a descending walk, got ${seen}`);
  });

  test("a proven false reports remaining: 0 — the claim, in auditable form", async () => {
    const id = registerQuest("proven", {
      tier1: async () => tier1(false),
      tier2: async () =>
        scan({
          complete: true,
          exhausted: false,
          reason: null,
          coverage: [{ sourceKey: "0xaaa", floorBlock: 23_302_630, scannedFrom: 33_000_000, scannedTo: 23_302_630, dirty: true }],
        }),
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.CONFIRMED);
    assert.equal(res.body.completed, false);
    assert.equal(res.body.coverage[0].remaining, 0);
  });

  // scannedFrom lagging checkedThroughBlock is the signature of a top gap that did not
  // close — a different problem from "still descending", and invisible without this field.
  test("a lagging scannedFrom is visible against checkedThroughBlock", async () => {
    const id = registerQuest("stale_top", {
      tier1: async () => tier1(false),
      tier2: async () =>
        scan({ coverage: [{ sourceKey: "0xaaa", floorBlock: 0, scannedFrom: 32_900_000, scannedTo: 32_800_000, dirty: false }] }),
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.checkedThroughBlock, 33_000_000);
    assert.ok(res.body.coverage[0].scannedFrom < res.body.checkedThroughBlock);
  });

  test("a found event reports no coverage — there is nothing left to walk", async () => {
    const id = registerQuest("found", {
      tier1: async () => tier1(false),
      tier2: async () => scan({ found: true, complete: true, exhausted: false, reason: null, coverage: [] }),
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.completed, true);
    assert.ok(!("coverage" in res.body), "the field is omitted, not an empty array");
  });

  test("a cache hit reports no coverage — nothing was scanned", async () => {
    const id = registerQuest("cached", {
      tier1: async () => tier1(true),
      tier2: async () => scan(),
    });

    const first = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), first);
    const second = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), second);

    assert.equal(second.body.source, SOURCE.CACHE);
    assert.ok(!("coverage" in second.body));
  });

  test("a scan that walked nothing omits the field rather than reporting an empty walk", async () => {
    const id = registerQuest("nothing", {
      tier1: async () => tier1(false),
      tier2: async () => scan({ coverage: [] }),
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.ok(!("coverage" in res.body));
  });
});

// ============================================================================
// THE ZERO-CHUNK PATH — the second route to a confirmed false.
// ============================================================================
// Wired END TO END rather than against a fake proof object: process.env plus a stubbed
// global fetch drives verify.js → indexProof.js → both PostgREST drivers, so the URLs, the
// env gating and the tier ordering are all covered here rather than assumed.
//
// Every test quest declares `floor: 0`, which is what keeps the suite offline: verifySourceFloor
// short-circuits at a genesis floor ("nothing can exist below it") instead of reaching for
// eth_getCode. The floor check itself is covered in indexProof.test.js, where it is injected.

describe("the index proof", () => {
  const PM = "0x9396d36f713302ff39e0ba5b38012656f8e4eacf";
  const HEAD = 33_000_000;

  const realFetch = globalThis.fetch;
  const savedEnv = {};

  before(() => {
    for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "QUEST_INDEX_PROOF", "QUEST_CACHE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.QUEST_INDEX_PROOF = "supabase";
    // The verdict cache stays in memory, so the only thing reading through the stub below is
    // the proof itself — a cache hit would answer before the proof ever ran.
    delete process.env.QUEST_CACHE;
  });

  after(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A PostgREST stub, routed by table. Records what was asked for. */
  function serve({ completion = [], backfill = [{ source_key: PM, floor_block: 0, covered_from: 32_500_000, covered_to: 0 }], state = [{ source_key: PM, last_block: 32_999_900, updated_at: new Date().toISOString(), completion_from: 32_000_000 }] } = {}) {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      const rows = url.includes("/quest_completion?")
        ? completion
        : url.includes("/quest_backfill?")
          ? backfill
          : url.includes("/indexer_state?")
            ? state
            : null;
      if (rows === null) return { ok: false, status: 404, json: async () => [] };
      return { ok: true, status: 200, json: async () => rows };
    };
    return seen;
  }

  const indexed = (over = {}) =>
    registerQuest("indexed", {
      tier1: async () => tier1(false, { checkedThroughBlock: HEAD }),
      indexSources: () => [{ address: PM, floor: 0, label: "PositionManager" }],
      ...over,
    });

  test("a swept, fresh, gap-free index answers a confirmed false with no scan at all", async () => {
    serve();
    let scanned = false;
    const id = indexed({
      tier2: async () => {
        scanned = true;
        return scan({ exhausted: true });
      },
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.CONFIRMED);
    assert.equal(res.body.completed, false);
    assert.equal(res.body.source, SOURCE.INDEX);
    assert.equal(scanned, false, "the whole point: no getLogs");
    // The index's watermark, NOT the head Tier 1 saw.
    assert.equal(res.body.checkedThroughBlock, 32_999_900);
    assert.deepEqual(res.body.index.sources, [
      { source: PM, floor: 0, coveredFrom: 32_500_000, completionFrom: 32_000_000, indexedTo: 32_999_900 },
    ]);
  });

  test("a completion row is a confirmed true from the index", async () => {
    serve({ completion: [{ checked_through_block: 31_000_000 }] });
    const id = indexed({ tier2: async () => scan({ exhausted: true }) });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.CONFIRMED);
    assert.equal(res.body.completed, true);
    assert.equal(res.body.source, SOURCE.INDEX);
    assert.equal(res.body.checkedThroughBlock, 31_000_000);
  });

  // The invariant, end to end: an unfinished sweep must not shortcut anything.
  test("a sweep short of the floor falls through to the scan, and stays indeterminate", async () => {
    serve({ backfill: [{ source_key: PM, floor_block: 0, covered_from: 32_500_000, covered_to: 1_000 }] });
    let scanned = false;
    const id = indexed({
      tier2: async () => {
        scanned = true;
        return scan({ exhausted: true, reason: "budget_exhausted" });
      },
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(scanned, true, "an unproven index must not suppress the scan");
    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.equal(res.body.reason, "budget_exhausted");
  });

  test("a stale index falls through to the scan", async () => {
    serve({ state: [{ source_key: PM, last_block: 32_999_900, updated_at: new Date(Date.now() - 60 * 60_000).toISOString(), completion_from: 32_000_000 }] });
    const id = indexed({ tier2: async () => scan({ exhausted: true }) });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.equal(res.body.source, SOURCE.TIER2);
  });

  // A completion read that FAILED is the one thing that must never read as an absent row.
  test("an unreadable quest_completion never becomes a confirmed false", async () => {
    globalThis.fetch = async (url) =>
      url.includes("/quest_completion?")
        ? { ok: false, status: 500, json: async () => [] }
        : { ok: true, status: 200, json: async () => [] };

    const id = indexed({ tier2: async () => scan({ exhausted: true }) });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.status, STATUS.INDETERMINATE);
    assert.notEqual(res.body.source, SOURCE.INDEX);
  });

  // provide_liquidity's shape while its backfill is still running.
  test("a quest with no indexSources never consults the index", async () => {
    const seen = serve();
    const id = registerQuest("scanonly", {
      tier1: async () => tier1(false, { checkedThroughBlock: HEAD }),
      tier2: async () => scan({ complete: true }),
    });

    const res = mockRes();
    await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

    assert.equal(res.body.source, SOURCE.TIER2);
    assert.deepEqual(seen, [], "no Supabase read at all — an unopted quest pays nothing");
  });

  test("QUEST_INDEX_PROOF=none is the rollback: the scan path comes straight back", async () => {
    const seen = serve();
    process.env.QUEST_INDEX_PROOF = "none";
    _resetCache();

    try {
      const id = indexed({ tier2: async () => scan({ exhausted: true }) });
      const res = mockRes();
      await handler(mockReq({ body: { address: ADDRESS, quest: id } }), res);

      assert.equal(res.body.status, STATUS.INDETERMINATE);
      assert.deepEqual(seen, []);
    } finally {
      process.env.QUEST_INDEX_PROOF = "supabase";
      _resetCache();
    }
  });
});
