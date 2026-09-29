import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Wallet modules reference Node's `global`.
  define: { global: "globalThis" },
  server: { fs: { allow: [".."] } },
});

