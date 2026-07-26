// The event streams that make up "was this wallet active today", and how to get a wallet
// out of one of their logs.
//
// ============================================================================
// THIS FILE IS HALF OF A PAIR. THE OTHER HALF MUST NOT DIVERGE FROM IT.
// ============================================================================
// This service WRITES quest_daily; the /api/quest/verify read path REQUIRES these same
// sources to be fresh before it will read that table. If the two lists ever disagree —
// a source indexed here but not required there, or required there but not indexed here —
// a wallet whose only activity that day was on the odd source out gets a confident
// `completed: false`. That is the exact failure this whole step exists to prevent.
//
// The two halves are DUPLICATED AT RUNTIME on purpose: this is a separate Railway service
// and importing across the deployable boundary would defeat the isolation it exists for
// (keeper/ sets the same precedent with its own abi/). What keeps them honest instead:
//
//   1. ADDRESSES COME FROM THE SAME ENV VAR NAMES on both sides, so configuration is
//      shared through the environment rather than through code. A redeploy is one env
//      change and both halves follow it.
//   2. A PARITY TEST imports both descriptor lists and fails if the env-var-name sets
//      differ. (Lands with frontend/api/_lib/quest/dailySources.js — see the plan's
//      sequencing step 4. Until then this list is the only one, so it cannot disagree
//      with anything yet.)
//
// ============================================================================
// WHY RAW getLogs AND NOT contract.filters.X()
// ============================================================================
// Two reasons, and the second is a correctness one:
//
//   * No ABI decode of the data payload across thousands of logs. We need one indexed
//     topic; decoding the rest is work we throw away.
//   * ROBUST TO ABI DRIFT IN NON-INDEXED FIELDS. If PositionOpened's data layout ever
//     changed, parseLog() would throw and log.args would be undefined — losing the wallet
//     even though topics[1] still holds it perfectly well. Reading the topic directly
//     cannot fail that way.
//
// And a trap worth naming: `contract.filters.Deposit(someAddress)` here would index
// EXACTLY ONE WALLET while the watermark advanced normally. The index would report itself
// perfectly fresh while being systematically empty for every other wallet — every user
// gets a confident false. `allWalletsFilter()` below takes no address argument at all, so
// that mistake is not expressible; a test asserts the filter carries exactly one topic.

import { ethers } from "ethers";

/**
 * SOURCE DESCRIPTORS — one per contract, in the order they are indexed.
 *
 * `walletTopic` is the index into `log.topics` holding the wallet. Note BetPlaced: the
 * wallet is topic **2**, because `marketId` is the first indexed parameter. Getting this
 * wrong yields a market id parsed as an address — garbage rows for wallets that do not
 * exist, and no rows for the wallets that do. It has its own test.
 */

import {
  DEFAULT_DEPLOY_BLOCKS,
  SOURCES,
  SOURCE_ADDRESS_VARS,
  SOURCE_DEPLOY_BLOCK_VARS,
} from "./definitions.mjs";

// Re-exported so callers have one import site for "the sources and how to use them"; the
// data itself lives in definitions.mjs precisely so the parity tests can reach it without
// dragging ethers across the deployable boundary.
export { DEFAULT_DEPLOY_BLOCKS, SOURCES, SOURCE_ADDRESS_VARS, SOURCE_DEPLOY_BLOCK_VARS };


/**
 * The floor this source's coverage is measured against.
 *
 * Throws on a set-but-unparseable value rather than falling back to the default: a typo'd
 * deploy block would silently change what "reached the floor" means, and the read path
 * would reject every row the settler wrote against it.
 */
export function sourceFloor(descriptor, env = process.env) {
  const raw = env[descriptor.deployBlockVar];
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(n) && n >= 0) return n;
  if (raw != null && String(raw).trim() !== "") {
    throw new ConfigError(`${descriptor.deployBlockVar} is set but is not a block number: ${JSON.stringify(raw)}`);
  }
  return DEFAULT_DEPLOY_BLOCKS[descriptor.deployBlockVar];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Server misconfiguration, as distinct from an RPC failure. Mirrors api/_lib/quest/chain.js. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve a descriptor's address from the environment.
 *
 * NO DEFAULTS, deliberately — the same rule the read path enforces. A hardcoded address is
 * correct only until the next redeploy, and a superseded contract stays immutable and keeps
 * answering calls: the indexer would happily index a contract nobody uses, report itself
 * fresh, and hand out confident falses. Missing config must fail LOUDLY.
 */
