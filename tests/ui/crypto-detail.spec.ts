import { test, expect } from "@playwright/test";

const PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD"];

test.describe("/crypto/[symbol] — Polymarket-faithful deep-dive", () => {
  for (const pid of PRODUCTS) {
    test(`/crypto/${pid} renders hero + countdown + similar markets`, async ({ page }) => {
      await page.goto(`/crypto/${pid}`);
      const sym = pid.split("-")[0];

      // Header — symbol pill + market title
      await expect(page.locator("h1")).toContainText(`${sym} Up or Down 5m`);

      // Price To Beat + Current Price prominently labeled
      await expect(page.getByText("Price To Beat")).toBeVisible();
      await expect(page.getByText("Current Price")).toBeVisible();

      // Mins:Secs big countdown visible
      await expect(page.getByTestId("live-countdown-secs").first()).toBeVisible();

      // Digit roller renders the current price
      await expect(page.getByTestId("digit-roller").first()).toBeVisible();

      // Resolution explainer
      await expect(page.getByText("How this market resolves")).toBeVisible();
      // "Chainlink" appears in both prose and the link — use the link for unambiguous match.
      await expect(page.getByRole("link", { name: /Chainlink/ })).toBeVisible();

      // Similar markets sidebar — should NOT include the current symbol but should
      // include each of the other 4.
      const sidebar = page.getByText("Similar markets").locator("..");
      await expect(sidebar).toBeVisible();
      for (const other of PRODUCTS.filter((p) => p !== pid)) {
        const otherSym = other.split("-")[0];
        const fullName = otherSym === "BTC" ? "Bitcoin"
          : otherSym === "ETH" ? "Ethereum"
          : otherSym === "SOL" ? "Solana"
          : otherSym === "XRP" ? "XRP"
          : otherSym === "DOGE" ? "Dogecoin" : otherSym;
        await expect(page.getByRole("link", { name: new RegExp(`${fullName}.*Up or Down`) })).toBeVisible();
      }

      // "One-tap buy" button matches Polymarket layout (disabled in our build)
      await expect(page.getByRole("button", { name: /One-tap buy/ })).toBeVisible();
    });
  }

  test("/crypto/UNKNOWN returns 404", async ({ page }) => {
    const r = await page.goto("/crypto/NOTAREALSYMBOL");
    expect(r?.status()).toBe(404);
  });

  test("countdown digit ticks on the deep-dive page too", async ({ page }) => {
    await page.goto("/crypto/BTC-USD");
    const secs = page.getByTestId("live-countdown-secs").first();
    await expect(secs).toBeVisible();
    const before = (await secs.textContent()) ?? "";
    await page.waitForTimeout(2200);
    const after = (await secs.textContent()) ?? "";
    expect(before).not.toBe(after);
  });
});
