/**
 * Integration tests for the Coinbase trade-execution safety gates.
 * Uses the project's vi.mock pattern (see db-queries.test.ts) to swap the
 * singleton db() for an in-memory SQLite; mocks fetch so no network is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { makeMemoryDb } from "../helpers/db";

// Mock the db client BEFORE importing anything that uses it.
let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

const TEST_KEY_NAME = "organizations/test-org/apiKeys/test-key";
function pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return (privateKey as KeyObject).export({ type: "sec1", format: "pem" }) as string;
}

let originalFetch: typeof globalThis.fetch;
let originalAllow: string | undefined;
let originalMaxTrade: string | undefined;
let originalMaxDaily: string | undefined;
let fetchCalls: { url: string; method?: string }[] = [];

beforeEach(async () => {
  memDb?.close();
  memDb = null;
  originalFetch = globalThis.fetch;
  originalAllow = process.env.COINBASE_ALLOW_TRADE;
  originalMaxTrade = process.env.COINBASE_MAX_TRADE_USD;
  originalMaxDaily = process.env.COINBASE_MAX_DAILY_USD;
  process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
  process.env.COINBASE_CDP_PRIVATE_KEY = pem();
  process.env.COINBASE_CDP_KEY_FILE = "tests/.fixtures/__missing__.json";
  delete process.env.COINBASE_ALLOW_TRADE;

  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), method: init?.method });
    const u = String(url);
    if (u.includes("/best_bid_ask")) {
      return new Response(JSON.stringify({ pricebooks: [{ product_id: "BTC-USD", bids: [{ price: "60000.00", size: "1" }], asks: [{ price: "60010", size: "1" }], time: "" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/api/v3/brokerage/orders") && init?.method === "POST") {
      return new Response(JSON.stringify({ success: true, success_response: { order_id: "order-fake-1" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/orders/historical/batch")) {
      return new Response(JSON.stringify({ orders: [], cursor: "", has_next: false, sequence: "0" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/orders/batch_cancel")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  const { clearAuthCache } = await import("@/lib/coinbase/auth");
  clearAuthCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAllow === undefined) delete process.env.COINBASE_ALLOW_TRADE; else process.env.COINBASE_ALLOW_TRADE = originalAllow;
  if (originalMaxTrade === undefined) delete process.env.COINBASE_MAX_TRADE_USD; else process.env.COINBASE_MAX_TRADE_USD = originalMaxTrade;
  if (originalMaxDaily === undefined) delete process.env.COINBASE_MAX_DAILY_USD; else process.env.COINBASE_MAX_DAILY_USD = originalMaxDaily;
  delete process.env.COINBASE_CDP_KEY_NAME;
  delete process.env.COINBASE_CDP_PRIVATE_KEY;
  delete process.env.COINBASE_CDP_KEY_FILE;
  memDb?.close();
  memDb = null;
});

describe("executeCoinbaseMarket — DRY_RUN gate (COINBASE_ALLOW_TRADE != 1)", () => {
  it("returns kind=dry-run and writes a cb-dry-run evolution event without calling fetch for /orders", async () => {
    const { executeCoinbaseMarket } = await import("@/lib/coinbase/execute");
    const { db } = await import("@/lib/db/client");
    const verdict = await executeCoinbaseMarket({ productId: "BTC-USD", side: "BUY", size: "10" });
    expect(verdict.kind).toBe("dry-run");
    // Only the best_bid_ask probe (used in estimateUsd for SELL) — BUY skips it. Verify no POST.
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    const events = db().prepare("SELECT event_type FROM evolution_log").all() as Array<{ event_type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.find((e) => e.event_type === "cb-dry-run")).toBeTruthy();
  });
});

describe("executeCoinbaseMarket — per-trade cap", () => {
  it("rejects when BUY quote_size exceeds COINBASE_MAX_TRADE_USD", async () => {
    process.env.COINBASE_ALLOW_TRADE = "1";
    process.env.COINBASE_MAX_TRADE_USD = "10";
    const { executeCoinbaseMarket } = await import("@/lib/coinbase/execute");
    const { db } = await import("@/lib/db/client");
    const verdict = await executeCoinbaseMarket({ productId: "BTC-USD", side: "BUY", size: "100" });
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason).toBe("trade cap");
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    const rejected = db().prepare("SELECT event_type FROM evolution_log WHERE event_type='cb-rejected'").get() as { event_type: string } | undefined;
    expect(rejected?.event_type).toBe("cb-rejected");
  });

  it("rejects when SELL converted via best-bid exceeds the cap", async () => {
    process.env.COINBASE_ALLOW_TRADE = "1";
    process.env.COINBASE_MAX_TRADE_USD = "10";
    const { executeCoinbaseMarket } = await import("@/lib/coinbase/execute");
    const verdict = await executeCoinbaseMarket({ productId: "BTC-USD", side: "SELL", size: "1" });
    expect(verdict.kind).toBe("rejected");
  });
});

describe("executeCoinbaseMarket — daily cap (computed from evolution_log)", () => {
  it("blocks when the rolling 24h cb-executed total + new trade exceeds COINBASE_MAX_DAILY_USD", async () => {
    process.env.COINBASE_ALLOW_TRADE = "1";
    process.env.COINBASE_MAX_TRADE_USD = "100";
    process.env.COINBASE_MAX_DAILY_USD = "50";
    const { db } = await import("@/lib/db/client");
    db().prepare(`INSERT INTO evolution_log (event_type, summary, payload_json) VALUES ('cb-executed', 'seed', json_object('cost_usd', 40))`).run();
    const { executeCoinbaseMarket } = await import("@/lib/coinbase/execute");
    const verdict = await executeCoinbaseMarket({ productId: "BTC-USD", side: "BUY", size: "30" });
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason).toBe("daily cap");
  });
});

describe("executeCoinbaseMarket — LIVE path submits and logs", () => {
  it("calls POST /orders and records cb-executed when all gates pass", async () => {
    process.env.COINBASE_ALLOW_TRADE = "1";
    process.env.COINBASE_MAX_TRADE_USD = "100";
    process.env.COINBASE_MAX_DAILY_USD = "1000";
    const { executeCoinbaseMarket } = await import("@/lib/coinbase/execute");
    const { db } = await import("@/lib/db/client");
    const verdict = await executeCoinbaseMarket({ productId: "BTC-USD", side: "BUY", size: "5" });
    expect(verdict.kind).toBe("executed");
    const postedOrder = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/api/v3/brokerage/orders"));
    expect(postedOrder).toBeTruthy();
    const types = db().prepare("SELECT event_type FROM evolution_log ORDER BY id").all().map((r: any) => r.event_type);
    expect(types).toContain("cb-submitting");
    expect(types).toContain("cb-executed");
  });
});

describe("killSwitch — defensive cancel of every open order", () => {
  it("is allowed regardless of COINBASE_ALLOW_TRADE and logs cb-kill-switch", async () => {
    delete process.env.COINBASE_ALLOW_TRADE;
    const { killSwitch } = await import("@/lib/coinbase/execute");
    const { db } = await import("@/lib/db/client");
    const result = await killSwitch();
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(0); // mocked listOrders returns empty
    const evt = db().prepare("SELECT event_type FROM evolution_log WHERE event_type='cb-kill-switch'").get() as { event_type: string } | undefined;
    expect(evt?.event_type).toBe("cb-kill-switch");
  });
});
