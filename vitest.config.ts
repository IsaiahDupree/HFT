import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "tests/ui/**"],
    // E2E tests hit live network — opt-in via RUN_E2E=1.
    testTimeout: process.env.RUN_E2E === "1" ? 120_000 : 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      exclude: ["src/app/**", "**/*.d.ts", "tests/**"],
    },
    pool: "forks", // better-sqlite3 + native modules play nicer with forks
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
