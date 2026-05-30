import { test, expect } from "@playwright/test";

/**
 * /tracked + /wallets/[address] — wallet scanner UI.
 *
 * Verifies the live pipeline lands in the UI:
 *   - /tracked lists every seeded wallet
 *   - The address link on each row navigates to the fingerprint view
 *   - /wallets/[address] renders fingerprint sections (strategy family,
 *     cadence, sizing, top markets) without errors
 *
 * If the DB has no resolved wallets (handle never resolved), the address-row
 * test is skipped instead of failing.
 */

const WALLET_ADDR = process.env.UI_TEST_WALLET_ADDR ?? "0x019782cab5d844f02bafb71f512758be78579f3c";

test.describe("/tracked", () => {
  test("renders header + table", async ({ page }) => {
    await page.goto("/tracked");
    await expect(page.getByRole("heading", { name: /Tracked wallets/ })).toBeVisible();
    // The table header columns must all exist
    for (const col of ["Handle", "Strategy", "Claimed PnL", "Proxy wallet"]) {
      await expect(page.getByRole("columnheader", { name: new RegExp(col, "i") })).toBeVisible();
    }
  });

  test("clicking a resolved wallet address opens /wallets/[address] fingerprint", async ({ page }) => {
    await page.goto("/tracked");
    // Locate the first wallet-address link inside the table body. Skip if none resolved.
    const walletLink = page.locator(`a[href^="/wallets/0x"]`).first();
    const count = await walletLink.count();
    if (count === 0) test.skip(true, "no resolved wallets in DB; run `npm run resolve:tracked` first");
    await walletLink.click();
    await expect(page).toHaveURL(/\/wallets\/0x[0-9a-fA-F]+/);
    await expect(page.getByText(/Strategy fingerprint/)).toBeVisible();
  });
});

test.describe("/wallets/[address]", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/wallets/${WALLET_ADDR}`);
  });

  test("renders the strategy fingerprint card with a family badge", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /Strategy fingerprint/ })).toBeVisible();
    // Badge contains one of the documented strategy family labels.
    const familyBadge = page.locator("text=/Latency arb|Market making|Correlated basket|Directional crypto|Longshot hunter|Generalist|Low signal/i").first();
    await expect(familyBadge).toBeVisible();
  });

  test("renders cadence + sizing tables", async ({ page }) => {
    // Section H2 headings — use role-based locator to avoid colliding with
    // the in-table "Bot-cadence score" label which also contains "Cadence".
    await expect(page.getByRole("heading", { name: "Cadence", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sizing + categories", exact: true })).toBeVisible();
    await expect(page.getByText(/Bot-cadence score/)).toBeVisible();
    await expect(page.getByText(/Crypto markets/)).toBeVisible();
  });

  test("links out to Polymarket profile + Polygonscan", async ({ page }) => {
    await expect(page.getByRole("link", { name: /polymarket profile/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /polygonscan/i })).toBeVisible();
  });

  test("'how to use this' footer warns against copy-trading", async ({ page }) => {
    await expect(page.getByText(/Don't auto-copy any single wallet/i)).toBeVisible();
  });
});
