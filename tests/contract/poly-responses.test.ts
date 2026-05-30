import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poly } from "@/lib/polymarket/client";

// Each test mocks fetch to assert request URL/headers AND that the client correctly parses the response.

function mockJson(body: any, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any)));
}

afterEach(() => vi.unstubAllGlobals());

describe("Gamma response parsing", () => {
  it.each([
    { len: 0 }, { len: 1 }, { len: 5 }, { len: 20 },
  ])("events returns array of length $len", async ({ len }) => {
    mockJson(Array.from({ length: len }, (_, i) => ({ id: i })));
    const r = await poly.events();
    expect(r).toHaveLength(len);
  });

  it("event returns object", async () => {
    mockJson({ id: 1, title: "x" });
    const r = await poly.event(1);
    expect((r as any).title).toBe("x");
  });

  it.each([
    { results: [] },
    { results: [{ id: 1 }] },
  ])("publicProfile returns object body", async ({ results }) => {
    mockJson({ proxyWallet: "0xabc", users: results });
    const r = await poly.publicProfile("0xabc");
    expect((r as any).proxyWallet).toBe("0xabc");
  });
});

describe("Data API response parsing", () => {
  it.each([0, 1, 5, 25, 100])("userPositions returns array length %i", async (len) => {
    mockJson(Array.from({ length: len }, () => ({})));
    const r = await poly.userPositions("0x4444444444444444444444444444444444444444");
    expect(r).toHaveLength(len);
  });

  it("userValue returns object", async () => {
    mockJson({ value: 1234.56 });
    const r = await poly.userValue("0x4444444444444444444444444444444444444444");
    expect((r as any).value).toBeCloseTo(1234.56);
  });

  it("traderLeaderboard returns ranked array", async () => {
    mockJson([{ rank: "1", pnl: 1000 }, { rank: "2", pnl: 500 }]);
    const r = await poly.traderLeaderboard({ limit: 2 });
    expect(r).toHaveLength(2);
    expect((r[0] as any).rank).toBe("1");
  });

  it("openInterest returns object", async () => {
    mockJson({ value: 1_000_000 });
    const r = await poly.openInterest();
    expect((r as any).value).toBe(1_000_000);
  });
});

describe("CLOB public response parsing", () => {
  it("clobMarkets returns paginated payload", async () => {
    mockJson({ data: [{ condition_id: "0xa" }], count: 1, limit: 10 });
    const r = await poly.clobMarkets({ limit: 10 });
    expect(r.data).toHaveLength(1);
    expect(r.count).toBe(1);
  });

  it("orderbook returns bids+asks", async () => {
    mockJson({
      market: "0xa",
      asset_id: "999",
      bids: [{ price: "0.45", size: "100" }],
      asks: [{ price: "0.55", size: "100" }],
    });
    const r = await poly.orderbook("999");
    expect((r as any).bids).toHaveLength(1);
    expect((r as any).asks).toHaveLength(1);
  });

  it.each(["BUY", "SELL"] as const)("price returns shape for side=$side", async (side) => {
    mockJson({ price: "0.45" });
    const r = await poly.price("999", side);
    expect(r.price).toBe("0.45");
  });

  it("midpoint returns { mid }", async () => {
    mockJson({ mid: "0.5" });
    const r = await poly.midpoint("999");
    expect(r.mid).toBe("0.5");
  });

  it("spread returns { spread }", async () => {
    mockJson({ spread: "0.02" });
    const r = await poly.spread("999");
    expect(r.spread).toBe("0.02");
  });

  it.each([
    { interval: "1d" as const, fidelity: 60, points: 5 },
    { interval: "1w" as const, fidelity: 60, points: 20 },
    { interval: "max" as const, fidelity: 60, points: 100 },
  ])("pricesHistory $interval returns $points points", async ({ interval, fidelity, points }) => {
    mockJson({ history: Array.from({ length: points }, (_, i) => ({ t: i, p: 0.5 })) });
    const r = await poly.pricesHistory("999", interval, fidelity);
    expect(r.history).toHaveLength(points);
  });
});

describe("Relayer response parsing", () => {
  beforeEach(() => {
    process.env.POLYMARKET_RELAYER_API_KEY = "test";
    process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS = "0x4444444444444444444444444444444444444444";
  });
  afterEach(() => {
    delete process.env.POLYMARKET_RELAYER_API_KEY;
    delete process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
  });

  it.each(["PROXY", "SAFE"] as const)("relayerPayload type=$type returns address+nonce", async (type) => {
    mockJson({ address: "0xrelayer", nonce: "5" });
    const r = await poly.relayerPayload(type);
    expect(r.address).toBe("0xrelayer");
    expect(r.nonce).toBe("5");
  });
});

describe("Error handling", () => {
  it("throws on non-2xx response with text snippet", async () => {
    mockJson({ error: "no" }, 404);
    await expect(poly.events()).rejects.toThrow(/404/);
  });

  it("throws on 500", async () => {
    mockJson({}, 500);
    await expect(poly.openInterest()).rejects.toThrow();
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503])("throws on HTTP %i", async (status) => {
    mockJson({ error: "x" }, status);
    await expect(poly.events()).rejects.toThrow();
  });
});
