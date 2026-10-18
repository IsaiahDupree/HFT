/**
 * Regression test for bug #13 (2026-05-26).
 *
 * Pre-fix: execute.ts read `resp?.success ?? true` — when the broker returned
 * a geoblock/auth error like `{"error": "Trading restricted...", "status": 403}`,
 * the missing `success` field defaulted to `true`, so the code logged the
 * trade as `single-executed` even though it had been rejected.
 *
 * Post-fix: the broker-error detector inspects `error` / `errorMsg` / `status`
 * and returns `kind: "rejected"` with the actual reason, writing a
 * `single-error` event instead of a false `single-executed`.
 *
 * We exercise the detector by stubbing the CLOB client to return each error
 * shape Polymarket actually emits in the wild.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

// Shared fixture for both the legacy `createAndPostMarketOrder` path (still
// referenced for arb-leg submission) and the new `submitMarketOrderViaProxy`
// path (single-side via OrderBuilder + polyFetch). The latter calls
// `client.orderBuilder.buildMarketOrder` (local sign) then posts via fetch —
// we stub global fetch to return whatever response we want to assert on.
const fakeOrderBuilder = {
  buildMarketOrder: vi.fn(async () => ({
    salt: "1", maker: "0x0", signer: "0x0", taker: "0x0", tokenId: "0",
    makerAmount: "5000000", takerAmount: "10000000", side: 0, signature: "0x", signatureType: 3,
    timestamp: "1", metadata: "0x0", builder: "0x0",
  })),
};
const fakeClient = {
  createAndPostMarketOrder: vi.fn(),
  cancelAll: vi.fn(async () => ({ ok: true })),
  orderBuilder: fakeOrderBuilder,
  signer: { getAddress: async () => "0x0000000000000000000000000000000000000000" },
};

vi.mock("@polymarket/clob-client", () => ({
  ClobClient: vi.fn(() => fakeClient),
}));
vi.mock("@polymarket/clob-client-v2", () => ({
  ClobClient: vi.fn(() => fakeClient),
  orderToJsonV2: (order: any, owner: string, orderType: string) => ({ order, owner, orderType }),
  createL2Headers: async () => ({
    POLY_ADDRESS: "0x0", POLY_SIGNATURE: "sig", POLY_TIMESTAMP: "1", POLY_API_KEY: "k", POLY_PASSPHRASE: "p",
  }),
}));

const ORIG_ENV = { ...process.env };

beforeEach(async () => {
  memDb?.close();
  memDb = null;
  process.env.ALLOW_TRADE = "1";
  process.env.MAX_TRADE_USD = "100";
  process.env.MAX_DAILY_USD = "1000";
  process.env.POLYMARKET_PRIVATE_KEY = "0x" + "1".repeat(64);
  process.env.POLYMARKET_CLOB_API_KEY = "k";
  process.env.POLYMARKET_CLOB_SECRET = "s";
  process.env.POLYMARKET_CLOB_PASSPHRASE = "p";
  fakeClient.createAndPostMarketOrder.mockReset();
  const { resetClobClientForTests } = await import("@/lib/polymarket/execute");
  resetClobClientForTests();
});

afterEach(() => { process.env = { ...ORIG_ENV }; vi.unstubAllGlobals(); });

/** Stub global fetch to return a synthetic Response with the given JSON body
 *  + status. The new submit path uses polyFetch → fetch (or axios with
 *  proxy) — easier to stub at the global fetch level. */
function stubFetchResponse(body: any, status = 200): void {
  const responseBody = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(responseBody, {
    status,
    headers: { "content-type": "application/json" },
  })));
}

describe("execute.ts broker-error detection (bug #13)", () => {
  it("Polymarket 403 geoblock → single-error, not single-executed", async () => {
    stubFetchResponse({
      error: "Trading restricted in your region, please refer to available regions - https://docs.polymarket.com/developers/CLOB/geoblock",
      status: 403,
    });
    const { submitSingleSideMarket } = await import("@/lib/polymarket/execute");
    const r = await submitSingleSideMarket({
      tokenId: "0x" + "a".repeat(64),
      side: "BUY", sizeUsd: 5, refPrice: 0.5, rationale: "test",
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(r.reason).toMatch(/geoblock|restricted/i);

    const { db } = await import("@/lib/db/client");
    const evt = db().prepare(`SELECT event_type, summary FROM evolution_log ORDER BY id DESC LIMIT 1`).get() as { event_type: string; summary: string };
    expect(evt.event_type).toBe("single-error");
    expect(evt.summary).toMatch(/BROKER REJECTED/);
  });

  it("Bare 4xx without error message → single-error", async () => {
    stubFetchResponse({ status: 429 });
    const { submitSingleSideMarket } = await import("@/lib/polymarket/execute");
    const r = await submitSingleSideMarket({
      tokenId: "0x" + "b".repeat(64),
      side: "BUY", sizeUsd: 5, refPrice: 0.5, rationale: "test",
    });
    expect(r.kind).toBe("rejected");

    const { db } = await import("@/lib/db/client");
    const evt = db().prepare(`SELECT event_type FROM evolution_log ORDER BY id DESC LIMIT 1`).get() as { event_type: string };
    expect(evt.event_type).toBe("single-error");
  });

  it("errorMsg string variant (some CLOB endpoints use this) → single-error", async () => {
    stubFetchResponse({
      errorMsg: "insufficient allowance",
    });
    const { submitSingleSideMarket } = await import("@/lib/polymarket/execute");
    const r = await submitSingleSideMarket({
      tokenId: "0x" + "c".repeat(64),
      side: "BUY", sizeUsd: 5, refPrice: 0.5, rationale: "test",
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(r.reason).toMatch(/insufficient allowance/);
  });

  it("Real success response → single-executed, returns kind=executed", async () => {
    stubFetchResponse({
      success: true,
      orderID: "0xabc",
    });
    const { submitSingleSideMarket } = await import("@/lib/polymarket/execute");
    const r = await submitSingleSideMarket({
      tokenId: "0x" + "d".repeat(64),
      side: "BUY", sizeUsd: 5, refPrice: 0.5, rationale: "test",
    });
    expect(r.kind).toBe("executed");

    const { db } = await import("@/lib/db/client");
    const evt = db().prepare(`SELECT event_type FROM evolution_log ORDER BY id DESC LIMIT 1`).get() as { event_type: string };
    expect(evt.event_type).toBe("single-executed");
  });

  it("Response missing success field but no error → defaults to executed (legacy SDK)", async () => {
    // Some older clob-client versions return just {orderID: ..., orderHashes: [...]}
    // with no `success` field — we keep treating that as success per existing
    // semantics, since there's no error signal.
    stubFetchResponse({
      orderID: "0xfeed",
      orderHashes: ["0xhash"],
    });
    const { submitSingleSideMarket } = await import("@/lib/polymarket/execute");
    const r = await submitSingleSideMarket({
      tokenId: "0x" + "e".repeat(64),
      side: "BUY", sizeUsd: 5, refPrice: 0.5, rationale: "test",
    });
    expect(r.kind).toBe("executed");
  });
});
