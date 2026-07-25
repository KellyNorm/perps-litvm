// Multicall3 ABI fragment — PORTED, NOT IMPORTED.
//
// PROVENANCE: the aggregate3 member of the canonical Multicall3 ABI, matching
// `frontend/src/lib/prediction/predictionAbi.js#MULTICALL3_ABI`. Keep the two in step.
//
// Multicall3 sits at the same address on every chain it is deployed to; on chain 4441 it
// is VERIFIED deployed (codesize 3808, checked 2026-07-20 — see predictionConfig.js).
// It is a stateless, well-known utility with no per-deploy identity, which is why this
// one address is a constant rather than an env var like the protocol contracts.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
];
