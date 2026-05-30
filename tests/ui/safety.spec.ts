import { test, expect } from "@playwright/test";

test.describe("/safety control plane", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/safety");
  });

  test("renders venue cards for Polymarket and Coinbase with mode pills", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Polymarket" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coinbase" }).first()).toBeVisible();
    // Defaults: DRY_RUN unless ALLOW_TRADE=1 / COINBASE_ALLOW_TRADE=1
    await expect(page.getByText("DRY_RUN").first()).toBeVisible();
  });

  test("shows the live snapshot freshness card with 'Force refresh now' button", async ({ page }) => {
    await expect(page.getByText("Live snapshot freshness")).toBeVisible();
    await expect(page.getByRole("button", { name: /Force refresh now/ })).toBeVisible();
  });

  test("shows the activation gate config panel", async ({ page }) => {
    await expect(page.getByText("Activation gate (pre-flight backtest)")).toBeVisible();
    await expect(page.getByText("ARENA_ACTIVATE_MIN_PNL_PCT")).toBeVisible();
    await expect(page.getByText("ARENA_ACTIVATE_MAX_DD_PCT")).toBeVisible();
  });

  test("Risk engine + kill switch panel shows registered brokers", async ({ page }) => {
    await expect(page.getByText("Risk engine + kill switch")).toBeVisible();
    await expect(page.getByText("Registered brokers")).toBeVisible();
  });
});

test.describe("/arena leaderboard", () => {
  test("renders header + stats grid", async ({ page }) => {
    await page.goto("/arena");
    await expect(page.locator("h1")).toContainText("Arena");
    // 4-card stat row at the top
    await expect(page.getByText("Alive agents")).toBeVisible();
    await expect(page.getByText("Generations sealed")).toBeVisible();
  });
});
