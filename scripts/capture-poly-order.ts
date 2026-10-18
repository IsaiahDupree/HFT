/**
 * Network-capture variant of extract-poly-keys.
 *
 * Spins up a Chromium with our persistent profile, navigates to Polymarket,
 * and watches every outbound request to *.polymarket.com. When the operator
 * places an order in the UI, this script captures the exact request payload
 * (method, URL, headers, body) so we can diff it against what our SDK sends.
 *
 * Usage:
 *   npm run capture:poly-order
 *
 * Flow:
 *   1. Script opens Chromium. You log in (first time only).
 *   2. Press Enter in this terminal when ready to capture.
 *   3. In the Chromium window, place ONE small trade (e.g. $1 BUY on any market).
 *   4. The script will print the captured order request and save it to
 *      `data/poly-order-capture.json`.
 *   5. Press Enter again to exit.
 *
 * Why this exists: Polymarket's CLOB V2 SDK is industry-broken (May 2026,
 * "maker address not allowed"). Their web UI works. The diff between the
 * two request payloads will tell us exactly what the SDK is missing — or
 * confirm Polymarket's web UI uses a backend-signed flow we can't replicate.
 *
 * Captured fields of interest:
 *   - The actual `maker` address sent to /order
 *   - The `signatureType` they use (0/1/2 — we've tried 0 and 1, both fail)
 *   - The full EIP-712 signature scheme + domain
 *   - Whether they POST to /order directly or to a separate backend endpoint
 *   - Cookie/auth headers their UI relies on (CSRF tokens, session bearers)
 */
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

type CapturedRequest = {
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
  postDataJson?: unknown;
};

type CapturedResponse = {
  timestamp: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};

const PROFILE_DIR = resolve(process.cwd(), "data/playwright-chrome");
const OUT_PATH = resolve(process.cwd(), "data/poly-order-capture.json");

// File-based signaling so the script can run in a background terminal AND be
// driven by the operator dropping marker files when ready. Same UX as Enter
// presses but works without a foreground TTY.
const STOP_FLAG = resolve(process.cwd(), "data/.capture-stop");

/** Poll for a marker file every 2 seconds. Returns when the file appears.
 *  Auto-times out after `maxWaitMs` (default 30 min). */
async function waitForFile(path: string, maxWaitMs = 30 * 60 * 1000): Promise<void> {
  if (existsSync(path)) { try { unlinkSync(path); } catch {} }  // clear stale
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (existsSync(path)) {
      try { unlinkSync(path); } catch {}
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("  ⚠ wait timed out, continuing anyway");
}

function isPolymarketUrl(url: string): boolean {
  return /polymarket\.com/.test(url);
}

function isOrderEndpoint(url: string): boolean {
  // Order submission paths we care most about. Captures both clob and any
  // intermediate backend the UI may post to.
  return /\/order(\?|$|\/)|order\/submit|create-order|orders\/place/.test(url);
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];

  console.log("[capture-poly-order] launching Chromium with persistent profile");
  console.log("  profile dir:", PROFILE_DIR);
  console.log("");

  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // Attach listeners to EVERY page in this context, including new tabs the
  // user might open while trading.
  ctx.on("page", (page) => attachListeners(page));
  for (const page of ctx.pages()) attachListeners(page);

  function attachListeners(page: Page): void {
    page.on("request", async (req: Request) => {
      const url = req.url();
      if (!isPolymarketUrl(url)) return;
      const captured: CapturedRequest = {
        timestamp: new Date().toISOString(),
        method: req.method(),
        url,
        resourceType: req.resourceType(),
        headers: req.headers(),
        postData: req.postData(),
        postDataJson: req.postData() ? safeParseJson(req.postData()!) : undefined,
      };
      requests.push(captured);
      if (isOrderEndpoint(url) && req.method() === "POST") {
        console.log("");
        console.log("  ★ ORDER REQUEST CAPTURED");
        console.log("    →", req.method(), url);
        console.log("    body preview:", (req.postData() ?? "").slice(0, 240));
      }
    });
    page.on("response", async (resp) => {
      const url = resp.url();
      if (!isPolymarketUrl(url)) return;
      try {
        const body = await resp.text().catch(() => "");
        responses.push({
          timestamp: new Date().toISOString(),
          url, status: resp.status(),
          headers: resp.headers(),
          body: body.slice(0, 4000),  // truncate noisy market-data responses
        });
        if (isOrderEndpoint(url)) {
          console.log("    ← response status:", resp.status());
          console.log("    body preview:", body.slice(0, 240));
        }
      } catch { /* abandoned response */ }
    });
  }

  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto("https://polymarket.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!/\$\d|Portfolio|Cash/.test(bodyText)) {
    console.log("⚠  Not logged in. Log in to Polymarket in the open window.");
    console.log("");
  }

  console.log("");
  console.log("=== Capture is LIVE from this moment ===");
  console.log("Every Polymarket request will be logged as it happens.");
  console.log("");
  console.log("WHEN YOUR TRADE IS COMPLETE, drop a marker file to signal stop:");
  console.log("  in PowerShell:   New-Item data/.capture-stop -ItemType File");
  console.log("  or in bash:       touch data/.capture-stop");
  console.log("");
  console.log("Script will also auto-stop after 30 minutes if no marker arrives.");
  console.log("");

  await waitForFile(STOP_FLAG);

  console.log("");
  console.log("=== Capture window CLOSED ===");
  console.log(`Captured ${requests.length} requests, ${responses.length} responses.`);

  // Summarize order-related activity
  const orderReqs = requests.filter((r) => isOrderEndpoint(r.url) && r.method === "POST");
  console.log("Order-submission POSTs:", orderReqs.length);
  for (const r of orderReqs) {
    console.log("");
    console.log("  URL:", r.url);
    console.log("  Method:", r.method);
    console.log("  Headers of interest:");
    for (const [k, v] of Object.entries(r.headers)) {
      if (/poly|auth|signature|address|content-type|origin|x-/i.test(k)) {
        console.log("    " + k + ":", typeof v === "string" ? v.slice(0, 160) : v);
      }
    }
    console.log("  Body (parsed):");
    console.log("    " + JSON.stringify(r.postDataJson ?? r.postData, null, 2).split("\n").join("\n    "));
  }

  // Also surface unique non-order POSTs (auth, account, signing endpoints)
  const otherPosts = requests.filter((r) => r.method === "POST" && !isOrderEndpoint(r.url));
  console.log("");
  console.log("Other POSTs to polymarket.com:", otherPosts.length);
  const seen = new Set<string>();
  for (const r of otherPosts) {
    const path = new URL(r.url).pathname;
    if (seen.has(path)) continue;
    seen.add(path);
    console.log("  " + r.url);
  }

  writeFileSync(OUT_PATH, JSON.stringify({ requests, responses }, null, 2));
  console.log("");
  console.log("Full capture written to", OUT_PATH);

  await ctx.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
