import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Standalone build: the UI never bundles the Paperclip server.
// The browser reaches the Vultr API via VITE_PUBLIC_API_URL (public HTTPS
// origin only) or same-origin /api through the Vercel rewrite in vercel.json.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PAPERCLIP_DEV_API ?? "http://localhost:3100",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Node:test stdlib suites (E13 *.test.ts, E14 *.test.mjs) run via
      // `node --test` with zero deps. Vitest owns the SSR route suites
      // (*.test.tsx) only.
      "src/features/**/*.test.ts",
      "src/features/**/*.test.mjs",
      "src/features/**/*.test.js",
    ],
  },
});
