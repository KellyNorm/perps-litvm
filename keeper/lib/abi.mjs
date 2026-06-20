// Load contract ABIs from the Foundry build output (out/), as the task requires.
// out/ is gitignored, so the keeper reads the freshly-compiled artifact at runtime
// rather than vendoring a copy that could drift from the deployed contract.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// keeper/lib -> project root.
const ROOT = resolve(HERE, "..", "..");

function loadAbi(artifactPath) {
  const full = resolve(ROOT, artifactPath);
  try {
    return JSON.parse(readFileSync(full, "utf8")).abi;
  } catch (err) {
    throw new Error(
      `could not load ABI from ${full} — run \`forge build\` so out/ exists (${err.message})`,
    );
  }
}

export const PM_ABI = loadAbi("out/PositionManager.sol/PositionManager.json");
export const ERC20_ABI = loadAbi("out/MockERC20.sol/MockERC20.json");
