// Read-only chain access for quest verification.
//
// STRICTLY READ-ONLY: this module constructs no signer and exposes no write path. The
// endpoint verifies history; it never moves funds and never touches the money path.
//
// PORTED, NOT IMPORTED. The browser equivalents live in `src/lib/contracts.js` and
// `src/config.js`, and both are unusable here: `src/config.js` reads `import.meta.env`
// (a Vite-only construct — a SyntaxError-free but always-undefined read under Node) and
// the retry helper reaches into `src/lib/rpcHealth.js`, a browser singleton that drives
// a UI indicator. api/ therefore keeps its own copy, reading `process.env`.
// KEEP IN STEP: src/lib/contracts.js (provider construction) and src/lib/marketKey.js
// (key derivation) are the upstream of the copies below.

import { ethers } from "ethers";

import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "./abi/multicall3.js";
import { POSITION_MANAGER_ABI } from "./abi/positionManager.js";

/** Server misconfiguration (missing/invalid env), as distinct from an RPC failure. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Addresses have NO defaults, deliberately — the same rule the frontend now enforces for
// the prediction factory (see src/lib/prediction/predictionConfig.js). A hardcoded
// address is correct only until the next redeploy, and a superseded contract stays
// immutable and keeps answering calls: quests would verify green against a contract
// nobody uses. Missing config must fail loudly as `unavailable`, never resolve to false.
function requireAddress(varName) {
  const raw = (process.env[varName] || "").trim();
  if (!raw) {
    throw new ConfigError(`${varName} is not set (no default by design — see api/_lib/quest/chain.js)`);
  }
  if (!ADDRESS_RE.test(raw)) {
    throw new ConfigError(`${varName} is not a valid address: ${JSON.stringify(raw)}`);
  }
  return raw;
}

// The RPC URL DOES get a default, unlike the addresses. It is a public, non-identity
// endpoint: pointing at the wrong one fails immediately and loudly (the provider is
// pinned to a chain id, so a mismatched chain throws on the first call) rather than
// silently answering about the wrong contract. Same default as src/config.js.
export function rpcUrl() {
  return (process.env.QUEST_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http").trim();
}

export function chainId() {
  const n = Number.parseInt(process.env.QUEST_CHAIN_ID || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4441;
}

export const addresses = {
  positionManager: () => requireAddress("QUEST_POSITION_MANAGER_ADDRESS"),
};

// StaticJsonRpcProvider pinned to an explicit network, for the reason documented in
// src/lib/contracts.js: the public RPC intermittently throttles, and a plain
// JsonRpcProvider re-runs eth_chainId detection on reconnect — when that probe fails it
// throws NETWORK_ERROR and wedges every in-flight read. Static never re-detects.
//
// Cached per (url, chainId) rather than in a bare module-level singleton so a test that
// changes env gets a fresh provider instead of one pinned to the previous config.
let _provider = null;
let _providerKey = "";
export function readProvider() {
  const key = `${rpcUrl()}|${chainId()}`;
  if (!_provider || _providerKey !== key) {
    _provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl(), { chainId: chainId(), name: "litvm" });
    _providerKey = key;
  }
  return _provider;
}

/** Test seam: drop the cached provider so the next call rebuilds it from current env. */
export function _resetProvider() {
  _provider = null;
  _providerKey = "";
}

export function positionManagerRead() {
  return new ethers.Contract(addresses.positionManager(), POSITION_MANAGER_ABI, readProvider());
}

export function multicall3() {
  return new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, readProvider());
}

/**
 * Market key: bytes32(symbol), left-aligned and right-zero-padded — how
 * PositionManager.sol encodes MARKET_BTC = bytes32("BTC"). Port of src/lib/marketKey.js.
 */
export function marketKey(symbol) {
  return ethers.utils.formatBytes32String(symbol);
}

/**
 * Position key: keccak256(abi.encodePacked(owner, market, isLong)) — mirrors
 * PositionManager.getPositionKey, which is `pure`, so this is computed locally rather
 * than spending a round trip. Port of src/lib/marketKey.js#positionKey.
 */
export function positionKey(owner, market, isLong) {
  return ethers.utils.solidityKeccak256(["address", "bytes32", "bool"], [owner, market, isLong]);
}

/**
 * Run a batch of reads in ONE round trip via Multicall3. Port of
 * src/lib/prediction/multicall.js#batchRead.
 *
 * allowFailure is always true: one reverting call must degrade to one unknown answer,
 * never take down the whole verification.
 *
 * @param {Array<{contract: ethers.Contract, fn: string, args?: any[]}>} calls
 * @returns {Promise<Array<{ok: boolean, value: any}>>} positionally aligned with `calls`.
 *   A failed entry is {ok:false, value:null} — callers MUST NOT read a false as "no".
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
      return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded };
    } catch {
      // A successful call whose payload will not decode is still a failure to us —
      // typically an ABI drift against a redeployed contract.
      return { ok: false, value: null };
    }
  });
}

export async function headBlock() {
  return readProvider().getBlockNumber();
}
