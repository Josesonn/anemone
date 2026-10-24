import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { AtRule } from "postcss";

// The monitor always animates (see src/force-motion.ts), so Arc's "reduce motion" CSS rules are dropped.
const alwaysAnimate = {
  postcssPlugin: "agentbox-always-animate",
  AtRule: { media(rule: AtRule) { if (/prefers-reduced-motion:\s*reduce/.test(rule.params)) rule.remove(); } },
};

// The built app goes straight into the Python package, next to the hand-written ocean
// engine and themes (agentbox/ui/static/ocean, /themes), which the build leaves alone.
const STATIC = path.resolve(__dirname, "../agentbox/ui/static");

export default defineConfig({
  plugins: [react()],
  base: "/static/",
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  publicDir: false,
  css: { postcss: { plugins: [alwaysAnimate] } },
  build: {
    outDir: STATIC,
    emptyOutDir: false,
    assetsDir: "app",
    chunkSizeWarningLimit: 900,
  },
  server: {
    // `npm run dev` + `agentbox ui --demo --no-browser` gives hot reload against live data.
    proxy: {
      "/api": "http://127.0.0.1:7400",
      "/static/ocean": "http://127.0.0.1:7400",
      "/static/themes": "http://127.0.0.1:7400",
    },
  },
});
