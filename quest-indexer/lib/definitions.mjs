// PURE DATA. Zero imports, by design.
//
// The descriptors below are shared with the Vercel read path through PARITY TESTS that
// import this module directly. Those tests run inside the frontend's test job, which
// installs only the frontend's dependencies — so anything reachable from here must not pull
// in `ethers` or anything else from this service's node_modules, or the frontend suite
// stops being runnable on its own.
//
// That is not merely a CI detail: "the frontend tests need the indexer's dependencies
// installed" is exactly the kind of coupling two separate deployables should not have. The
// ethers-dependent helpers live next door in sources.mjs and re-export from here.

export const SOURCES = [
  {
    key: "positionManager",
    label: "PositionManager",
    addressVar: "QUEST_POSITION_MANAGER_ADDRESS",
    deployBlockVar: "QUEST_POSITION_MANAGER_DEPLOY_BLOCK",
    // `owner` is the trader. Indexed first.
    event: "event PositionOpened(address indexed owner,bytes32 indexed market,bool isLong,uint256 collateral,uint256 sizeUsd,uint256 entryPrice)",
    eventName: "PositionOpened",
    walletTopic: 1,
  },
  {
    key: "liquidityPool",
    label: "LiquidityPool",
    addressVar: "QUEST_LIQUIDITY_POOL_ADDRESS",
    deployBlockVar: "QUEST_LIQUIDITY_POOL_DEPLOY_BLOCK",
    // ERC-4626 Deposit. `sender` PAID the assets; `owner` merely received the shares.
    // We credit the payer, matching provideLiquidityTier2 in the read path — depositing on
    // someone else's behalf is the honest reading of "provide liquidity". Both are indexed,
    // so switching is a one-line change to walletTopic if that call ever goes the other way.
    event: "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
    eventName: "Deposit",
    walletTopic: 1,
  },
  {
    key: "predictionFactory",
    label: "prediction factory (8h, live)",
    addressVar: "QUEST_PREDICTION_FACTORY_ADDRESS",
    deployBlockVar: "QUEST_PREDICTION_FACTORY_DEPLOY_BLOCK",
    event: "event BetPlaced(uint256 indexed marketId,address indexed better,uint8 side,uint256 amount)",
    eventName: "BetPlaced",
    // TOPIC 2, not 1 — marketId is indexed first. See the note above.
    walletTopic: 2,
  },
  {
    key: "predictionFactoryOld",
    label: "prediction factory (24h, draining)",
    addressVar: "QUEST_PREDICTION_FACTORY_OLD_ADDRESS",
    deployBlockVar: "QUEST_PREDICTION_FACTORY_OLD_DEPLOY_BLOCK",
    // Superseded on 2026-07-22 but still indexed: a bet placed there is real activity, and
    // the contract is immutable. A wallet whose only action today was on the old factory
    // must not be reported inactive.
    event: "event BetPlaced(uint256 indexed marketId,address indexed better,uint8 side,uint256 amount)",
    eventName: "BetPlaced",
    walletTopic: 2,
  },
];

/** The env vars the read path must agree with. Consumed by the parity test. */
export const SOURCE_ADDRESS_VARS = SOURCES.map((s) => s.addressVar);

/**
 * SCAN FLOORS — the block each contract was deployed in, used ONLY by the backward settler.
 * The forward indexer never needs them (it starts at head and moves up).
 *
 * These MUST equal the read path's DEFAULT_DEPLOY_BLOCKS in api/_lib/quest/chain.js. A
 * settler walking to a different floor than the read path expects would write a
 * `scanned_to` the read path either rejects (floor mismatch — wasted work) or, worse,
 * accepts as "reached the floor" when it has not. A parity test pins both the names and
 * these values.
 */
export const DEFAULT_DEPLOY_BLOCKS = {
  QUEST_POSITION_MANAGER_DEPLOY_BLOCK: 23_302_630,
  QUEST_LIQUIDITY_POOL_DEPLOY_BLOCK: 23_302_630,
  QUEST_PREDICTION_FACTORY_DEPLOY_BLOCK: 32_222_320,
  QUEST_PREDICTION_FACTORY_OLD_DEPLOY_BLOCK: 30_665_562,
};

export const SOURCE_DEPLOY_BLOCK_VARS = SOURCES.map((s) => s.deployBlockVar);

/**
 * Which sources each settleable quest walks. MIRRORS the Tier 2 definitions in
 * api/_lib/quest/checks.js — see the note in settler.mjs about which half of that agreement
 * a test can and cannot check.
 */
export const SETTLEABLE_QUESTS = {
  first_trade: ["positionManager"],
  first_prediction: ["predictionFactory", "predictionFactoryOld"],
  provide_liquidity: ["liquidityPool"],
};

/**
 * The SAME relation read the other way: which quests does one source prove?
 *
 * The forward indexer and the backfill both work source-by-source — they hold a batch of
 * logs from one contract and need to know which completions those logs justify. Deriving
 * this from SETTLEABLE_QUESTS rather than writing it out is the whole point: two hand-kept
 * tables of the same relation can disagree, and the direction they would disagree in is a
 * quest whose source stops producing completions while the backfill still reports that
 * source covered — a proven false for wallets that did the thing.
 *
 * Note first_prediction appears under BOTH factories. That is correct and is not a
 * duplicate: a bet on either contract completes the quest on its own, so either source
 * seeing a wallet is sufficient proof. It is only the NEGATIVE that needs both covered,
 * and that requirement lives in the read path's derivation, not here.
 */
export const QUESTS_BY_SOURCE = Object.entries(SETTLEABLE_QUESTS).reduce((acc, [quest, sourceKeys]) => {
  for (const key of sourceKeys) (acc[key] ??= []).push(quest);
  return acc;
}, {});
