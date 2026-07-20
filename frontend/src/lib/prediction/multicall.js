import { ethers } from "ethers";
import { readProvider } from "../contracts.js";
import { MULTICALL3_ADDRESS } from "./predictionConfig.js";
import { MULTICALL3_ABI } from "./predictionAbi.js";

// Multicall3 fan-out for the prediction board.
//
// WHY: the board needs getMarket + timeframeOf + pools for EVERY market id (34 and
// growing) to find the ~7 live ones — the O(n) cold-start walk noted in the Step 5b
// docs. Issued as individual eth_calls that is 100+ round trips on an RPC we already
// know throttles. Through aggregate3 it is ONE call, so the walk stops mattering.
//
// allowFailure is always true: a single reverting market (a VOID with a dead feed,
// say) must degrade to one blank card, never take down the board.

export function multicall3() {
  return new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, readProvider());
}

/**
 * Run a batch of reads in one round trip.
 *
 * @param {Array<{contract: ethers.Contract, fn: string, args?: any[]}>} calls
 * @returns {Promise<Array<{ok: boolean, value: any}>>} positionally aligned with `calls`.
 *   A failed call is {ok:false, value:null} — callers MUST handle it; never assume ok.
 */
export async function batchRead(calls) {
  if (!calls.length) return [];

  const encoded = calls.map(({ contract, fn, args = [] }) => ({
    target: contract.address,
    allowFailure: true,
    callData: contract.interface.encodeFunctionData(fn, args),
  }));

  const results = await multicall3().callStatic.aggregate3(encoded);

  return results.map((res, i) => {
    if (!res.success) return { ok: false, value: null };
    try {
      const { contract, fn } = calls[i];
      const decoded = contract.interface.decodeFunctionResult(fn, res.returnData);
      // Single-return functions decode to a 1-length array; unwrap for ergonomics.
      return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded };
    } catch {
      // A successful call whose payload we cannot decode is still a failure to us.
      return { ok: false, value: null };
    }
  });
}

/** Chunk a call list so one batch never exceeds the RPC's response limit. */
export async function batchReadChunked(calls, chunkSize = 120) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunkSize) {
    out.push(...(await batchRead(calls.slice(i, i + chunkSize))));
  }
  return out;
}
