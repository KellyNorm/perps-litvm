import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The RedStone SDK references `global` / `process` (it targets Node); shim them so the
// price-fetch path runs in the browser. No Node polyfills are pulled into the bundle —
// reads only need `requestDataPackages`, which is plain `fetch` under the hood.
export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
    "process.env": {},
  },
  server: {
    host: true,
    port: 5173,
    // Same-origin proxy for public exchange data. The browser hits /api/px/<exchange>/...
    // (relative), and Vite forwards it server-side to the real host. This keeps the
    // exchange fetch off the user's network, which may DNS-block these APIs at the ISP
    // level. Prod uses an equivalent Vercel function (frontend/api/px/[...path].js).
    proxy: {
      "/api/px/kraken": {
        target: "https://api.kraken.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/px\/kraken/, ""),
      },
      "/api/px/bybit": {
        target: "https://api.bybit.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/px\/bybit/, ""),
      },
      "/api/px/coinbase": {
        target: "https://api.exchange.coinbase.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/px\/coinbase/, ""),
      },
    },
  },
});
