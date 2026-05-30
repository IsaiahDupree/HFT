/**
 * Polymarket profile/key extractor — uses Playwright with a persistent Chrome
 * profile (so you stay logged in across runs) to scrape every wallet/API/proxy
 * address Polymarket displays in your account UI.
 *
 *   npm run extract:poly-keys
 *
 * On first run, a Chromium window opens. Log in to Polymarket if you aren't
 * already. The script will then walk through Settings → Profile, Settings →
 * Relayer API keys, and the Deposit panel — collecting every `0x…` address it
 * sees. Output:
 *   - Console summary
 *   - data/polymarket-keys-extracted.json with full details + timestamps
 *   - Suggested .env.local diff (prints; doesn't auto-apply unless --apply)
 *
 * On subsequent runs, the profile is reused so no login is needed.
 *
 * Notes:
 *   - The Chromium profile lives in ./data/playwright-chrome (gitignored).
 *   - Headless: false on first run; pass --headless after first login if you
 *     want it to run silently.
 *   - This is a Polymarket-specific scraper. Polymarket may change their UI;
 *     each selector below is annotated with what it's matching.
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Extract = {
  timestamp: string;
  profile: {
    username?: string;
    email?: string;
    address?: string;          // The "Address" field on the profile page
    addressNote?: string;      // The disclaimer beside it
  };
  relayer: {
    signerAddress?: string;
    apiKeys: Array<{ key: string; created?: string }>;
  };
  deposit: {
    onChainAddress?: string;   // The on-chain proxy that holds USDC
    chains?: string[];         // Supported deposit chains
  };
  allAddressesSeen: Record<string, string[]>;   // address → list of pages it appeared on
};

const POLYMARKET_HOST = "https://polymarket.com";
const PROFILE_DIR = resolve(process.cwd(), "data/playwright-chrome");
const OUT_PATH = resolve(process.cwd(), "data/polymarket-keys-extracted.json");

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;
const API_KEY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Visit a path, return body innerText + every 0x address found. */
async function harvest(page: Page, path: string): Promise<{ text: string; addresses: string[]; apiKeys: string[] }> {
  console.log(`  → visiting ${path}`);
  try {
    await page.goto(POLYMARKET_HOST + path, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Wait for hydration; SPAs need a moment.
    await page.waitForTimeout(2500);
  } catch (e) {
    console.warn(`    ⚠ goto failed: ${(e as Error).message}`);
    return { text: "", addresses: [], apiKeys: [] };
  }
  const text = await page.locator("body").innerText().catch(() => "");
  const addresses = [...new Set(text.match(ADDRESS_RE) ?? [])];
  const apiKeys = [...new Set(text.match(API_KEY_RE) ?? [])];
  return { text, addresses, apiKeys };
}

async function findField(page: Page, label: string): Promise<string | undefined> {
  // Polymarket settings page renders labels followed by their value. Find by
  // text proximity. Tries a few common patterns.
  try {
    const row = await page.locator(`text=${label}`).first().locator("xpath=..").innerText({ timeout: 3000 });
    if (row) {
      // Strip the label from the row text.
      return row.replace(label, "").trim().split("\n")[0]?.trim();
    }
  } catch { /* not found */ }
  return undefined;
}

async function extractProfile(page: Page): Promise<Extract["profile"]> {
  const h = await harvest(page, "/settings");
  return {
    username: await findField(page, "Username"),
    email: await findField(page, "Email"),
    address: h.addresses[0],
    addressNote: h.text.includes("Do not send funds to this address") ? "Do not send funds to this address. For API use only." : undefined,
  };
}

async function extractRelayer(page: Page): Promise<Extract["relayer"]> {
  const h = await harvest(page, "/settings/relayer-api-keys");
  const signerLine = h.text.split("\n").find((l) => /signer/i.test(l));
  return {
    signerAddress: signerLine ? (signerLine.match(ADDRESS_RE)?.[0]) : undefined,
    apiKeys: h.apiKeys.map((k) => ({ key: k })),
  };
}

async function extractDeposit(page: Page): Promise<Extract["deposit"]> {
  // Try the /deposit page first; if Polymarket has a different URL, fall
  // through to the wallet panel.
  const candidates = ["/deposit", "/wallet", "/cashier"];
  for (const path of candidates) {
    const h = await harvest(page, path);
    if (h.addresses.length > 0) {
      return {
        onChainAddress: h.addresses[0],
        chains: extractChainHints(h.text),
      };
    }
  }
  return { onChainAddress: undefined };
}

function extractChainHints(text: string): string[] {
  const hints: string[] = [];
  for (const chain of ["Polygon", "Base", "Arbitrum", "Optimism", "Ethereum", "Solana"]) {
    if (text.includes(chain)) hints.push(chain);
  }
  return hints;
}

async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const headless = process.argv.includes("--headless");
  const apply = process.argv.includes("--apply");

  console.log(`[extract-poly-keys] launching Chromium (headless=${headless})`);
  console.log(`  profile dir: ${PROFILE_DIR}`);
  console.log(`  first run will need you to log in to polymarket.com in the window`);

  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();

  // Bounce off homepage first so cookies attach.
  await page.goto(POLYMARKET_HOST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Check login state — if not logged in, prompt and wait.
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!/\$\d|Portfolio|Cash/.test(bodyText) && !headless) {
    console.log("");
    console.log("⚠  Not logged in. Log in to Polymarket in the open window.");
    console.log("   Press Enter in THIS terminal when login is complete...");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  }

  const extract: Extract = {
    timestamp: new Date().toISOString(),
    profile: {},
    relayer: { apiKeys: [] },
    deposit: {},
    allAddressesSeen: {},
  };

  console.log("");
  console.log("[1/3] profile...");
  extract.profile = await extractProfile(page);
  console.log("[2/3] relayer api keys...");
  extract.relayer = await extractRelayer(page);
  console.log("[3/3] deposit...");
  extract.deposit = await extractDeposit(page);

  // Track every unique address per page for full visibility.
  for (const path of ["/", "/settings", "/settings/relayer-api-keys", "/deposit", "/wallet"]) {
    const h = await harvest(page, path);
    for (const addr of h.addresses) {
      if (!extract.allAddressesSeen[addr]) extract.allAddressesSeen[addr] = [];
      if (!extract.allAddressesSeen[addr].includes(path)) extract.allAddressesSeen[addr].push(path);
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify(extract, null, 2));

  console.log("");
  console.log("=== Extracted ===");
  console.log("profile.address:           ", extract.profile.address);
  console.log("relayer.signerAddress:     ", extract.relayer.signerAddress);
  console.log("relayer.apiKeys:           ", extract.relayer.apiKeys.length, "key(s)");
  for (const k of extract.relayer.apiKeys) console.log("                            ", k.key);
  console.log("deposit.onChainAddress:    ", extract.deposit.onChainAddress);
  console.log("deposit.chains:            ", extract.deposit.chains?.join(", ") ?? "—");
  console.log("");
  console.log("All addresses seen across pages:");
  for (const [addr, paths] of Object.entries(extract.allAddressesSeen)) {
    console.log("  " + addr + "  pages: " + paths.join(", "));
  }
  console.log("");
  console.log(`Full JSON written to ${OUT_PATH}`);

  // Suggest .env diff
  console.log("");
  console.log("=== Suggested .env.local diff (preview only) ===");
  const envPath = ".env.local";
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf8");
    const get = (key: string) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim()?.split(/\s+/)[0];
    const cur = {
      funder: get("POLYMARKET_FUNDER_ADDRESS"),
      signer: get("POLYMARKET_RELAYER_API_KEY_ADDRESS"),
      apiKey: get("POLYMARKET_RELAYER_API_KEY"),
    };
    const suggest = (label: string, current?: string, found?: string) => {
      if (!found) return;
      const match = current?.toLowerCase() === found.toLowerCase();
      console.log(`  ${label}: current=${current ?? "—"}  found=${found}  ${match ? "✓" : "→ DIFFERS"}`);
    };
    suggest("POLYMARKET_FUNDER_ADDRESS    ", cur.funder, extract.deposit.onChainAddress ?? extract.profile.address);
    suggest("POLYMARKET_RELAYER_API_KEY_ADDR", cur.signer, extract.relayer.signerAddress);
    suggest("POLYMARKET_RELAYER_API_KEY   ", cur.apiKey, extract.relayer.apiKeys.at(-1)?.key);
  }

  if (apply) {
    console.log("");
    console.log("⚠  --apply not implemented yet (preview-only by design). Hand-edit .env.local based on the diff above.");
  }

  await ctx.close();
}

main().catch((err) => {
  console.error("extract failed:", err);
  process.exit(1);
});
