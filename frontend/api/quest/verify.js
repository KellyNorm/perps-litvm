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
//           plus `reason` whenever the answer is not settled, `coverage` whenever a Tier 2
//           scan has walked anything — see withCoverage() for why a depth belongs in the
//           envelope rather than only in the database — and `index` on a negative the index
//           proved without walking, carrying the same claim in the same auditable spirit.

import { createLimiter, memoryDriver } from "../_lib/rateLimit.js";
import { cacheKey, createCache, memoryCacheDriver, nullCacheDriver, utcDay } from "../_lib/quest/cache.js";
import { createCursorStore, memoryCursorDriver, nullCursorDriver } from "../_lib/quest/cursor.js";
import { supabaseCacheDriver } from "../_lib/quest/supabaseCache.js";
import { supabaseCursorDriver } from "../_lib/quest/supabaseCursor.js";
import { supabaseIndexProofDriver } from "../_lib/quest/supabaseIndexProof.js";
import { supabaseIndexerStateDriver } from "../_lib/quest/supabaseIndexerState.js";
import { createIndexerState } from "../_lib/quest/indexerState.js";
import { PROOF, createIndexProof } from "../_lib/quest/indexProof.js";
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

// Likewise module-scoped: a warm instance reuses whatever the cache remembers, which is
// the only reason an in-memory driver caches anything at all.
//
// QUEST_CACHE selects the driver:
//   "memory"   (default) in-process, per-instance, lost on cold start
//   "supabase"           durable, shared across instances and deploys
//   "none"               always miss — for debugging a wallet whose cached completion you
//                        want to bypass. Safe to leave on: the cache only ever holds
//                        proven completions, so disabling it costs latency and nothing else.
//
// "supabase" DEGRADES TO MEMORY rather than failing, and says so loudly. A missing or
// typo'd SUPABASE_* var is a configuration mistake, and the honest response to it is a
// slower-but-correct endpoint plus an error in the log — not a 503 on every verification,
// which is what throwing from this request-path constructor would produce. The failure
// mode is lost durability, never a wrong answer.
let cache;
function getCache() {
  if (!cache) {
    cache = createCache(selectDriver((process.env.QUEST_CACHE || "memory").trim()));
  }
  return cache;
}

function selectDriver(mode) {
  if (mode === "none") return nullCacheDriver();

  if (mode === "supabase") {
    const driver = supabaseCacheDriver();
    if (driver) return driver;

    console.error(
      "[quest] QUEST_CACHE=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both " +
        "set — falling back to the in-memory cache. Verification is unaffected; durability is lost.",
    );
    return memoryCacheDriver();
  }

  return memoryCacheDriver();
}

// The COVERAGE cursor store — separate from the verdict cache above, and separate on
// purpose: that one holds answers, this one holds which block ranges have been walked. See
// the header of _lib/quest/cursor.js for why conflating them would be a correctness bug
// rather than a tidiness one.
//
// QUEST_CURSOR selects the driver and defaults to whatever QUEST_CACHE selected, because in
// practice they share a project and a key and nobody wants to set two vars to the same
// value. Setting it explicitly is the kill switch: QUEST_CURSOR=none disables resume and
// every poll walks from head again — slower, and incapable of settling a deep wallet, but
// never wrong. Useful when a wallet's stored coverage is suspect.
let cursors;
function getCursors() {
  if (!cursors) {
    const mode = (process.env.QUEST_CURSOR || process.env.QUEST_CACHE || "memory").trim();
    cursors = createCursorStore(selectCursorDriver(mode));
  }
  return cursors;
}

function selectCursorDriver(mode) {
  if (mode === "none") return nullCursorDriver();

  if (mode === "supabase") {
    const driver = supabaseCursorDriver();
    if (driver) return driver;

    console.error(
      "[quest] QUEST_CURSOR=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both " +
        "set — falling back to in-memory coverage. Verification is unaffected; deep-history " +
        "wallets will stay indeterminate because coverage no longer survives a cold start.",
    );
    return memoryCursorDriver();
  }

  return memoryCursorDriver();
}

// The INDEX PROOF — the zero-chunk answer for a quest whose sources have been swept to the
// floor. Third store, third variable, same pattern, and it is OFF unless it is explicitly
// pointed at Supabase, because there is nothing else it could read: the proof is a join
// across quest_backfill, quest_completion and indexer_state.
//
// QUEST_INDEX_PROOF defaults to whatever QUEST_CACHE selected, like QUEST_CURSOR, so a
// correctly configured deployment gets it without a fourth variable to keep in step.
// Setting it explicitly is THE ROLLBACK: QUEST_INDEX_PROOF=none disables the fast path and
// every verification goes back to the resumable scan — slower, and identical in every
// answer it is allowed to give, because both derive their falses from coverage. That is a
// one-env-var revert with no redeploy, which is what a new path to a confirmed false should
// have on its first day in production.
//
// `undefined` means "not built yet"; `null` means "built, and disabled".
let indexProof;
function getIndexProof() {
  if (indexProof === undefined) {
    indexProof = buildIndexProof((process.env.QUEST_INDEX_PROOF || process.env.QUEST_CACHE || "memory").trim());
  }
  return indexProof;
}

