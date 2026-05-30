/**
 * Snapshot worker should pick the Gamma /events?tag_slug=<tag> endpoint
 * when ARENA_POLY_TAGS is set, and fall back to samplingMarkets otherwise.
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

// Mock both clients so we can assert which endpoint was hit.
const polyCalls: string[] = [];
const cbCalls: string[] = [];
vi.mock("@/lib/polymarket/client", () => ({
  poly: {
    samplingMarkets: vi.fn(async (limit: number) => {
      polyCalls.push(`sampling(${limit})`);
      return {
        data: [
          { condition_id: "samp-1", question: "Sampling Q1", tokens: [{ token_id: "tok-s1", outcome: "Yes" }, { token_id: "tok-s1-n", outcome: "No" }] },
        ],
      };
    }),
    events: vi.fn(async (opts: { tag_slug?: string; limit?: number }) => {
      polyCalls.push(`events(tag=${opts.tag_slug},limit=${opts.limit})`);
      return [{
        id: 1,
        title: "Crypto event",
        markets: [
          { conditionId: "cond-crypto-1", question: "Will BTC > $100k?", clobTokenIds: '["tok-c1","tok-c1-n"]', volume24hr: 50000 },
        ],
      }];
    }),
    midpoint: vi.fn(async () => ({ mid: "0.55" })),
    spread: vi.fn(async () => ({ spread: "0.02" })),
  },
}));
vi.mock("@/lib/coinbase/client", () => ({
  cb: {
    getBestBidAsk: vi.fn(async () => { cbCalls.push("bba"); return { pricebooks: [] }; }),
    publicGetProduct: vi.fn(async (pid: string) => { cbCalls.push(`prod(${pid})`); return { price: "60000" }; }),
    publicGetProductCandles: vi.fn(async () => ({ candles: [] })),
  },
}));

beforeEach(() => {
  memDb?.close(); memDb = null;
  polyCalls.length = 0; cbCalls.length = 0;
  delete process.env.ARENA_POLY_TAGS;
  // These tests focus on the main poly snapshot path (sampling vs events-by-tag).
  // Disable the short-binary fetcher, which calls events?tag_slug=5M
  // unconditionally and would otherwise pollute polyCalls.
  process.env.ARENA_SHORT_BINARIES = "0";
});
afterEach(() => {
  memDb?.close(); memDb = null;
  delete process.env.ARENA_POLY_TAGS;
  delete process.env.ARENA_SHORT_BINARIES;
});

describe("runSnapshotPass — crypto-only mode", () => {
  it("calls samplingMarkets when ARENA_POLY_TAGS is unset (default)", async () => {
    const { runSnapshotPass } = await import("@/lib/arena/snapshot");
    const r = await runSnapshotPass({ cbProducts: ["BTC-USD"] });
    expect(polyCalls.some((c) => c.startsWith("sampling"))).toBe(true);
    expect(polyCalls.some((c) => c.startsWith("events"))).toBe(false);
    expect(r.poly_count).toBeGreaterThanOrEqual(1);
  });

  it("calls events(tag_slug='crypto') when ARENA_POLY_TAGS=crypto", async () => {
    process.env.ARENA_POLY_TAGS = "crypto";
    const { runSnapshotPass } = await import("@/lib/arena/snapshot");
    const r = await runSnapshotPass({ cbProducts: ["BTC-USD"] });
    expect(polyCalls.some((c) => c.startsWith("events(tag=crypto"))).toBe(true);
    expect(polyCalls.some((c) => c.startsWith("sampling"))).toBe(false);
    expect(r.poly_count).toBe(1);
  });

  it("explicit polyTags overrides env var", async () => {
    process.env.ARENA_POLY_TAGS = "politics";
    const { runSnapshotPass } = await import("@/lib/arena/snapshot");
    await runSnapshotPass({ cbProducts: ["BTC-USD"], polyTags: ["crypto"] });
    expect(polyCalls.some((c) => c.includes("tag=crypto"))).toBe(true);
    expect(polyCalls.some((c) => c.includes("tag=politics"))).toBe(false);
  });

  it("dedupes condition_ids across multiple tag results", async () => {
    process.env.ARENA_POLY_TAGS = "crypto,defi";
    const { runSnapshotPass } = await import("@/lib/arena/snapshot");
    const r = await runSnapshotPass({ cbProducts: ["BTC-USD"] });
    // The mocked events always returns cond-crypto-1 — even with 2 tag queries, only 1 snapshot
    expect(r.poly_count).toBe(1);
  });
});
