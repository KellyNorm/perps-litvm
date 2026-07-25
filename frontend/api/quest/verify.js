// POST /api/quest/verify — is this wallet's quest completed?
//
// WHY A SERVER ENDPOINT: a quest platform calls this to decide whether to credit a
// wallet, so the answer has to come from somewhere the caller cannot forge, and it has to
// survive an RPC that throttles. Neither is true of a browser check.
//
// READ-ONLY, NO MONEY PATH: no signer is ever constructed here or anywhere under
// _lib/quest/. This endpoint reads chain state and answers a yes/no question. It cannot
// move a wei, and it must never be given the ability to.
//
// ISOLATION: this file and _lib/quest/ import nothing from src/. The perps and prediction
// trees are untouched — see the porting note at the top of _lib/quest/chain.js.
//
// THE CENTRAL RULE — A NEGATIVE IS NEVER PERMANENT UNLESS IT IS PROVEN:
//   status=confirmed     we proved it, either way. completed:true is cacheable forever.
//   status=indeterminate we could not prove it. Neither answer is durable; the caller
//                        should retry. NEVER cached, so a timeout can never harden into
//                        "this wallet did nothing".
//   status=unavailable   we could not look (RPC down, misconfigured). 503, no cache write.
// Cheap-and-abusable checks run first, so a bad caller is rejected before costing us an
// RPC round trip: method → body size → validate → rate limit → cache → verify.
//
// Request:  { "address": "0x…", "quest": "first_trade" }
// Response: { address, quest, completed, status, source, checkedThroughBlock, asOf }

import { createLimiter, memoryDriver } from "../_lib/rateLimit.js";
import { cacheKey, createCache, nullCacheDriver, utcDay } from "../_lib/quest/cache.js";
import { ConfigError, chainId } from "../_lib/quest/chain.js";
import { QUEST_IDS, QUEST_KIND, SOURCE, STATUS, getQuest } from "../_lib/quest/quests.js";
import { clientKey } from "../_lib/request.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// The body is two short strings; anything larger is not a request we make.
const MAX_BODY_BYTES = 2 * 1024;

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Deliberately tighter than Tachy's limiter: a Tier 2 verification can spend ~15s of RPC
// budget, so the cost of an abusive caller here is measured in seconds, not tokens.
function limits() {
  return {
    perMinute: positiveInt(process.env.QUEST_RPM, 10),
    perHour: positiveInt(process.env.QUEST_RPH, 100),
  };
}

// Module scope so the counter survives across invocations on a warm instance — the only
// reason the in-memory driver limits anything at all. Same per-instance caveat as
// _lib/rateLimit.js: this bounds casual abuse, it does not defend funds.
let limiter;
function getLimiter() {
  if (!limiter) {
    const caps = limits();
    limiter = createLimiter({ driver: memoryDriver(), perMinute: caps.perMinute, perHour: caps.perHour });
  }
  return limiter;
}

// Likewise module-scoped: a warm instance reuses whatever the cache remembers. Stage 1
// wires the null driver, so every request is a live check; the point of building it in
// now is that the ORDER (cache before chain) is real and tested from the start.
let cache;
function getCache() {
  if (!cache) cache = createCache(nullCacheDriver());
  return cache;
}

/**
 * Validate the request body. Exported for unit tests — the caps have to be assertable
 * without standing up a server.
 *
 * @returns {{ok: true, value: {address, quest}} | {ok: false, status, reason}}
 */
