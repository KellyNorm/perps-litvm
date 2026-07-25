// Quest registry: the single source of truth for which quest ids exist and how each one
// is verified. The handler knows nothing about any individual quest — it looks the id up
// here, runs whatever tiers are registered, and shapes the envelope.
//
// STAGE 1 registers `first_trade` only, and only its Tier 1. Unregistered ids are a 400,
// not a false — answering "not completed" for a quest we cannot actually check would be
// the exact silent-wrong-answer failure this endpoint exists to avoid.

import { firstTradeTier1 } from "./checks.js";

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
    tier2: null, // PositionOpened scan — stage 3
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
