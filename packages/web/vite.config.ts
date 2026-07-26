/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev the SPA runs on Vite's port and the API on its own, so the three API
// path prefixes are proxied through. This keeps the SAME relative URLs working
// in dev and in production, where the api package serves the built SPA itself
// (docs/api-contract.md §9 — the API owns exactly /tasks*, /events and /health;
// every other GET falls back to index.html).
const API_TARGET = process.env.BACKBURNER_API_URL ?? "http://localhost:3000";
const proxy = { target: API_TARGET, changeOrigin: true, ws: false };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/tasks": proxy,
      "/events": proxy,
      "/health": proxy,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
