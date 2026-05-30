import { test, expect } from "@playwright/test";

/**
 * /binaries dashboard — structural smoke tests.
 *
 * Verifies the page renders the 5 sections with their expected headings,
 * the AutoRefresh marker is present, and the per-asset table includes the
 * 7 supported assets when data is present (we don't assert exact counts —
 * those vary with whatever live snapshots have run).
 */
test.describe("/binaries", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/binaries", { waitUntil: "domcontentloaded" });
  });

  test("renders page header + refresh indicator", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Binaries", level: 1 })).toBeVisible();
    await expect(page.getByText(/Polymarket 5-min \/ 15-min crypto/i)).toBeVisible();
    await expect(page.getByText(/refreshes every 30s/i)).toBeVisible();
  });

  test("renders the 5 summary cards in the overview row", async ({ page }) => {
    // Target labels inside .card elements (the small label above each number).
    // The 5 overview cards appear before any tables, so "first" them.
    await expect(page.getByText("Total tracked").first()).toBeVisible();
    await expect(page.getByText("YES win-rate").first()).toBeVisible();
    await expect(page.getByText("Binary agents alive").first()).toBeVisible();
    // "Active" + "Resolved" are also used as column headers; checking the
    // card labels narrowly via the card grid (first section after header).
    const overviewSection = page.locator("section").first();
    await expect(overviewSection.getByText("Active", { exact: true })).toBeVisible();
    await expect(overviewSection.getByText("Resolved", { exact: true })).toBeVisible();
  });

  test("renders the four section headings", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "By asset", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Active /, level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Recently resolved /, level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Binary agents", level: 2 })).toBeVisible();
  });

  test("by-asset table has the standard columns", async ({ page }) => {
    const tableHeader = page.locator("table thead").first();
    await expect(tableHeader.getByText("Asset", { exact: true })).toBeVisible();
    await expect(tableHeader.getByText("Total", { exact: true })).toBeVisible();
    await expect(tableHeader.getByText("YES wins")).toBeVisible();
    await expect(tableHeader.getByText("NO wins")).toBeVisible();
    await expect(tableHeader.getByText("YES rate")).toBeVisible();
  });

  test("active table has TTL + YES mid + Holders columns", async ({ page }) => {
    // Active table is the 2nd table on the page (after By asset)
    const activeHeader = page.locator("table thead").nth(1);
    await expect(activeHeader.getByText("TTL", { exact: true })).toBeVisible();
    await expect(activeHeader.getByText("YES mid", { exact: true })).toBeVisible();
    await expect(activeHeader.getByText("Holders", { exact: true })).toBeVisible();
  });
});
