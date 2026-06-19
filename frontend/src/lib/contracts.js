import { ethers } from "ethers";
import { RPC_URL, ADDRESSES } from "../config.js";
import { PositionManager, LiquidityPool, MockERC20 } from "../abi/index.js";

// A single read-only provider on the LiteForge RPC so the dashboard loads with NO
// wallet. All reads (markets, prices-on-chain state, vault, positions, balances)
// go through this; only the faucet write needs an injected signer.
let _readProvider = null;
export function readProvider() {
  if (!_readProvider) {
    _readProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
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
