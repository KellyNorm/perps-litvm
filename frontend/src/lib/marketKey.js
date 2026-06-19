import { ethers } from "ethers";

// PositionManager.sol encodes a market key as `bytes32("BTC")` — a left-aligned,
// right-zero-padded ASCII string. That is exactly ethers v5's formatBytes32String.
// The smoke (scripts/smoke-perps.mjs) uses the same call.
export function marketKey(symbol) {
  return ethers.utils.formatBytes32String(symbol);
}

// Position key: keccak256(abi.encodePacked(owner, market, isLong)) — mirrors
// PositionManager._positionKey / getPositionKey.
export function positionKey(owner, market, isLong) {
  return ethers.utils.solidityKeccak256(["address", "bytes32", "bool"], [owner, market, isLong]);
}
