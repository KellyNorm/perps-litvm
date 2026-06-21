import { ethers } from "ethers";
import { RPC_URL, CHAIN_ID, ADDRESSES } from "../config.js";
import { PositionManager, LiquidityPool, MockERC20 } from "../abi/index.js";

// A single read-only provider on the LiteForge RPC so the dashboard loads with NO
// wallet. All reads (markets, prices-on-chain state, vault, positions, balances)
// go through this; only the faucet write needs an injected signer.
//
// StaticJsonRpcProvider (not JsonRpcProvider) pinned to an EXPLICIT network: the public
// RPC intermittently throttles/drops requests, and a plain JsonRpcProvider re-runs
// eth_chainId network detection on reconnect — when that probe fails it throws
// "could not detect network" (NETWORK_ERROR) and wedges every in-flight read. Static +
// a hard-coded {chainId,name} never re-detects, so a transient drop is just one failed
// call (retried by withRetry) instead of a provider-wide stall.
let _readProvider = null;
export function readProvider() {
  if (!_readProvider) {
    _readProvider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "litvm" });
  }
  return _readProvider;
}

export function pmRead() {
  return new ethers.Contract(ADDRESSES.positionManager, PositionManager, readProvider());
}
export function poolRead() {
  return new ethers.Contract(ADDRESSES.pool, LiquidityPool, readProvider());
}
export function musdRead() {
  return new ethers.Contract(ADDRESSES.musd, MockERC20, readProvider());
}

// Signer-bound mUSD for the only write in 11a: faucet().
export function musdWrite(signer) {
  return new ethers.Contract(ADDRESSES.musd, MockERC20, signer);
}

// Signer-bound contracts for the 11b trade loop (request* + executeRequest +
// cancelRequest + the mUSD approve). The connected wallet signs both legs.
export function pmWrite(signer) {
  return new ethers.Contract(ADDRESSES.positionManager, PositionManager, signer);
}
