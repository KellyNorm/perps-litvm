// Retry wrapper for read calls against the single public RPC, which intermittently
// drops/throttles eth_calls under the frontend's polling load. Those failures are
// TRANSPORT noise, not contract reverts — we retry them a few times with exponential
// backoff. A CALL_EXCEPTION that carries a REAL revert reason/data is a deterministic
// contract revert and is re-thrown immediately (retrying would only repeat it).

import { reportHealthy, reportDegraded } from "./rpcHealth.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is `err` a transient transport failure (worth retrying) rather than a real revert?
//   NETWORK_ERROR  — "could not detect network" / dropped connection
//   SERVER_ERROR   — "missing response" / bad gateway from the RPC
//   TIMEOUT        — request timed out
//   err.error.code === 'SERVER_ERROR' — nested transport error
//   message includes 'missing response' / 'could not detect network'
//   CALL_EXCEPTION with NO revert reason AND empty data ('0x') — a dropped eth_call
//     that ethers v5 dresses up as a call exception ("missing revert data"). A
//     CALL_EXCEPTION WITH a reason or non-empty data is a genuine revert — NOT retried.
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
    if (!hasRealReason && dataEmpty) return true; // transport failure, not a revert
  }
  return false;
}

// Run `fn` with up to `attempts` tries, backing off ~baseMs·2^n between transient
// failures (300 / 600 / 1200ms by default). Non-transient errors throw on the first
// try. Reports connection health so the UI can surface a "reconnecting…" indicator
// without wiping rendered data.
export async function withRetry(fn, { attempts = 3, baseMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await fn();
      reportHealthy();
      return out;
    } catch (err) {
      lastErr = err;
      const transient = isTransientRpcError(err);
      if (!transient || i === attempts - 1) {
        if (transient) reportDegraded(); // exhausted retries on a transport failure
        throw err;
      }
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}
