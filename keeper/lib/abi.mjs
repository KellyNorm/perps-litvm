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
