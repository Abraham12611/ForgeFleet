import { defineConfig } from "vite";
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
});
