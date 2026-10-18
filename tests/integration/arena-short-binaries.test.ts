/**
 * short-binaries module tests.
 *
 * Covers:
 *   - parseAssetFromTitle for all 7 supported assets + UNKNOWN
 *   - assetToFeed / assetToCbProduct mapping
 *   - upsertBinary + getBinaryMeta round-trip + idempotency
 *   - fetchShortBinaries against a mocked Gamma response (mid lookup
 *     succeeds; YES token snapshot recorded; metadata persisted; running
 *     twice doesn't duplicate rows)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

// Mock the polymarket client BEFORE module-importing short-binaries.
const polyEventsCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/polymarket/client", () => ({
  poly: {
    events: vi.fn(async (opts: Record<string, unknown>) => {
      polyEventsCalls.push(opts);
      // Return one event per asset for the 5M tag.
      return [
        {
          id: 1, title: "Bitcoin Up or Down - May 26, 12:00PM ET",
          slug: "btc-updown-5m-1779871200", endDate: "2026-05-26T16:00:00Z",
          startDate: "2026-05-26T15:55:00Z",
          markets: [{
            conditionId: "cond-btc",
            question: "Bitcoin Up or Down - May 26, 12:00PM ET",
            clobTokenIds: JSON.stringify(["btc-yes-tok", "btc-no-tok"]),
            volume24hr: 100, openInterest: 50, liquidity: 1000,
          }],
        },
        {
          id: 2, title: "Ethereum Up or Down - May 26, 12:00PM ET",
          slug: "eth-updown-5m-1779871200", endDate: "2026-05-26T16:00:00Z",
          startDate: "2026-05-26T15:55:00Z",
          markets: [{
            conditionId: "cond-eth",
            question: "Ethereum Up or Down - May 26, 12:00PM ET",
            clobTokenIds: JSON.stringify(["eth-yes-tok", "eth-no-tok"]),
          }],
        },
        {
          id: 3, title: "Some random market with no asset",
          slug: "rand", endDate: "2026-05-26T16:00:00Z",
          startDate: "2026-05-26T15:55:00Z",
          markets: [{
            conditionId: "cond-rand",
            question: "Random",
            clobTokenIds: JSON.stringify(["rand-yes-tok", "rand-no-tok"]),
          }],
        },
      ];
    }),
    midpoint: vi.fn(async (tokenId: string) => ({
      mid: tokenId.startsWith("btc") ? "0.55" : tokenId.startsWith("eth") ? "0.48" : "0.5",
    })),
    spread: vi.fn(async () => ({ spread: "0.02" })),
  },
}));

beforeEach(() => {
  memDb?.close(); memDb = null;
  polyEventsCalls.length = 0;
});

describe("parseAssetFromTitle", () => {
  it("identifies all 7 supported assets", async () => {
    const { parseAssetFromTitle } = await import("@/lib/arena/short-binaries");
    expect(parseAssetFromTitle("Bitcoin Up or Down - …")).toBe("BTC");
    expect(parseAssetFromTitle("Ethereum Up or Down - …")).toBe("ETH");
    expect(parseAssetFromTitle("Solana Up or Down - …")).toBe("SOL");
    expect(parseAssetFromTitle("XRP Up or Down - …")).toBe("XRP");
    expect(parseAssetFromTitle("Dogecoin Up or Down - …")).toBe("DOGE");
    expect(parseAssetFromTitle("BNB Up or Down - …")).toBe("BNB");
    expect(parseAssetFromTitle("Hyperliquid Up or Down - …")).toBe("HYPE");
  });

  it("falls back to UNKNOWN for unrelated titles", async () => {
    const { parseAssetFromTitle } = await import("@/lib/arena/short-binaries");
    expect(parseAssetFromTitle("Will Hyperliquid airdrop by Sep 30?")).toBe("HYPE"); // fuzzy
    expect(parseAssetFromTitle("Some random thing")).toBe("UNKNOWN");
    expect(parseAssetFromTitle("")).toBe("UNKNOWN");
  });

  it("is case-insensitive", async () => {
    const { parseAssetFromTitle } = await import("@/lib/arena/short-binaries");
    expect(parseAssetFromTitle("BITCOIN UP OR DOWN")).toBe("BTC");
    expect(parseAssetFromTitle("bitcoin up or down")).toBe("BTC");
  });
});

describe("assetToFeed / assetToCbProduct", () => {
  it("maps Coinbase-listed assets to coinbase", async () => {
    const { assetToFeed } = await import("@/lib/arena/short-binaries");
    expect(assetToFeed("BTC")).toEqual({ exchange: "coinbase", instrument: "BTC-USD" });
    expect(assetToFeed("ETH")).toEqual({ exchange: "coinbase", instrument: "ETH-USD" });
    expect(assetToFeed("SOL")).toEqual({ exchange: "coinbase", instrument: "SOL-USD" });
    expect(assetToFeed("XRP")).toEqual({ exchange: "coinbase", instrument: "XRP-USD" });
    expect(assetToFeed("DOGE")).toEqual({ exchange: "coinbase", instrument: "DOGE-USD" });
  });
  it("maps BNB and HYPE to OKX", async () => {
    const { assetToFeed } = await import("@/lib/arena/short-binaries");
    expect(assetToFeed("BNB")).toEqual({ exchange: "okx", instrument: "BNB-USDT" });
    expect(assetToFeed("HYPE")).toEqual({ exchange: "okx", instrument: "HYPE-USDT" });
  });
  it("returns null for UNKNOWN", async () => {
    const { assetToFeed } = await import("@/lib/arena/short-binaries");
    expect(assetToFeed("UNKNOWN")).toBeNull();
  });
  it("assetToCbProduct returns null for OKX-only assets", async () => {
    const { assetToCbProduct } = await import("@/lib/arena/short-binaries");
    expect(assetToCbProduct("BTC")).toBe("BTC-USD");
    expect(assetToCbProduct("BNB")).toBeNull();
    expect(assetToCbProduct("HYPE")).toBeNull();
  });
});

describe("upsertBinary + getBinaryMeta", () => {
  it("inserts and reads back", async () => {
    const { upsertBinary, getBinaryMeta } = await import("@/lib/arena/short-binaries");
    upsertBinary({
      token_id: "tok-1", condition_id: "cond-1", no_token_id: "tok-1-no",
      question: "BTC?", asset: "BTC", duration_kind: "5M",
      expiry_iso: "2026-05-26T16:00:00Z",
    });
    const m = getBinaryMeta("tok-1");
    expect(m).not.toBeNull();
    expect(m?.asset).toBe("BTC");
    expect(m?.no_token_id).toBe("tok-1-no");
    expect(m?.settled).toBe(0);
  });
  it("ON CONFLICT updates question/expiry without duplicating rows", async () => {
    const { upsertBinary, getBinaryMeta } = await import("@/lib/arena/short-binaries");
    upsertBinary({
      token_id: "tok-2", condition_id: "cond-2",
      question: "q1", asset: "ETH", duration_kind: "5M",
      expiry_iso: "2026-05-26T16:00:00Z",
    });
    upsertBinary({
      token_id: "tok-2", condition_id: "cond-2",
      question: "q2-updated", asset: "ETH", duration_kind: "5M",
      expiry_iso: "2026-05-26T16:05:00Z",
    });
    const { db } = await import("@/lib/db/client");
    const n = (db().prepare("SELECT COUNT(*) AS c FROM poly_binaries WHERE token_id='tok-2'").get() as { c: number }).c;
    expect(n).toBe(1);
    const m = getBinaryMeta("tok-2");
    expect(m?.question).toBe("q2-updated");
    expect(m?.expiry_iso).toBe("2026-05-26T16:05:00Z");
  });
  it("returns null for unknown token_id", async () => {
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    expect(getBinaryMeta("nonexistent")).toBeNull();
  });
});

describe("fetchShortBinaries", () => {
  it("persists metadata and records snapshots", async () => {
    const { fetchShortBinaries } = await import("@/lib/arena/short-binaries");
    const r = await fetchShortBinaries({ tags: ["5M"] });
    expect(r.events_seen).toBe(3);
    expect(r.markets_recorded).toBe(3);   // all 3 events have midpoint
    expect(r.by_asset.BTC).toBe(1);
    expect(r.by_asset.ETH).toBe(1);
    expect(r.by_asset.UNKNOWN).toBe(1);

    const { db } = await import("@/lib/db/client");
    const meta = db().prepare("SELECT * FROM poly_binaries WHERE token_id='btc-yes-tok'").get() as any;
    expect(meta.asset).toBe("BTC");
    expect(meta.no_token_id).toBe("btc-no-tok");

    const snap = db().prepare("SELECT * FROM market_snapshots WHERE token_id='btc-yes-tok'").get() as any;
    expect(snap.category).toBe("5min-binary");
    expect(snap.midpoint).toBe(0.55);
  });

  it("respects assetFilter", async () => {
    const { fetchShortBinaries } = await import("@/lib/arena/short-binaries");
    const r = await fetchShortBinaries({ tags: ["5M"], assetFilter: ["BTC"] });
    expect(r.markets_recorded).toBe(1);
    expect(r.by_asset.BTC).toBe(1);
    expect(r.by_asset.ETH).toBeUndefined();
  });

  it("running twice does not duplicate metadata rows", async () => {
    const { fetchShortBinaries } = await import("@/lib/arena/short-binaries");
    await fetchShortBinaries({ tags: ["5M"] });
    await fetchShortBinaries({ tags: ["5M"] });
    const { db } = await import("@/lib/db/client");
    const n = (db().prepare("SELECT COUNT(*) AS c FROM poly_binaries").get() as { c: number }).c;
    expect(n).toBe(3); // not 6 — UPSERT keeps it bounded
  });

  it("passes end_date_min through to events()", async () => {
    const { fetchShortBinaries } = await import("@/lib/arena/short-binaries");
    await fetchShortBinaries({ tags: ["5M"] });
    expect(polyEventsCalls.length).toBe(1);
    expect(polyEventsCalls[0].tag_slug).toBe("5M");
    expect(polyEventsCalls[0].closed).toBe(false);
    expect(polyEventsCalls[0].end_date_min).toBeDefined();
  });
});
