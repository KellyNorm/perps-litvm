// The isolation boundary, enforced rather than documented.
//
// This service exists as a SEPARATE Railway deployment specifically so that it can crash,
// hang or OOM without touching the perp keeper or the prediction keeper, which run the live
// money path. A comment saying "keep this independent" survives exactly until someone needs
// one helper from keeper/lib. These tests are what make the boundary real.
//
// Three properties:
//
//   1. NO SIGNER, NO KEY. This service reads chain state and writes Supabase. It cannot move
//      a wei and must never be given the ability to. Same grep the frontend runs over api/.
//   2. NO CROSS-DEPLOYABLE IMPORTS. Importing from ../keeper or ../frontend would couple the
//      deployables at build time and defeat the point of a separate service.
//   3. NO SHARED PROCESS STATE. Follows from 2, but the import check is what enforces it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { describe } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    // node_modules is a dependency tree, not our code; it is also a symlink in dev.
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(mjs|js|json)$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(root);
const rel = (f) => path.relative(root, f);

// Code that actually runs on Railway. The forbidden-token grep below is scoped to this
// rather than to every file, because THIS file necessarily contains the tokens it bans —
// and a test fixture, which never executes in production, is not a capability.
const shipped = files.filter((f) => !rel(f).startsWith("test" + path.sep));

/** Source with comments stripped — comments legitimately discuss these terms. */
function code(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("read-only: this service holds no key and touches no money path", () => {
  // A signer here would make the quest indexer capable of moving funds. It has no reason to
  // and must never acquire one — this is the same gate frontend/test/quest/env.test.js runs
  // over api/, applied to the second place that talks to this chain.
  test("constructs no signer and no write path", () => {
    assert.ok(shipped.length > 0, "the grep must actually be scanning something");
    for (const file of shipped) {
      const src = code(file);
      for (const forbidden of [
        "new ethers.Wallet",
        "ethers.Wallet",
        "getSigner",
        "sendTransaction",
        "PRIVATE_KEY",
        "signTransaction",
        "_signTypedData",
      ]) {
        assert.ok(!src.includes(forbidden), `${rel(file)} contains ${forbidden} — this service is read-only`);
      }
    }
  });

  test("reads no private-key-shaped env var", () => {
    for (const file of files) {
      const vars = [...code(file).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      for (const name of vars) {
        assert.ok(
          !/(PRIVATE|MNEMONIC|SEED|SIGNER)/.test(name),
          `${rel(file)} reads ${name} — this service must never hold a key`,
        );
      }
    }
  });

  // The whole env surface, asserted explicitly, so adding a variable is a deliberate act
  // that shows up in a diff rather than something that accumulates.
  test("reads only the env vars it is supposed to", () => {
    const allowed = new Set([
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "QUEST_RPC_URL",
      "QUEST_CHAIN_ID",
      "QUEST_POSITION_MANAGER_ADDRESS",
      "QUEST_LIQUIDITY_POOL_ADDRESS",
      "QUEST_PREDICTION_FACTORY_ADDRESS",
      "QUEST_PREDICTION_FACTORY_OLD_ADDRESS",
    ]);

    for (const file of files) {
      for (const [, name] of code(file).matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        assert.ok(allowed.has(name), `${rel(file)} reads unexpected env var ${name}`);
      }
    }
  });
});

describe("no coupling to the live keepers", () => {
  // A shared import is a shared build and, in the worst case, shared module state. The
  // isolation this service exists for has to hold at the import graph, not just at runtime.
  test("imports nothing from keeper/ or frontend/", () => {
    for (const file of files) {
      const specs = [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of specs) {
        assert.ok(
          !/(^|\/)\.\.\/(keeper|frontend)\//.test(spec) && !spec.includes("/keeper/") && !spec.includes("/frontend/"),
          `${rel(file)} imports ${spec} across the deployable boundary`,
        );
      }
    }
  });

  test("every relative import stays inside this service", () => {
    for (const file of files) {
      const specs = [...readFileSync(file, "utf8").matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
      for (const spec of specs) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(root + path.sep), `${rel(file)} escapes the service root via ${spec}`);
      }
    }
  });

  test("declares its own dependencies rather than borrowing them", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.ok(pkg.dependencies?.ethers, "ethers must be a declared dependency, not inherited");
  });

  // ON_FAILURE with bounded retries: a crash restarts THIS service and nothing else.
  test("has its own Railway deploy config with a restart policy", () => {
    const railway = JSON.parse(readFileSync(path.join(root, "railway.json"), "utf8"));
    assert.equal(railway.deploy.restartPolicyType, "ON_FAILURE");
    assert.equal(railway.deploy.startCommand, "node index.mjs");
  });
});
