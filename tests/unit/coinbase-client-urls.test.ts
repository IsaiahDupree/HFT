import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

// Verify the client always produces correct URLs and that auth headers are
// attached on private endpoints but never on public market endpoints.

const TEST_KEY_NAME = "organizations/test-org/apiKeys/test-key";

function pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return (privateKey as KeyObject).export({ type: "sec1", format: "pem" }) as string;
}

let originalFetch: typeof globalThis.fetch;
let originalHost: string | undefined;
let calls: { url: string; init: RequestInit }[] = [];

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  originalHost = process.env.COINBASE_HOST;
  process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
  process.env.COINBASE_CDP_PRIVATE_KEY = pem();
  process.env.COINBASE_CDP_KEY_FILE = "tests/.fixtures/__missing__.json";
  calls = [];
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "29",
        "x-ratelimit-reset": "1700000000",
      },
    });
  }) as any;
  const { clearAuthCache } = await import("@/lib/coinbase/auth");
  clearAuthCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHost === undefined) delete process.env.COINBASE_HOST;
  else process.env.COINBASE_HOST = originalHost;
  delete process.env.COINBASE_CDP_KEY_NAME;
  delete process.env.COINBASE_CDP_PRIVATE_KEY;
  delete process.env.COINBASE_CDP_KEY_FILE;
});

describe("cb client — URL building", () => {
  it.each([
    { name: "time", call: async (cb: any) => cb.time(), expectPath: "/api/v3/brokerage/time", auth: false },
    { name: "publicListProducts", call: async (cb: any) => cb.publicListProducts({ limit: 5 }), expectPath: "/api/v3/brokerage/market/products?limit=5", auth: false },
    { name: "publicGetProduct", call: async (cb: any) => cb.publicGetProduct("BTC-USD"), expectPath: "/api/v3/brokerage/market/products/BTC-USD", auth: false },
    { name: "publicGetProductBook", call: async (cb: any) => cb.publicGetProductBook({ product_id: "BTC-USD", limit: 5 }), expectPath: "/api/v3/brokerage/market/product_book?product_id=BTC-USD&limit=5", auth: false },
    { name: "listAccounts", call: async (cb: any) => cb.listAccounts({ limit: 10 }), expectPath: "/api/v3/brokerage/accounts?limit=10", auth: true },
    { name: "getAccount", call: async (cb: any) => cb.getAccount("uuid-xyz"), expectPath: "/api/v3/brokerage/accounts/uuid-xyz", auth: true },
    { name: "listProducts", call: async (cb: any) => cb.listProducts({ limit: 3 }), expectPath: "/api/v3/brokerage/products?limit=3", auth: true },
    { name: "getProduct", call: async (cb: any) => cb.getProduct("BTC-USD"), expectPath: "/api/v3/brokerage/products/BTC-USD", auth: true },
    { name: "getBestBidAsk", call: async (cb: any) => cb.getBestBidAsk({ product_ids: ["BTC-USD", "ETH-USD"] }), expectPath: "/api/v3/brokerage/best_bid_ask?product_ids=BTC-USD&product_ids=ETH-USD", auth: true },
    { name: "listOrders", call: async (cb: any) => cb.listOrders({ order_status: ["OPEN", "PENDING"], limit: 5 }), expectPath: "/api/v3/brokerage/orders/historical/batch?order_status=OPEN&order_status=PENDING&limit=5", auth: true },
    { name: "listFills", call: async (cb: any) => cb.listFills({ limit: 10 }), expectPath: "/api/v3/brokerage/orders/historical/fills?limit=10", auth: true },
    { name: "getOrder", call: async (cb: any) => cb.getOrder("order-123"), expectPath: "/api/v3/brokerage/orders/historical/order-123", auth: true },
    { name: "listPortfolios", call: async (cb: any) => cb.listPortfolios(), expectPath: "/api/v3/brokerage/portfolios", auth: true },
    { name: "getPortfolioBreakdown", call: async (cb: any) => cb.getPortfolioBreakdown("uuid-p"), expectPath: "/api/v3/brokerage/portfolios/uuid-p", auth: true },
    { name: "getTransactionSummary", call: async (cb: any) => cb.getTransactionSummary(), expectPath: "/api/v3/brokerage/transaction_summary", auth: true },
    { name: "listPaymentMethods", call: async (cb: any) => cb.listPaymentMethods(), expectPath: "/api/v3/brokerage/payment_methods", auth: true },
    { name: "getKeyPermissions", call: async (cb: any) => cb.getKeyPermissions(), expectPath: "/api/v3/brokerage/key_permissions", auth: true },
  ])("$name → $expectPath (auth=$auth)", async ({ call, expectPath, auth }) => {
    const { cb } = await import("@/lib/coinbase/client");
    await call(cb);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.coinbase.com${expectPath}`);
    const hasAuth = (calls[0].init.headers as Record<string, string>)?.Authorization?.startsWith("Bearer ");
    if (auth) expect(hasAuth).toBe(true);
    else expect(hasAuth).toBeFalsy();
  });

  it("honors COINBASE_HOST override (e.g. for sandbox)", async () => {
    process.env.COINBASE_HOST = "https://api-sandbox.coinbase.com";
    const { cb } = await import("@/lib/coinbase/client");
    await cb.time();
    expect(calls[0].url).toBe("https://api-sandbox.coinbase.com/api/v3/brokerage/time");
  });

  it("captures rate-limit headers on the last call", async () => {
    const { cb, getLastRateLimit } = await import("@/lib/coinbase/client");
    await cb.time();
    const rl = getLastRateLimit();
    expect(rl.limit).toBe(30);
    expect(rl.remaining).toBe(29);
    expect(rl.resetUnix).toBe(1700000000);
  });

  it("createOrder POSTs JSON body to /orders with auth", async () => {
    const { cb } = await import("@/lib/coinbase/client");
    await cb.createOrder({
      client_order_id: "abc",
      product_id: "BTC-USD",
      side: "BUY",
      order_configuration: { market_market_ioc: { quote_size: "10" } },
    });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toBe("https://api.coinbase.com/api/v3/brokerage/orders");
    expect(typeof calls[0].init.body).toBe("string");
    const parsed = JSON.parse(calls[0].init.body as string);
    expect(parsed.product_id).toBe("BTC-USD");
    expect(parsed.side).toBe("BUY");
    expect(parsed.order_configuration.market_market_ioc.quote_size).toBe("10");
  });

  it("batchCancelOrders POSTs order_ids array", async () => {
    const { cb } = await import("@/lib/coinbase/client");
    await cb.batchCancelOrders({ order_ids: ["a", "b", "c"] });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toBe("https://api.coinbase.com/api/v3/brokerage/orders/batch_cancel");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ order_ids: ["a", "b", "c"] });
  });

  it("throws on non-2xx with method + path + status in message", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 403, headers: { "content-type": "text/plain" } })) as any;
    const { cb } = await import("@/lib/coinbase/client");
    await expect(cb.listAccounts()).rejects.toThrow(/GET \/api\/v3\/brokerage\/accounts → 403/);
  });
});