export function normalizeQuestBody(rawBody) {
  let body = rawBody;

  // Vercel parses JSON automatically, but only when content-type says so; a client that
  // forgets the header would otherwise get a confusing 400.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, reason: "unparseable_body" };
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }

  const rawAddress = typeof body.address === "string" ? body.address.trim() : "";
  if (!rawAddress) return { ok: false, status: 400, reason: "missing_address" };
  if (!ADDRESS_RE.test(rawAddress)) return { ok: false, status: 400, reason: "invalid_address" };

  const rawQuest = typeof body.quest === "string" ? body.quest.trim() : "";
  if (!rawQuest) return { ok: false, status: 400, reason: "missing_quest" };
  // An unknown id is a 400 rather than `completed: false`. We cannot check a quest we do
  // not implement, and saying "no" to it would be a wrong answer dressed as a valid one.
  if (!getQuest(rawQuest)) return { ok: false, status: 400, reason: "unknown_quest" };

  return { ok: true, value: { address: rawAddress, quest: rawQuest } };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "method_not_allowed");
  }

  // content-length can lie, so this is only a cheap pre-parse rejection; the real
  // enforcement is the field validation below.
  const declared = Number.parseInt(req.headers?.["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(res, 413, "body_too_large");
  }

  const parsed = normalizeQuestBody(req.body);
  if (!parsed.ok) return fail(res, parsed.status, parsed.reason);

  const { address, quest } = parsed.value;

  const verdict = await getLimiter().check(clientKey(req));
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return fail(res, 429, `rate_limited_${verdict.scope}`);
  }

  const definition = getQuest(quest);

  try {
    const key = cacheKey({
      chainId: chainId(),
      quest,
      address,
      bucket: definition.kind === QUEST_KIND.DAILY ? utcDay() : null,
    });

    const hit = await getCache().get(key);
    if (hit) {
      return send(res, 200, { ...hit, address, quest, source: SOURCE.CACHE });
    }

    const result = await verifyQuest(definition, address);
    await getCache().set(key, result);

    return send(res, 200, { ...result, address, quest });
  } catch (err) {
    // Two distinct 503s, because they need different fixes: ConfigError means WE are
    // misconfigured (a missing address env var), anything else means the chain read
    // failed. Neither is cached — see cache.js.
    const reason = err instanceof ConfigError ? "not_configured" : "rpc_unavailable";
    console.error(`[quest] ${reason} verifying ${quest}:`, err?.message);
    return send(
      res,
      503,
      {
        address,
        quest,
        // Non-200: no consumer should read `completed` here. It stays a boolean rather
        // than null purely so the response schema does not change shape between statuses.
        completed: false,
        status: STATUS.UNAVAILABLE,
        source: null,
        checkedThroughBlock: null,
      },
      reason,
    );
  }
}

/**
 * Run a quest's tiers and turn them into a verdict. Exported so the tier→status mapping —
 * the rule this endpoint exists to get right — is unit-testable without HTTP or a chain.
 *
 * Stage 1 has Tier 1 only, so a Tier 1 false is INDETERMINATE, never a confirmed false:
 * an open position proves a trade, but a closed one leaves no current state, and until
 * the Tier 2 event scan exists we genuinely cannot tell "never traded" from "traded and
 * closed". Stage 3 adds the scan and only then can a false be confirmed.
 */
export async function verifyQuest(definition, address) {
  const tier1 = await definition.tier1(address);

  if (tier1.completed) {
    return {
      completed: true,
      status: STATUS.CONFIRMED,
      source: SOURCE.TIER1,
      checkedThroughBlock: tier1.checkedThroughBlock,
    };
  }

  return {
    completed: false,
    status: STATUS.INDETERMINATE,
    source: SOURCE.TIER1,
    checkedThroughBlock: tier1.checkedThroughBlock,
  };
}

/** Single success/verdict exit, so every answer has the documented shape. */
function send(res, status, verdict, reason = null) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Per-wallet and time-sensitive: a cached HTTP response would hand a stale "not
  // completed" to the next caller. Our own cache is the only caching layer allowed.
  res.setHeader("cache-control", "no-store");

  return res.status(status).json({
    ...verdict,
    asOf: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  });
}

/** Client-error exit: no verdict, because a malformed question has no answer. */
function fail(res, status, reason) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  return res.status(status).json({
    error: reason,
    // Listing the ids turns the commonest integration mistake — a typo'd or renamed quest
    // — into a self-answering error instead of a support round trip.
    ...(reason === "unknown_quest" ? { validQuests: QUEST_IDS } : {}),
  });
}
