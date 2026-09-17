import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end and accessibility test configuration.
 *
 * These run against a real browser, a real Node gateway and a real Python backend. The
 * backend is started separately — see `tests/e2e/README.md` — because standing it up is a
 * Python concern and hiding it inside a TypeScript config would make a failure there look
 * like a frontend failure.
 *
 * `BASE_URL` points at the frontend. When it is unset the config starts one, so a developer
 * with a backend already running needs no further setup.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3210";
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  testDir: "./tests/e2e",
  // Failures here are usually real; retrying once in CI absorbs genuine flake from browser
  // startup without masking a reproducible fault.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // A turn against the scripted backend is instantaneous; against a live model with
  // tools it routinely takes over a minute, and a drawing question that magnifies a
  // region takes longer. The bound has to clear the slower of the two, because the
  // suite is run against both.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "desktop-wide",
      // Wide enough for the evidence rail to have its own column.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 980 } },
    },
    {
      name: "desktop-narrow",
      // Between the breakpoints: sidebar present, evidence inline under the answer.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node scripts/release.mjs start -p 3210",
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { BACKEND_BASE_URL },
      },
});
