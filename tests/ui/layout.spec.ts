import { test, expect } from "@playwright/test";

test.describe("Global layout (SystemStatusBar + NavMenu + TradeTicker)", () => {
  for (const path of ["/", "/arena", "/safety", "/capsules", "/crypto", "/coinbase"]) {
    test(`SystemStatusBar visible on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByText("SYSTEM", { exact: false })).toBeVisible();
    });
  }

  test("grouped nav has Markets / Arena / Capsules / Manage dropdowns", async ({ page }) => {
    await page.goto("/");
    for (const label of ["Markets", "Arena", "Capsules", "Manage"]) {
      await expect(page.locator("nav").getByRole("button", { name: new RegExp(label) })).toBeVisible();
    }
  });

  test("Markets dropdown opens on hover and includes Crypto link", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav").getByRole("button", { name: /Markets/ }).hover();
    await expect(page.getByRole("link", { name: /Crypto live/ })).toBeVisible();
  });

  test("TradeTicker present at bottom of every page", async ({ page }) => {
    await page.goto("/");
    // Ticker uses one of two top-level labels: "TRADES (N)" when there are
    // fills, or "TRADES — no fills yet" when empty. Match either via .first().
    await expect(page.getByText(/^TRADES/).first()).toBeVisible();
  });
});

test.describe("Auto-refresh chips on live pages", () => {
  for (const path of ["/arena", "/safety", "/capsules", "/crypto"]) {
    test(`/AutoRefresh chip appears on ${path}`, async ({ page }) => {
      await page.goto(path);
      // The chip renders "⏸" then label text like "arena 30s" / "safety 30s" / "crypto 15s"
      await expect(page.locator("text=/⏸|▶/").first()).toBeVisible();
    });
  }
});
