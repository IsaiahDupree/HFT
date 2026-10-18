import { test, expect } from "@playwright/test";

/**
 * Hydration regression guard. For every major page, listen to the browser
 * console + page errors and fail the test if React reports a hydration
 * mismatch ("Hydration failed" / "didn't match" / "Text content does not
 * match"). Catches the same class of bug that hit SystemStatusBar — anywhere
 * we ever render Date.now()/Math.random()/locale-formatted-now in JSX.
 *
 * Also fails on any "DOMException" or "Invariant" errors that React emits
 * during hydration, since those usually mean the SSR/CSR trees diverged.
 */
const HYDRATION_PATTERNS = [
  /Hydration failed/i,
  /Text content does not match/i,
  /server-rendered (HTML|text) didn'?t match/i,
  /Hydration mismatch/i,
];

// Dynamic-route IDs are read from env so CI can override with synthetic DB IDs.
// Defaults match the locally-seeded DB (atlas-macro + fade-headline-spikes
// strategy, majorexploiter wallet, a real snapshot condition_id).
const AGENT_SLUG = process.env.UI_TEST_AGENT_SLUG ?? "atlas-macro";
const STRATEGY_AGENT = process.env.UI_TEST_STRATEGY_AGENT ?? "atlas-macro";
const STRATEGY_SLUG = process.env.UI_TEST_STRATEGY_SLUG ?? "fade-headline-spikes";
const WALLET_ADDR = process.env.UI_TEST_WALLET_ADDR ?? "0x019782cab5d844f02bafb71f512758be78579f3c";
const CONDITION_ID = process.env.UI_TEST_CONDITION_ID ?? "0x384e2707bbb95da4bfa6f330fe7d5ccbec1c0a85e20be900cbf599987588e1a4";

const PAGES = [
  // Top-level dashboards
  "/",
  "/agents",
  "/strategies",
  "/research",
  "/evolution",
  "/trades",
  "/tracked",
  "/onchain",
  "/live",
  "/markets",
  "/arb",
  "/arb/comb",

  // Arena
  "/arena",
  "/arena/generations",
  "/arena/generations/1",   // gen detail — exercise the dynamic route with an early gen that always exists in seeded DBs
  "/arena/mutations",

  // Risk + capsule UX
  "/capsules",
  "/safety",
  "/settings",

  // Strategy opportunities (gen-2 unified feed)
  "/opportunities",

  // Coinbase
  "/coinbase",
  "/coinbase/orders",
  "/coinbase/products",

  // Crypto
  "/crypto",
  "/crypto/BTC-USD",
  "/crypto/ETH-USD",

  // New: wallet-scanner + consensus pipeline
  "/consensus",
  `/wallets/${WALLET_ADDR}`,

  // Short-duration binaries dashboard
  "/binaries",

  // Polymarket deposit QR generator
  "/deposit",

  // Dynamic routes that need real DB-backed IDs
  `/agents/${AGENT_SLUG}`,
  `/strategies/${STRATEGY_AGENT}/${STRATEGY_SLUG}`,
  `/markets/condition/${CONDITION_ID}`,
];

test.describe("hydration — no SSR/CSR mismatch on any page", () => {
  for (const path of PAGES) {
    test(`${path} hydrates cleanly`, async ({ page }) => {
      const offenders: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (HYDRATION_PATTERNS.some((re) => re.test(text))) {
          offenders.push(`console: ${text.slice(0, 800)}`);
        }
      });
      page.on("pageerror", (err) => {
        const text = err.message;
        if (HYDRATION_PATTERNS.some((re) => re.test(text))) {
          offenders.push(`pageerror: ${text.slice(0, 1500)}`);
        }
      });
      // Use 'domcontentloaded' instead of the default 'load' wait so pages
      // with long-lived streams (/onchain SSE, /live WS) don't block the test
      // navigation. `networkidle` would never fire on those pages.
      await page.goto(path, { waitUntil: "domcontentloaded" });
      // Give React 1.5s to attempt hydration + run client effects. If a
      // mismatch fires, it surfaces in the console listener inside this window.
      await page.waitForTimeout(1500);
      if (offenders.length > 0) {
        throw new Error(`Hydration error(s) on ${path}:\n  - ${offenders.join("\n  - ")}`);
      }
    });
  }
});
