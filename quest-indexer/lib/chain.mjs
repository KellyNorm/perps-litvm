// Read-only chain access for the quest indexer.
//
// STRICTLY READ-ONLY. This module constructs no signer and exposes no write path — the
// service reads logs and writes Supabase rows, and it must never acquire the ability to do
// anything else. test/isolation.test.mjs enforces that with a grep over the shipped code,
// so this is a property of the build rather than of anyone's memory.
//
// PORTED, NOT IMPORTED. `withRetry` and the provider construction below are copies of
// frontend/api/_lib/chain/withRetry.js and frontend/api/_lib/quest/chain.js. Importing them
// across the deployable boundary would couple this service's build to the frontend's and
// defeat the isolation it exists for — keeper/ makes the same trade with its own abi/.
//
// KEEP IN STEP: if isTransientRpcError() gains a case upstream, mirror it here. A missed
// case is not a crash; it is a retryable blip escalating into a failed run, which stalls a
// watermark and eventually reads as a stale index. Conservative, but slow.

import { ethers } from "ethers";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Transient transport failure (retry) rather than a real revert (do not)? Line-for-line
 * copy of the frontend's classifier — see its header for the reasoning on each case.
 */
export function isTransientRpcError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT") return true;
  if (err.error && err.error.code === "SERVER_ERROR") return true;

  const msg = String(err.message || err.reason || "");
  if (/missing response|could not detect network/i.test(msg)) return true;

  if (code === "CALL_EXCEPTION") {
    const hasRealReason = err.reason != null && !/missing revert data/i.test(err.reason);
    const data = err.data != null ? err.data : err.error && err.error.data;
    const dataEmpty = data == null || data === "0x";
    if (!hasRealReason && dataEmpty) return true;
  }
  return false;
}

/** Up to `attempts` tries, backing off ~baseMs·2^n between transient failures. */
export async function withRetry(fn, { attempts = 3, baseMs = 300, sleepFn = sleep } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || i === attempts - 1) throw err;
      await sleepFn(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}

export function rpcUrl() {
  return (process.env.QUEST_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http").trim();
}

export function chainId() {
  const n = Number.parseInt(process.env.QUEST_CHAIN_ID || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4441;
}

// StaticJsonRpcProvider pinned to an explicit network: the public RPC intermittently
// throttles, and a plain JsonRpcProvider re-runs eth_chainId detection on reconnect —
// when that probe fails it throws NETWORK_ERROR and wedges every in-flight read. This
// service is long-lived, so it would hit that far more often than a lambda does.
let _provider = null;
export function readProvider() {
  if (!_provider) {
    _provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl(), { chainId: chainId(), name: "litvm" });
  }
  return _provider;
}

export async function headBlock() {
  return withRetry(() => readProvider().getBlockNumber());
}

/** Raw eth_getLogs. The filter comes from lib/sources.mjs — never built ad hoc. */
export async function getLogs(filter) {
  return withRetry(() => readProvider().getLogs(filter));
}

/** Block header, for dating logs. Null (a pruned node) is the caller's problem to fail on. */
export async function getBlock(blockNumber) {
  return withRetry(() => readProvider().getBlock(blockNumber));
}
