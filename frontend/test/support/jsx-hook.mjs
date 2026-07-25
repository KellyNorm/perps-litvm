// Lets `node --test` import the app's .jsx sources.
//
// The suites are run by plain `node --test`, not Vite, and Node cannot parse JSX. Rather
// than take on a test framework for one component test, this registers a module hook that
// runs the same transform Vite does — esbuild, already on disk as Vite's own dependency
// (declared explicitly in devDependencies so this does not rely on a transitive hoist).
//
// Two interceptions, both narrow:
//   .jsx — transpiled with the automatic runtime, matching `@vitejs/plugin-react`.
//   .css — stubbed out. Components import their stylesheet as a side effect, which Vite
//          resolves and Node cannot. Nothing under test asserts on styles.
// Everything else falls through to Node untouched, so the DOM-free suites that make up
// the rest of test/ run exactly as they did before.
//
// Wired in via `--import` in the `test` script. It is inert unless a .jsx/.css import is
// actually reached.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", source: "export default {};", shortCircuit: true };
    }
    if (!url.endsWith(".jsx")) return nextLoad(url, context);

    const { code } = transformSync(readFileSync(fileURLToPath(url), "utf8"), {
      loader: "jsx",
      jsx: "automatic",
      format: "esm",
      target: "node22",
    });
    return { format: "module", source: code, shortCircuit: true };
  },
});
