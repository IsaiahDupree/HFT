import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poly } from "@/lib/polymarket/client";

// We capture every fetch call to verify URL construction without hitting the network.
let calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers });
    // Return a minimal valid response for whatever the call needs
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({ data: [], events: [] }),
    } as any;
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gamma URL construction", () => {
  it("events default limit 10", async () => {
    await poly.events();
    expect(calls[0].url).toContain("/events?");
    expect(calls[0].url).toContain("limit=10");
  });

  it.each([1, 5, 25, 100])("events with limit=$limit", async (limit) => {
    await poly.events({ limit });
    expect(calls[0].url).toContain(`limit=${limit}`);
  });

  it.each([true, false])("events closed=$closed", async (closed) => {
    await poly.events({ closed });
    expect(calls[0].url).toContain(`closed=${closed}`);
  });

  it("event by id uses path param", async () => {
    await poly.event(12345);
    expect(calls[0].url).toMatch(/\/events\/12345$/);
  });

  it("marketsByCondition REPEATS the condition_ids param (comma-joined silently returns [])", async () => {
    await poly.marketsByCondition(["0xabc", "0xdef"]);
    // Gamma stopped honoring comma-joined ids (observed 2026-06-11: [] with no
    // error, zeroed copy-backtest's resolved mode). Verified live: the repeated
    // form returns the union of single-id queries.
    expect(calls[0].url).toMatch(/condition_ids=0xabc&condition_ids=0xdef/);
  });

  it.each([5, 10, 20, 50])("tags limit=$limit", async (limit) => {
    await poly.tags(limit);
    expect(calls[0].url).toMatch(new RegExp(`/tags\\?limit=${limit}$`));
  });

  it("search encodes query", async () => {
    await poly.search("hello world", 3);
    expect(calls[0].url).toContain("q=hello%20world");
    expect(calls[0].url).toContain("limit_per_type=3");
  });

  it("publicProfile lowercases address", async () => {
    await poly.publicProfile("0xABCDEFabcdef00000000000000000000000000aa");
    expect(calls[0].url).toContain("address=0xabcdefabcdef00000000000000000000000000aa");
  });
});

describe("Data API URL construction", () => {
  const ADDR = "0x4444444444444444444444444444444444444444";

  it("userPositions default limit 50", async () => {
    await poly.userPositions(ADDR);
    expect(calls[0].url).toContain(`user=${ADDR}`);
    expect(calls[0].url).toContain("limit=50");
  });

  it.each([1, 10, 100])("userTrades limit=$limit", async (limit) => {
    await poly.userTrades(ADDR, { limit });
    expect(calls[0].url).toContain(`limit=${limit}`);
  });

  it("userValue path", async () => {
    await poly.userValue(ADDR);
    expect(calls[0].url).toMatch(/\/value\?user=/);
  });

  it("openInterest endpoint", async () => {
    await poly.openInterest();
    expect(calls[0].url).toMatch(/\/oi$/);
  });

  it.each([1, 5, 10, 25])("topHolders limit=$limit", async (limit) => {
    await poly.topHolders("0xcond", limit);
    expect(calls[0].url).toContain(`market=0xcond`);
    expect(calls[0].url).toContain(`limit=${limit}`);
  });

  it.each(["OPEN", "CLOSED", "ALL"] as const)("marketPositions status=$status", async (status) => {
    await poly.marketPositions("0xcond", status);
    expect(calls[0].url).toContain("/v1/market-positions");
    expect(calls[0].url).toContain(`status=${status}`);
  });

  it("liveEventVolume uses ?id=", async () => {
    await poly.liveEventVolume(42);
    expect(calls[0].url).toContain("/live-volume?id=42");
  });

  it.each([
    { category: "OVERALL", timePeriod: "DAY" as const, orderBy: "PNL" as const, limit: 25 },
    { category: "POLITICS", timePeriod: "WEEK" as const, orderBy: "VOL" as const, limit: 10 },
    { category: "CRYPTO", timePeriod: "ALL" as const, orderBy: "PNL" as const, limit: 5 },
  ])("traderLeaderboard $category $timePeriod $orderBy limit=$limit", async (opts) => {
    await poly.traderLeaderboard(opts);
    expect(calls[0].url).toContain("/v1/leaderboard");
    expect(calls[0].url).toContain(`category=${opts.category}`);
    expect(calls[0].url).toContain(`timePeriod=${opts.timePeriod}`);
    expect(calls[0].url).toContain(`orderBy=${opts.orderBy}`);
    expect(calls[0].url).toContain(`limit=${opts.limit}`);
  });
});

describe("CLOB public URL construction", () => {
  it.each([1, 5, 50, 200])("clobMarkets limit=$limit", async (limit) => {
    await poly.clobMarkets({ limit });
    expect(calls[0].url).toContain(`limit=${limit}`);
  });

  it("orderbook ?token_id=", async () => {
    await poly.orderbook("999");
    expect(calls[0].url).toContain("/book?token_id=999");
  });

  it.each(["BUY", "SELL"] as const)("price side=$side", async (side) => {
    await poly.price("999", side);
    expect(calls[0].url).toContain(`side=${side}`);
  });

  it("midpoint path", async () => {
    await poly.midpoint("999");
    expect(calls[0].url).toContain("/midpoint?token_id=999");
  });

  it("spread path", async () => {
    await poly.spread("999");
    expect(calls[0].url).toContain("/spread?token_id=999");
  });

  it("lastTradePrice path", async () => {
    await poly.lastTradePrice("999");
    expect(calls[0].url).toContain("/last-trade-price?token_id=999");
  });

  it.each(["max", "1w", "1d", "6h", "1h"] as const)("pricesHistory interval=$interval", async (interval) => {
    await poly.pricesHistory("999", interval, 60);
    expect(calls[0].url).toContain(`interval=${interval}`);
  });

  it.each([1, 5, 30, 60, 120])("pricesHistory fidelity=$fidelity", async (fidelity) => {
    await poly.pricesHistory("999", "1d", fidelity);
    expect(calls[0].url).toContain(`fidelity=${fidelity}`);
  });
});

describe("Relayer URL construction", () => {
  beforeEach(() => {
    process.env.POLYMARKET_RELAYER_API_KEY = "test-key";
    process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS = "0x4444444444444444444444444444444444444444";
  });
  afterEach(() => {
    delete process.env.POLYMARKET_RELAYER_API_KEY;
    delete process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
  });

  it.each(["PROXY", "SAFE"] as const)("relayerPayload type=$type", async (type) => {
    await poly.relayerPayload(type);
    expect(calls[0].url).toContain("/relay-payload?");
    expect(calls[0].url).toContain(`type=${type}`);
  });

  it("relayerTxs sends RELAYER_API_KEY headers", async () => {
    await poly.relayerTxs();
    expect(calls[0].headers).toMatchObject({
      RELAYER_API_KEY: "test-key",
      RELAYER_API_KEY_ADDRESS: "0x4444444444444444444444444444444444444444",
    });
  });
});

describe("samplingMarkets — server ignores limit, client slices", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({ token_id: `t${i}` })),
        count: 100,
        limit: 1000,
      }),
    } as any)));
  });

  it.each([1, 5, 10, 25, 50])("slices to N=$n", async (n) => {
    const r = await poly.samplingMarkets(n);
    expect(r.data.length).toBe(n);
    expect(r.limit).toBe(n);
  });
});
