import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Wallet modules reference Node's `global`.
  define: { global: "globalThis" },
  server: {
    fs: { allow: [".."] },
    // Same as production: /api is served by the Railway indexer.
    proxy: { "/api": { target: "https://indexer-production-15e6.up.railway.app", changeOrigin: true } },
  },
});

