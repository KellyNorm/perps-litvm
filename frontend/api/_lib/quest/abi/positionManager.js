// PositionManager ABI fragments — PORTED, NOT IMPORTED.
//
// PROVENANCE: hand-copied from `frontend/src/abi/PositionManager.json` (the forge
// artifact for `src/PositionManager.sol`), reduced to the two members the quest checks
// need. Signatures verified field-for-field against that artifact on 2026-07-25.
//
// WHY A COPY: everything under api/ runs in the Node serverless runtime and must import
// nothing from src/ — src/abi/index.js is reached through modules that read
// `import.meta.env` (src/config.js) and browser-only singletons (src/lib/rpcHealth.js),
// both of which break outside Vite. The duplication is deliberate and bounded.
//
// IF THE CONTRACT IS REDEPLOYED WITH A CHANGED SIGNATURE, UPDATE BOTH: this file and
// `frontend/src/abi/PositionManager.json`. A drift here is silent — a decode failure
// reads as "no position", which is a false negative on a quest.

// `positions(bytes32)` returns the full struct; only `sizeUsd` (index 4) is read.
// A position that was opened and later closed has sizeUsd == 0, which is exactly why a
// false from this read is NOT a permanent answer — see the Tier 2 event scan.
export const POSITION_MANAGER_ABI = [
  "function positions(bytes32) view returns (address owner,bytes32 market,bool isLong,uint256 collateral,uint256 sizeUsd,uint256 entryPrice,uint256 entryCumBorrowRate,int256 entryCumFunding)",
  "event PositionOpened(address indexed owner,bytes32 indexed market,bool isLong,uint256 collateral,uint256 sizeUsd,uint256 entryPrice)",
];

// getPositionKey(owner, market, isLong) is `pure`, so the key is computed locally
// instead of spending a round trip on it — mirrors PositionManager._positionKey and
// `src/lib/marketKey.js#positionKey`:
//   keccak256(abi.encodePacked(owner, market, isLong))
// That is what turns the Tier 1 check into 4 reads rather than 8.
