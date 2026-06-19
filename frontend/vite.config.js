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
  },
});
