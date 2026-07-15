// Load contract ABIs from committed copies vendored under keeper/abi/.
//
// These are the ABI arrays extracted from the Foundry artifacts (out/) at the
// time of the live deploy, so they ship WITH the keeper. Railway only runs
// `npm install` + `node` — it never runs `forge build` and has no out/ dir — so
// the keeper must not depend on out/ existing at runtime. The path is resolved
// relative to THIS file (keeper/lib), never cwd, so it works both locally and in
// a Railway root deploy. Refresh these files (see keeper/abi/README) whenever the
// PositionManager ABI changes and is redeployed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// keeper/lib -> keeper/abi
const ABI_DIR = resolve(HERE, "..", "abi");

function loadAbi(file) {
  const full = resolve(ABI_DIR, file);
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    throw new Error(`could not load ABI from ${full} (${err.message})`);
  }
}

export const PM_ABI = loadAbi("PositionManager.json");
export const ERC20_ABI = loadAbi("MockERC20.json");

// Multicall3 — canonical CREATE2 deployment, same address on every chain including
// LitVM 4441 (verified on-chain: 7,618 bytes at this address). Used ONLY for
// gas-free, read-only batch view reads (aggregate3 staticcall), never for anything
// state-changing — so it can never touch the money path. Minimal fragment: only
// aggregate3, which returns per-call (success, returnData) with allowFailure=true.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate3",
    outputs: [
      {
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
        name: "returnData",
        type: "tuple[]",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
];