function buildIndexProof(mode) {
  if (mode !== "supabase") return null;

  const backfill = supabaseIndexProofDriver();
  const stateDriver = supabaseIndexerStateDriver();
  if (!backfill || !stateDriver) {
    console.error(
      "[quest] QUEST_INDEX_PROOF=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both " +
        "set — the zero-chunk path is disabled and verification falls back to the scan. Answers are " +
        "unaffected; deep-history wallets are slow again.",
    );
    return null;
  }

  return createIndexProof({ backfill, indexerState: createIndexerState(stateDriver) });
}

/**
 * Test seam: drop all three cached stores so the next request rebuilds them from current
 * env. All three, not just the cache — they are configured by different vars and a test
 * that changes one would otherwise keep a store built from the previous environment.
 */
export function _resetCache() {
  cache = null;
  cursors = null;
  indexProof = undefined;
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
    const result = await resolveQuest(definition, address);
    return send(res, 200, { ...result, address, quest });
  } catch (err) {
    // Two distinct 503s, because they need different fixes: ConfigError means WE are
    // misconfigured (a missing address env var), anything else means the chain read
    // failed. Neither is cached — see cache.js.
    const reason = err instanceof ConfigError ? "not_configured" : "rpc_unavailable";
    console.error(`[quest] ${reason} verifying ${quest}:`, err?.message);
    return send(res, 503, {
      address,
      quest,
      // Non-200: no consumer should read `completed` here. It stays a boolean rather than
      // null purely so the response schema does not change shape between statuses.
      completed: false,
      status: STATUS.UNAVAILABLE,
      source: null,
      checkedThroughBlock: null,
      reason,
    });
  }
}

/**
 * Cache-first resolution of one quest. This is the single entry point for a verdict —
 * both the handler and composite quests go through it, which is what makes
 * `both_products` free for a wallet that has already verified its two parts.
 */
export async function resolveQuest(definition, address) {
  const key = cacheKey({
    chainId: chainId(),
    quest: definition.id,
    address,
    bucket: definition.kind === QUEST_KIND.DAILY ? utcDay() : null,
  });

  const hit = await getCache().get(key);
  if (hit) return { ...hit, source: SOURCE.CACHE };

  const result = await verifyQuest(definition, address);

  // Silently ignored unless this is a proven completion — see the policy in cache.js. The
  // one exception is an answer the INDEX gave us: the row we would write is the row we just
  // read, and the write is a merge-duplicates upsert, so it would overwrite the provenance
  // the indexer recorded (`backfill`/`indexer`) with our own for no gain at all.
  if (result.source !== SOURCE.INDEX) await getCache().set(key, result);

  return result;
}

/**
 * Run a quest's tiers and turn them into a verdict. Exported so the tier→status mapping —
 * the rule this endpoint exists to get right — is unit-testable without HTTP or a chain.
 *
 * THE TWO ROUTES TO A CONFIRMED FALSE, and they make the identical claim from the identical
 * kind of evidence — coverage of every source from a validated floor up to the block being
 * reported, with no hole anywhere in it:
 *
 *   1. a Tier 2 scan that walked it, per wallet, accumulated over polls (scan.js);
 *   2. the index proof, which joins coverage the backfill walked once for everybody to
 *      coverage the forward indexer has walked since (indexProof.js).
 *
 * Everything short of one of those is indeterminate: a Tier 1 false cannot tell "never
 * traded" from "traded and closed", and a budget-limited scan cannot tell "never" from "not
 * in the range we managed to read".
 */
