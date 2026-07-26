// Startup preflight: refuse to run against an address that is not a deployed contract.
//
// ============================================================================
// THE GAP THIS CLOSES
// ============================================================================
// sourceAddress() already rejects a missing or malformed address — a truncated paste
// crash-loops immediately with a clear reason. What it cannot catch is a WELL-FORMED BUT
// WRONG address: 42 valid hex characters pointing at nothing, or at some other contract.
//
// That failure is silent and it is the worst one this service can have:
//
//   getLogs returns nothing, forever      (there is no contract emitting those events)
//   the watermark advances normally       (an empty range is a legitimately indexed range)
//   the freshness gate reports FRESH      (the watermark really is tracking head)
//   daily_active answers `completed:false`  for every wallet, with total confidence
//
// Every other guard in the system is downstream of the assumption that we are reading the
// right contract. Nothing later can detect a violation of it, because a wrong address and
// a genuinely inactive chain look identical from the data.
//
// One eth_getCode per source at boot settles it. This is the indexer's counterpart to
// scan.js's verifyFloor on the read path — same principle, applied to the same class of
// mistake, at the only moment it can still be caught cheaply.
//
// ============================================================================
// WHY IT REFUSES TO START RATHER THAN WARNING
// ============================================================================
// A dead indexer is SAFE: the watermark stops advancing, the freshness gate trips, and
// daily_active answers indeterminate. A running indexer pointed at the wrong contract is
// not safe — it manufactures confident falses. Given the choice, the service should be
// visibly dead.
//
// The same reasoning applies to an unverifiable check (RPC down): we cannot tell a wrong
// address from an unreachable node, and a service that cannot reach its RPC has nothing to
// do anyway, so refusing loses nothing. It is retried generously first — this is a one-time
// boot cost, so a few seconds of backoff is cheap insurance against a momentary blip
// burning a restart.
//
// OPERATIONAL NOTE: railway.json sets restartPolicyMaxRetries: 10. A sustained RPC outage
// at boot can therefore exhaust the restarts and leave the service stopped until it is
// redeployed. That is the intended trade — stopped reads as stale reads as indeterminate,
// which is honest — but it is worth knowing about when diagnosing a service that will not
// come up.

import { sourceAddress } from "./sources.mjs";

/**
 * Confirm every configured source address holds contract code.
 *
 * @param {object} args
 * @param {Array} args.sources                descriptors from lib/sources.mjs
 * @param {(address: string) => Promise<string>} args.getCode
 * @param {object} [args.env]
 * @param {(msg: string) => void} [args.log]
 * @returns {Promise<Array<{source, address, bytes}>>} resolved sources, for logging.
 * @throws if any address has no code, or if any check could not be completed.
 */
export async function verifySourceContracts({ sources, getCode, env = process.env, log = () => {} }) {
  // Resolution first, and it throws on a missing or malformed address before a single RPC
  // call is made — no point probing the chain for something we already know is unusable.
  const resolved = sources.map((source) => ({ source, address: sourceAddress(source, env) }));

  const problems = [];
  const verified = [];

  for (const { source, address } of resolved) {
    let code;
    try {
      code = await getCode(address);
    } catch (err) {
      // Cannot distinguish "wrong address" from "unreachable node", so treat both as
      // disqualifying. See the header for why refusing costs nothing here.
      problems.push(`${source.addressVar} (${address}): could not verify — ${err?.message ?? err}`);
      continue;
    }

    if (code == null || code === "0x") {
      problems.push(
        `${source.addressVar} (${address}): NO CONTRACT CODE at this address on this chain. ` +
          `Indexing it would return no logs forever while the watermark advanced normally, ` +
          `making daily_active answer a confident false for every wallet.`,
      );
      continue;
    }

    const bytes = (code.length - 2) / 2;
    verified.push({ source, address, bytes });
    log(`[indexer] ${source.label} ${address} — ${bytes} bytes of code`);
  }

  // ALL problems at once, not just the first. An operator who has just pasted four env vars
  // wants to know about all four mistakes in one restart, not to discover them serially.
  if (problems.length > 0) {
    throw new Error(
      `contract preflight failed for ${problems.length} of ${resolved.length} sources — refusing to start:\n  ` +
        problems.join("\n  "),
    );
  }

  return verified;
}