export function sourceAddress(descriptor, env = process.env) {
  const raw = (env[descriptor.addressVar] || "").trim();
  if (!raw) {
    throw new ConfigError(`${descriptor.addressVar} is not set (no default by design — see lib/sources.mjs)`);
  }
  if (!ADDRESS_RE.test(raw)) {
    throw new ConfigError(`${descriptor.addressVar} is not a valid address: ${JSON.stringify(raw)}`);
  }
  return raw.toLowerCase();
}

// Interfaces are built once per event signature — ethers parses the human-readable fragment
// on construction, and there are only two distinct signatures across the four sources.
const interfaceCache = new Map();

function interfaceFor(descriptor) {
  let iface = interfaceCache.get(descriptor.event);
  if (!iface) {
    iface = new ethers.utils.Interface([descriptor.event]);
    interfaceCache.set(descriptor.event, iface);
  }
  return iface;
}

/** keccak of the event signature — `topics[0]` of every log this source emits. */
export function eventTopic(descriptor) {
  return interfaceFor(descriptor).getEventTopic(descriptor.eventName);
}

/**
 * An eth_getLogs filter matching EVERY wallet's events from this source in a block range.
 *
 * Takes no wallet argument, and that is the point — see the trap described in the header.
 * `topics` is exactly `[topic0]`: one element, no positional nulls, nothing that could
 * accidentally constrain an indexed parameter.
 */
export function allWalletsFilter(descriptor, { address, fromBlock, toBlock }) {
  return {
    address,
    topics: [eventTopic(descriptor)],
    fromBlock,
    toBlock,
  };
}

/**
 * The per-wallet form of the SAME descriptor, so the index and the read path's tail scan
 * cannot disagree about which event or which field counts.
 *
 * Positions are filled with `null` up to walletTopic, which is how ethers/JSON-RPC express
 * "any value in this indexed slot" — for BetPlaced this produces `[topic0, null, wallet]`,
 * matching `filters.BetPlaced(null, address)` in the read path exactly.
 */
export function walletFilter(descriptor, { address, wallet, fromBlock, toBlock }) {
  const topics = new Array(descriptor.walletTopic + 1).fill(null);
  topics[0] = eventTopic(descriptor);
  topics[descriptor.walletTopic] = ethers.utils.hexZeroPad(ethers.utils.getAddress(wallet), 32);

  return { address, topics, fromBlock, toBlock };
}

/**
 * Pull the wallet out of one log.
 *
 * THROWS RATHER THAN RETURNING NULL, and callers must not catch-and-continue. A log we
 * cannot resolve to a wallet is a hole: skipping it while still advancing the watermark
 * would leave that block permanently unindexed underneath a watermark claiming to cover it,
 * which reads downstream as a proven absence. Failing the run costs a retry; skipping costs
 * a wrong answer that never heals.
 *
 * The `.toLowerCase()` is load-bearing. ethers returns checksummed addresses, and
 * quest_daily's `wallet = lower(wallet)` CHECK would reject the ENTIRE batch — taking every
 * other wallet's row in the range with it — on a single checksummed value.
 */
export function walletFromLog(descriptor, log) {
  const raw = log?.topics?.[descriptor.walletTopic];

  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      `${descriptor.label}: log at block ${log?.blockNumber} has no usable topic ${descriptor.walletTopic} ` +
        `(got ${JSON.stringify(raw)})`,
    );
  }

  // An address occupies the low 20 bytes; the high 12 must be zero. A non-zero prefix means
  // this topic is not an address at all — the classic symptom of a wrong walletTopic, e.g.
  // reading BetPlaced's marketId as if it were the better. Refuse rather than write garbage.
  if (!/^0x0{24}/.test(raw)) {
    throw new Error(
      `${descriptor.label}: topic ${descriptor.walletTopic} at block ${log?.blockNumber} is not address-shaped ` +
        `(${raw}) — check walletTopic against the event's indexed parameter order`,
    );
  }

  // getAddress validates the 20 bytes (and would throw on a malformed slice); lower-casing
  // then satisfies the table CHECK.
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(raw, 12)).toLowerCase();
}