export async function verifyQuest(definition, address) {
  // A registered quest we cannot yet answer (daily_active until the indexer exists). It
  // gets an honest indeterminate rather than a fabricated false.
  if (definition.available === false) {
    return {
      completed: false,
      status: STATUS.INDETERMINATE,
      source: null,
      checkedThroughBlock: null,
      reason: definition.unavailableReason ?? "not_yet_available",
    };
  }

  if (definition.kind === QUEST_KIND.COMPOSITE) {
    return composeQuest(definition, address);
  }

  const tier1 = await definition.tier1(address);

  // A positive is proof and stops here — no scan needed.
  if (tier1.completed) {
    return {
      completed: true,
      status: STATUS.CONFIRMED,
      source: SOURCE.TIER1,
      checkedThroughBlock: tier1.checkedThroughBlock,
    };
  }

  // A Tier 1 false whose reads did not all land says nothing at all — not even enough to
  // justify the cost of a scan.
  if (!tier1.reliable) {
    return {
      completed: false,
      status: STATUS.INDETERMINATE,
      source: SOURCE.TIER1,
      checkedThroughBlock: tier1.checkedThroughBlock,
      reason: "tier1_unreliable",
    };
  }

  // THE ZERO-CHUNK PATH. Before spending ~10s of eth_getLogs, ask whether the index already
  // knows: the backfill swept every source to its floor once, unfiltered, for every wallet
  // that has ever existed, and the forward indexer has covered everything since. If those
  // two coverages join with no hole, this wallet's answer is a lookup rather than a walk —
  // and it is available on the FIRST poll rather than the two-hundredth.
  //
  // It returns null unless it PROVED something, and a null costs one round trip of three
  // parallel indexed reads before the scan runs exactly as it does today. So the fast path
  // can be wrong only by being slow.
  const proven = await resolveFromIndex(definition, address, tier1.checkedThroughBlock);
  if (proven) return proven;

  if (!definition.tier2) {
    return {
      completed: false,
      status: STATUS.INDETERMINATE,
      source: SOURCE.TIER1,
      checkedThroughBlock: tier1.checkedThroughBlock,
    };
  }

  // Reuses Tier 1's head, so both tiers together cost one eth_blockNumber.
  //
  // The cursor store makes this scan RESUMABLE: it picks up the coverage earlier polls
  // accumulated for this (chain, wallet, quest) and extends it at both ends. That is what
  // lets `scan.complete` below eventually become true for a wallet whose history is far
  // deeper than one invocation's budget — the answer converges over polls instead of
  // returning indeterminate forever.
  const scan = await definition.tier2(address, {
    head: tier1.checkedThroughBlock,
    chainId: chainId(),
    quest: definition.id,
    cursors: getCursors(),
  });

  if (scan.found) {
    return {
      completed: true,
      status: STATUS.CONFIRMED,
      source: SOURCE.TIER2,
      checkedThroughBlock: tier1.checkedThroughBlock,
    };
  }

  // The one path to a confirmed false: every source covered from a validated floor up to
  // head, no holes. `complete` is DERIVED from the accumulated coverage on every call and
  // is never read out of storage — see coverageProvesAbsence() in scan.js. Nothing anywhere
  // persists a negative; what persists is which blocks were read.
  if (scan.complete) {
    return {
      completed: false,
      status: STATUS.CONFIRMED,
      source: SOURCE.TIER2,
      checkedThroughBlock: tier1.checkedThroughBlock,
      // Included on the proven false too, where every entry reads remaining: 0. That is the
      // claim being made, in the same shape a caller has been watching descend — so a
      // confirmed false can be audited rather than taken on trust.
      ...withCoverage(scan),
    };
  }

  return {
    completed: false,
    status: STATUS.INDETERMINATE,
    source: SOURCE.TIER2,
    checkedThroughBlock: tier1.checkedThroughBlock,
    reason: scan.reason ?? "scan_incomplete",
    ...withCoverage(scan),
  };
}

/**
 * Ask the index whether this wallet's answer is already known, without walking anything.
 *
 * @returns {Promise<object|null>} a verdict, or null meaning "the index could not prove it
 *   — carry on to the scan". NULL IS THE ONLY WAY THIS DECLINES: it never returns an
 *   indeterminate of its own, because the scan below is strictly better informed than a
 *   guess about why the proof did not hold.
 *
 * The proof is skipped entirely for a quest with no `indexSources` (provide_liquidity,
 * until its backfill reaches the floor) and when the fast path is unconfigured or disabled.
 * A ConfigError from indexSources() propagates deliberately: it means an address env var is
 * missing, tier2 would throw the identical error one line later, and a missing address must
 * surface as `not_configured` rather than as a silently narrower proof.
 */
async function resolveFromIndex(definition, address, head) {
  if (typeof definition.indexSources !== "function") return null;

  const proof = getIndexProof();
  if (!proof) return null;

  const result = await proof.resolve({
    chainId: chainId(),
    wallet: address,
    quest: definition.id,
    sources: definition.indexSources(),
    head,
  });

  if (result.answer === PROOF.COMPLETED) {
    return {
      completed: true,
      status: STATUS.CONFIRMED,
      source: SOURCE.INDEX,
      // The block the completion was recorded against, exactly as the cache reports it.
      checkedThroughBlock: result.checkedThroughBlock,
    };
  }

  if (result.answer === PROOF.ABSENT) {
    return {
      completed: false,
      status: STATUS.CONFIRMED,
      source: SOURCE.INDEX,
      // The index's minimum watermark, NOT head. See indexProof.js.
      checkedThroughBlock: result.checkedThroughBlock,
      // The claim, in auditable form — the same reasoning as `coverage` on a scanned false:
      // a confirmed negative should be checkable rather than taken on trust, and here the
      // thing worth showing is where the two halves of the coverage meet.
      index: result.index,
    };
  }

  // Not an error — "the index cannot answer this one yet" is the expected state for most of
  // a backfill's life. Logged at info level so a fast path that has quietly stopped firing
  // is visible in the function log rather than only as a latency regression.
  console.log(`[quest] index proof declined ${definition.id}: ${result.detail} — falling back to the scan`);
  return null;
}

