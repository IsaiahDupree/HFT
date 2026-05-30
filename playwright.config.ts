import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for UI smoke tests. Assumes the Next.js dev server is
 * already running on http://localhost:3001 (the project's standard port).
 * Run via `npm run test:ui`.
 *
 * If port 3001 is free, Playwright will auto-start `npm run dev` itself —
 * but that takes ~30s + steals the dev server, so prefer "leave dev running,
 * run tests on the side".
 */
export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false, // shared dev server, avoid race conditions on snapshots
  workers: 1,
  // Next 15 dev server (turbo + webpack alike) intermittently 500s under
  // rapid request volume on Windows due to chunk-cache races. Retry up to 2x
  // so a flaky transient failure doesn't fail the whole suite.
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: process.env.UI_BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Auto-start a dedicated dev server on :3001 when one isn't already running.
  // reuseExistingServer means an operator with `npm run dev:test` already up
  // gets fast iteration; CI or a cold shell gets an auto-start.
  webServer: {
    command: "npm run dev:test",
    url: "http://localhost:3001",
    timeout: 120_000,
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "pipe",
  },
});
