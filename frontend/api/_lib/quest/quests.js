// Quest registry: the single source of truth for which quest ids exist and how each one
// is verified. The handler knows nothing about any individual quest — it looks the id up
// here, runs whatever tiers are registered, and shapes the envelope.
//
// Unregistered ids are a 400, not a false — answering "not completed" for a quest we
// cannot check would be the exact silent-wrong-answer failure this endpoint exists to
// avoid. A registered-but-unavailable quest (daily_active) is different: it is a real id
// the platform will call, so it answers 200 INDETERMINATE rather than pretending to know.

import {
  firstPredictionTier1,
  firstPredictionTier2,
  firstTradeTier1,
  firstTradeTier2,
  provideLiquidityTier1,
  provideLiquidityTier2,
} from "./checks.js";

/**
 * The three answers this endpoint can give. `indeterminate` is the load-bearing one: it
 * means "we could not prove it either way", and it must NEVER be persisted as a
 * permanent false — see cache.js, which enforces that structurally.
 */
export const STATUS = {
  CONFIRMED: "confirmed",
  INDETERMINATE: "indeterminate",
  UNAVAILABLE: "unavailable",
};

/** Where an answer came from, reported in the envelope for debuggability. */
export const SOURCE = {
  TIER1: "tier1",
  TIER2: "tier2",
  CACHE: "cache",
  COMPOSED: "composed",
};

export const QUEST_KIND = {
  // Once true, true forever — cacheable permanently.
  ONE_TIME: "one_time",
  // True only for the current UTC day; the cache key carries the day, so yesterday's
  // `true` is simply a different key rather than something that has to be expired.
  DAILY: "daily",
  // Answered by composing other quests' results; issues no chain calls of its own.
  COMPOSITE: "composite",
};

export const QUESTS = {
  first_trade: {
    id: "first_trade",
    kind: QUEST_KIND.ONE_TIME,
    tier1: firstTradeTier1,
    tier2: firstTradeTier2,
  },

  first_prediction: {
    id: "first_prediction",
    kind: QUEST_KIND.ONE_TIME,
    tier1: firstPredictionTier1,
    tier2: firstPredictionTier2,
  },

  provide_liquidity: {
    id: "provide_liquidity",
    kind: QUEST_KIND.ONE_TIME,
    tier1: provideLiquidityTier1,
    tier2: provideLiquidityTier2,
  },

  // Composition only — issues no chain calls of its own. Each part is resolved through the
  // ordinary cache-first path, so a wallet that already verified both quests is answered
  // entirely from cache.
  both_products: {
    id: "both_products",
    kind: QUEST_KIND.COMPOSITE,
    parts: ["first_trade", "first_prediction"],
    tier1: null,
    tier2: null,
  },

  // NOT SHIPPABLE AS A LIVE SCAN, and deliberately registered anyway.
  //
  // "Active in the last 24h" spans ~345,600 blocks. At the measured ~0.3ms/block that is
  // ~104 seconds of eth_getLogs — over triple the function's 30s ceiling — and unlike the
  // one-time quests it has no Tier 1 shortcut, because there is no current-state read that
  // means "did something today".
  //
  // So it answers INDETERMINATE every time, honestly, rather than shipping a check that
  // structurally cannot complete and would hand out a stream of wrong falses. It needs the
  // forward indexer (phase 2): rows written as events arrive turn this into an O(1) "is
  // there a row for this wallet today" lookup instead of a backward walk.
  daily_active: {
    id: "daily_active",
    kind: QUEST_KIND.DAILY,
    available: false,
    unavailableReason: "needs_indexer",
    tier1: null,
    tier2: null,
  },
};

export const QUEST_IDS = Object.keys(QUESTS);

/**
 * Look up a quest by id. Uses hasOwnProperty rather than a bare property read because the
 * id is caller-controlled: `QUESTS["constructor"]` would otherwise hand back a function
 * and turn a bad request into a 500.
 */
export function getQuest(id) {
  if (typeof id !== "string") return null;
  return Object.prototype.hasOwnProperty.call(QUESTS, id) ? QUESTS[id] : null;
}
