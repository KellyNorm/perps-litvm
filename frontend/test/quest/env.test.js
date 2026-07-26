// Guards the client/server boundary in configuration.
//
// Vite inlines every VITE_-prefixed variable into the browser bundle. That makes the
// PREFIX the security boundary for server-only secrets — not the file a value lives in,
// not a comment, not intent. A Supabase SERVICE-ROLE key bypasses row-level security
// entirely, so a single VITE_ prefix on it would ship full table access to every visitor.
//
// This suite reads the committed .env.example (the file people copy) and the shipped
// server code, and fails if that prefix ever appears where it must not.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { describe } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "../..");

const envExample = readFileSync(path.join(frontendRoot, ".env.example"), "utf8");

/** Variable names assigned or commented as `NAME=` in .env.example. */
function declaredVars(text) {
  return [...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Every file, whatever the extension — src/ is .js and .jsx, and a leaked secret does
 *  not care which. Deliberately not filtered by extension: the point is coverage. */
function walkAll(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkAll(full));
    else out.push(full);
  }
  return out;
}

describe("secrets never carry a VITE_ prefix", () => {
  test("no SUPABASE_* variable is VITE_-prefixed in .env.example", () => {
    const offenders = declaredVars(envExample).filter((name) => /^VITE_.*SUPABASE/.test(name));
    assert.deepEqual(offenders, [], "a VITE_ prefix would inline this into the browser bundle");
  });

  test("no VITE_ variable name mentions a key, secret, token, or password", () => {
    const offenders = declaredVars(envExample).filter((name) =>
      /^VITE_.*(KEY|SECRET|TOKEN|PASSWORD|SERVICE_ROLE)/.test(name),
    );
    assert.deepEqual(offenders, []);
  });

  test("the Supabase vars are declared, so the boundary is documented before it is used", () => {
    const declared = declaredVars(envExample);
    assert.ok(declared.includes("SUPABASE_SERVICE_ROLE_KEY"));
    assert.ok(declared.includes("SUPABASE_URL"));
  });

  // The prefix rule above only governs what .env.example DECLARES. This governs where the
  // name is READ: src/ is the Vite tree, and Vite resolves process.env/import.meta.env
  // references there at build time. A SUPABASE_ mention that drifts into src/ is a
  // full-table credential published to every visitor — a file in the wrong directory
  // rather than a wrong function, which is why this is a grep over the tree.
  test("src/ never references SUPABASE_ anything", () => {
    const clientFiles = walkAll(path.join(frontendRoot, "src"));
    const offenders = clientFiles
      .filter((f) => readFileSync(f, "utf8").includes("SUPABASE_"))
      .map((f) => path.relative(frontendRoot, f));

    assert.deepEqual(offenders, [], "the service-role key bypasses RLS and must stay server-side");
  });
});

describe("server code does not read client config", () => {
  const serverFiles = walk(path.join(frontendRoot, "api"));

  test("api/ never reads import.meta.env", () => {
    for (const file of serverFiles) {
      const src = readFileSync(file, "utf8");
      // Comments legitimately discuss it; only real reads matter.
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(
        !/import\.meta\.env/.test(code),
        `${path.relative(frontendRoot, file)} reads import.meta.env — undefined outside Vite`,
      );
    }
  });

  // The porting rule: api/ runs in the Node runtime, src/ assumes Vite and the browser.
  // An import across that line fails at runtime, not at build time.
  test("api/ imports nothing from src/", () => {
    for (const file of serverFiles) {
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) {
        assert.ok(
          !spec.includes("/src/") && !/^\.\.\/\.\.\/src\//.test(spec),
          `${path.relative(frontendRoot, file)} imports ${spec} from src/`,
        );
      }
    }
  });

  test("quest server code constructs no signer and no write path", () => {
    for (const file of serverFiles.filter((f) => f.includes("quest"))) {
      const src = readFileSync(file, "utf8");
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const forbidden of ["new ethers.Wallet", "getSigner", "sendTransaction", "PRIVATE_KEY"]) {
        assert.ok(
          !code.includes(forbidden),
          `${path.relative(frontendRoot, file)} contains ${forbidden} — this endpoint is read-only`,
        );
      }
    }
  });
});
