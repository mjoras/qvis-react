import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { loadfilesProxy } from "./server/vite-plugin.ts";

export default defineConfig({
  // relative base so the build also works when served from a sub-path (like the original qvis)
  base: "./",
  // loadfilesProxy: the CORS proxy (api/loadfiles.ts) also runs in `npm run dev` and `npm run preview`
  plugins: [react(), loadfilesProxy()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
