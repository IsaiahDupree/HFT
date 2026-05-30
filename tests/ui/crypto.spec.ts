import { test, expect } from "@playwright/test";

test.describe("/crypto — Polymarket-style 5m Up/Down widgets", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/crypto");
  });

  test("page loads with title and big window countdown", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Crypto trading challenge");
    await expect(page.getByText("next 5-min window")).toBeVisible();
  });

  test("renders a per-coin 'Up or Down 5m' widget for each configured product", async ({ page }) => {
    for (const sym of ["BTC", "ETH", "SOL", "XRP", "DOGE"]) {
      const card = page.getByTestId(`crypto-card-${sym}-USD`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(`${sym} Up or Down 5m`);
      await expect(card.getByText("Price To Beat")).toBeVisible();
      await expect(card.getByText("Current Price")).toBeVisible();
      await expect(card.getByText("Our Up estimate")).toBeVisible();
      await expect(card.getByText("last 10 windows")).toBeVisible();
    }
  });

  test("countdown updates every second (Mins:Secs ticks)", async ({ page }) => {
    const secs = page.getByTestId("live-countdown-secs").first();
    await expect(secs).toBeVisible();
    const initial = (await secs.textContent()) ?? "";
    await page.waitForTimeout(2200);
    const after = (await secs.textContent()) ?? "";
    expect(initial).not.toBe(after);
  });

  test("'All coins at a glance' table has 5 rows", async ({ page }) => {
    for (const sym of ["BTC", "ETH", "SOL", "XRP", "DOGE"]) {
      await expect(page.getByTestId(`row-${sym}-USD`)).toBeVisible();
    }
  });

  test("Trade readiness preflight checklist appears", async ({ page }) => {
    await expect(page.getByText("Trade readiness (preflight)")).toBeVisible();
    await expect(page.getByText("data freshness < 2 min")).toBeVisible();
    await expect(page.getByText("kill switch clear")).toBeVisible();
  });

  test("'Position caps (Coinbase capsule)' panel renders with env-var labels", async ({ page }) => {
    await expect(page.getByText("Position caps (Coinbase capsule)")).toBeVisible();
    // Env-var names appear inside <code> elements — use locator for the code block.
    await expect(page.locator("code", { hasText: "COINBASE_MAX_TRADE_USD" }).first()).toBeVisible();
    await expect(page.locator("code", { hasText: "COINBASE_MAX_DAILY_USD" }).first()).toBeVisible();
  });
});
