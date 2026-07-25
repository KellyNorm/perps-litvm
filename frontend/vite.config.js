import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Config is a function purely so `loadEnv` can run: Vite deliberately does NOT copy
// .env into `process.env`, so reading `process.env.TACHY_API_ORIGIN` alone would work
// from a shell prefix and silently do nothing when the same line is set in .env. Both
// have to work, because .env.example documents both.
export default defineConfig(({ mode }) => {
  // Empty prefix, so this sees unprefixed vars. NOTE: that includes the provider API
  // keys sitting in the same .env. Nothing from `env` may be passed to `define` or
  // otherwise reach the bundle — only TACHY_API_ORIGIN is read below, and it is a
  // dev-server setting that never leaves this process.
  const env = loadEnv(mode, process.cwd(), "");

  // A shell prefix beats the file, so `TACHY_API_ORIGIN=… npm run dev` is a one-off
  // override rather than something you have to remember to undo in .env afterwards.
  const tachyApiOrigin = process.env.TACHY_API_ORIGIN || env.TACHY_API_ORIGIN || "http://localhost:3000";

  return {
    plugins: [react()],
    // The RedStone SDK references `global` / `process` (it targets Node); shim them so
    // the price-fetch path runs in the browser. No Node polyfills are pulled into the
    // bundle — reads only need `requestDataPackages`, which is plain `fetch` under the
    // hood. `process.env` is stubbed EMPTY on purpose: that is what guarantees no
    // server-side key can be inlined into client code.
    define: {
      global: "globalThis",
      "process.env": {},
    },
    server: {
      host: true,
      port: 5173,
      // `vite dev` serves the SPA and nothing else — it has no notion of `api/`, so a
      // POST to /api/tachy would fall through to the index.html rewrite and hand the
      // client a 200 full of HTML. That is why this proxy is not optional in dev.
      //
      // Default target is the local endpoint host: `npm run dev:tachy` in a second
      // terminal, which runs the SAME handler with the keys from .env. Local .env has no
      // TACHY_PROVIDER, so that defaults to Gemini (5 req/min GLOBAL) — run it as
      // `TACHY_PROVIDER=groq npm run dev:tachy` to match what production serves.
      //
      // To point local dev at the deployed endpoint instead:
      //   TACHY_API_ORIGIN=https://app.tachyonfi.xyz npm run dev
      // That spends the real free-tier quota (~65/day), so it is opt-in rather than the
      // default. `changeOrigin` rewrites the Host header, which the platform needs in
      // order to route to the right project.
      proxy: {
        "/api": {
          target: tachyApiOrigin,
          changeOrigin: true,
        },
      },
    },
  };
});
