import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit, contract and integration test configuration.
 *
 * `jsdom` is the environment because most of what is tested renders. Pure-logic modules —
 * the SSE parser, the projectors, the section extractor — do not need a DOM but cost
 * nothing to run in one, and keeping a single environment avoids per-file annotations.
 *
 * End-to-end tests run under Playwright and are excluded here.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/app/**/layout.tsx", "src/app/**/loading.tsx", "**/*.d.ts"],
    },
  },
});