/**
 * Report how far the accumulated walk has got, per source.
 *
 * WHY THIS IS IN THE ENVELOPE. A deep-history indeterminate and a permanently stuck one are
 * the same three fields otherwise, and they need opposite responses: the first is "poll me
 * again", the second is "something is broken" — a cursor table that was never migrated, a
 * store outage, a floor that will not validate. Without a depth, the only way to tell them
 * apart is direct database access, which the caller does not have and should not need.
 *
 * `remaining` is the useful number and is derived rather than stored, like everything else
 * here: it is exactly what is left to walk before this source could support a negative.
 * `scannedFrom` is what distinguishes "still descending" (it equals checkedThroughBlock)
 * from "the top gap did not close" (it lags) — two very different reasons to be waiting.
 *
 * Addresses are reported in full, not truncated: they are public contract addresses the
 * frontend already uses, and they are the key of the quest_cursor row this line describes,
 * so a truncated form could not be correlated with anything.
 *
 * Omitted entirely — never an empty array — when there is nothing to report: a found event
 * writes no coverage, and a cache hit did no scanning at all.
 */
function withCoverage(scan) {
  if (!Array.isArray(scan.coverage) || scan.coverage.length === 0) return {};

  return {
    coverage: scan.coverage.map((c) => ({
      source: c.sourceKey,
      scannedFrom: c.scannedFrom,
      scannedTo: c.scannedTo,
      floor: c.floorBlock,
      remaining: c.scannedTo - c.floorBlock,
    })),
  };
}

/**
 * A composite quest is the AND of its parts, resolved through the ordinary cache-first
 * path so it issues no chain calls of its own beyond what the parts need.
 *
 * THREE-VALUED AND (Kleene), because a part can be unknown:
 *   all parts complete            → confirmed true
 *   any part PROVEN incomplete    → confirmed false  (unknown ∧ false is still false, so a
 *                                   proven-false part settles the whole on its own)
 *   otherwise (an unknown part)   → indeterminate    (unknown ∧ true is unknown)
 * The last line is the one that matters: a part we could not settle must not be allowed to
 * produce a settled TRUE for the whole.
 */
async function composeQuest(definition, address) {
  const parts = await Promise.all(
    definition.parts.map((id) => {
      const part = getQuest(id);
      // A registry typo would otherwise surface as a null-dereference and be reported as
      // "rpc_unavailable" — a misleading 503 for what is our own config error.
      if (!part) throw new ConfigError(`${definition.id} names unknown part quest ${JSON.stringify(id)}`);
      return resolveQuest(part, address);
    }),
  );

  // Conservative: the composite is only checked as far as its least-checked part.
  const blocks = parts.map((p) => p.checkedThroughBlock).filter((b) => typeof b === "number");
  const checkedThroughBlock = blocks.length === parts.length ? Math.min(...blocks) : null;

  if (parts.every((p) => p.completed)) {
    return { completed: true, status: STATUS.CONFIRMED, source: SOURCE.COMPOSED, checkedThroughBlock };
  }

  if (parts.some((p) => p.completed === false && p.status === STATUS.CONFIRMED)) {
    return { completed: false, status: STATUS.CONFIRMED, source: SOURCE.COMPOSED, checkedThroughBlock };
  }

  return {
    completed: false,
    status: STATUS.INDETERMINATE,
    source: SOURCE.COMPOSED,
    checkedThroughBlock,
    reason: "part_indeterminate",
  };
}

/**
 * Single success/verdict exit, so every answer has the documented shape:
 *   { address, quest, completed, status, source, checkedThroughBlock, asOf }
 * plus `reason` whenever the answer is not a settled one — a short code naming WHY — and
 * `coverage` whenever a scan walked anything, naming HOW FAR. Together they are what make
 * an indeterminate actionable instead of mysterious.
 */
function send(res, status, verdict) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Per-wallet and time-sensitive: a cached HTTP response would hand a stale "not
  // completed" to the next caller. Our own cache is the only caching layer allowed.
  res.setHeader("cache-control", "no-store");

  return res.status(status).json({ ...verdict, asOf: new Date().toISOString() });
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
