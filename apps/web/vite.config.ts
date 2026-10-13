import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The portal is served same-origin by apps/server from apps/web/dist. No inline script or style
// is emitted, which is what the portal Content-Security-Policy (ADR-018) relies on.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2024",
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { "/v1": "http://127.0.0.1:7331" },
  },
});
