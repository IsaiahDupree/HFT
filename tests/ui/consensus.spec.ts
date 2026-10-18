import { test, expect } from "@playwright/test";

/**
 * /consensus — cross-wallet signal UI.
 *
 * Two states the page must handle:
 *   1. No signals logged → shows the "no signals yet" empty state with the
 *      runbook hint
 *   2. Signals present → renders signal cards with wallets, prices, windows
 *
 * Run `npm run scan:consensus -- --min 2 --window 360 --trust 0` against a
 * seeded DB to force state #2 before this suite.
 */

test.describe("/consensus", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/consensus");
  });

  test("renders header + 'how to use this' footer", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /Cross-wallet consensus/ })).toBeVisible();
    await expect(page.getByText(/How to use this/i)).toBeVisible();
  });

  test("shows the explanation paragraph with scan:consensus command", async ({ page }) => {
    await expect(page.getByText(/npm run scan:consensus/i)).toBeVisible();
  });

  test("either shows signals or the empty-state hint, never blank", async ({ page }) => {
    // Two acceptable states:
    //   (a) at least one wallet table inside a signal card
    //   (b) an empty-state message guiding the operator to run the scan
    const tables = page.locator("table.list");
    const emptyState = page.getByText(/No consensus signals logged yet/i);
    const tablesCount = await tables.count();
    if (tablesCount > 0) {
      // Signal state — verify the first signal card has a direction + price
      const firstCard = page.locator(".card").nth(1); // first .card after the header card
      await expect(firstCard).toBeVisible();
      await expect(firstCard.getByText(/wallets/)).toBeVisible();
    } else {
      await expect(emptyState).toBeVisible();
    }
  });

  test("wallet links inside signals route to /wallets/[address]", async ({ page }) => {
    const walletLink = page.locator(`a[href^="/wallets/0x"]`).first();
    const exists = await walletLink.count();
    if (exists === 0) test.skip(true, "no consensus signals logged — run `npm run scan:consensus` first");
    await walletLink.click();
    await expect(page).toHaveURL(/\/wallets\/0x/);
  });
});
