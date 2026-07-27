// The sources `daily_active` requires — the READ half of the pair whose write half is
// quest-indexer/lib/sources.mjs.
//
// ============================================================================
// THESE TWO LISTS MUST NOT DIVERGE
// ============================================================================
// The indexer WRITES quest_daily for these sources; this endpoint REQUIRES all of them to
// be fresh before it will read that table. A disagreement is a wrong-answer generator, in
// both directions:
//
//   indexed here but not required there  → the gate never waits on it, so a wallet whose
//                                          only activity today was on that source is told
//                                          `completed: false` while its rows lag.
//   required here but not indexed there  → the gate waits forever on a watermark nobody
//                                          writes, and daily_active is permanently stale.
//                                          Safe, but permanently useless.
//
// They are DUPLICATED AT RUNTIME on purpose — quest-indexer/ is a separate Railway
// deployable and importing across that boundary would defeat the isolation it exists for.
// Two things keep them honest instead:
//
//   1. THE SAME ENV VAR NAMES on both sides, so configuration is shared through the
//      environment rather than through code. A redeploy is one env change and both follow.
//   2. A PARITY TEST (test/quest/sourceParity.test.js) imports both lists and fails if the
//      env-var-name sets differ.
//
// ============================================================================
// WHY THIS FILE ALSO OWNS THE PER-WALLET FILTERS
// ============================================================================
// The tail scan (dailyActiveTier2) asks the same question of the same events as the
// indexer, just for one wallet over a short range. Keeping the filter next to the address
// is what stops the two paths crediting different fields — the indexer's descriptor carries
// `walletTopic`, and each filter here targets the identical indexed parameter:
//
//   PositionOpened  owner    (topic 1)
//   Deposit         sender   (topic 1) — the payer, matching provideLiquidityTier2
//   BetPlaced       better   (topic 2) — marketId is indexed first
//
// A mismatch would make the same wallet read active through one path and inactive through
// the other, depending only on how recently it acted.

import {
  addresses,
  liquidityPoolRead,
  positionManagerRead,
  predictionFactoryOldRead,
  predictionFactoryRead,
} from "./chain.js";

/**
 * Every stream that counts as "activity" for daily_active, and how to ask about one wallet.
 *
 * `contract` and `address` are getters rather than values: chain.js resolves them from env
 * on each call and throws ConfigError when unset, and evaluating that at module load would
 * turn a missing address into an import-time crash instead of a clean 503.
 */
export const DAILY_SOURCES = [
  {
    key: "positionManager",
    label: "PositionManager",
    addressVar: "QUEST_POSITION_MANAGER_ADDRESS",
    address: () => addresses.positionManager(),
    contract: positionManagerRead,
    filter: (c, wallet) => c.filters.PositionOpened(wallet),
  },
  {
    key: "liquidityPool",
    label: "LiquidityPool",
    addressVar: "QUEST_LIQUIDITY_POOL_ADDRESS",
    address: () => addresses.liquidityPool(),
    contract: liquidityPoolRead,
    // `sender` — the account that PAID — not `owner`, which merely received the shares.
    filter: (c, wallet) => c.filters.Deposit(wallet),
  },
  {
    key: "predictionFactory",
    label: "prediction factory (8h, live)",
    addressVar: "QUEST_PREDICTION_FACTORY_ADDRESS",
    address: () => addresses.predictionFactory(),
    contract: predictionFactoryRead,
    // `better` is the SECOND indexed topic; marketId is the first.
    filter: (c, wallet) => c.filters.BetPlaced(null, wallet),
  },
  {
    key: "predictionFactoryOld",
    // Superseded 2026-07-22 and still required: a bet placed there is real activity, and a
    // wallet whose only action today was on the old factory must not read inactive.
    label: "prediction factory (24h, draining)",
    addressVar: "QUEST_PREDICTION_FACTORY_OLD_ADDRESS",
    address: () => addresses.predictionFactoryOld(),
    contract: predictionFactoryOldRead,
    filter: (c, wallet) => c.filters.BetPlaced(null, wallet),
  },
];

/** The env vars the indexer must agree with. Consumed by the parity test. */
export const DAILY_SOURCE_ADDRESS_VARS = DAILY_SOURCES.map((s) => s.addressVar);

/**
 * The indexer_state keys that must ALL be fresh before quest_daily may be read.
 *
 * Lower-cased addresses, matching the table's CHECK and the keys the indexer writes. Throws
 * ConfigError if any address is unset — which surfaces as a 503, not as a short required
 * list. A silently short list is precisely how a dropped source becomes a wrong false.
 */
export function requiredSourceKeys() {
  return DAILY_SOURCES.map((s) => s.address().toLowerCase());
}

/**
 * Sources shaped for scanForEvent, for the tail scan over `[floor, head]`.
 *
 * The floor is the index watermark plus one — not a deploy block — so this deliberately
 * does NOT use deployBlocks. See dailyActiveTier2 for why that also means a custom
 * verifyFloor.
 */
export function tailScanSources(wallet, floor) {
  return DAILY_SOURCES.map((source) => {
    const contract = source.contract();
    return {
      contract,
      filter: source.filter(contract, wallet),
      floor,
      address: contract.address,
      label: `${source.label} (tail)`,
    };
  });
}
