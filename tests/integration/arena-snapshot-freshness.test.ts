/**
 * Tests for the live-data freshness helper used by /safety + /api/arena/freshness.
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

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

describe("getMarketFreshness", () => {
  it("returns empty list when there are no snapshots in the last day", async () => {
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    expect(getMarketFreshness()).toEqual([]);
  });

  it("reports a Polymarket market with age ~0 when snapshot is fresh", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(
      `INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, captured_at)
       VALUES ('cond-x', 'tok-fresh', 'q', 0.5, datetime('now'))`,
    ).run();
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    const fresh = getMarketFreshness({ staleSeconds: 60 });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].venue).toBe("polymarket");
    expect(fresh[0].market_id).toBe("tok-fresh");
    expect(fresh[0].age_seconds).toBeLessThan(10);
    expect(fresh[0].is_stale).toBe(false);
  });

  it("flags is_stale=true when age exceeds the threshold", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(
      `INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at)
       VALUES ('BTC-USD', 60000, datetime('now', '-2 hours'))`,
    ).run();
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    const fresh = getMarketFreshness({ staleSeconds: 600 });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].venue).toBe("coinbase");
    expect(fresh[0].is_stale).toBe(true);
    expect(fresh[0].age_seconds).toBeGreaterThan(600);
  });

  it("picks the MAX captured_at per market (not arbitrary row)", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(
      `INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('ETH-USD', 3000, datetime('now', '-1 hour'))`,
    ).run();
    db().prepare(
      `INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('ETH-USD', 3050, datetime('now', '-5 minutes'))`,
    ).run();
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    const fresh = getMarketFreshness({ staleSeconds: 600 });
    const eth = fresh.find((f) => f.market_id === "ETH-USD")!;
    expect(eth.age_seconds).toBeLessThan(360); // 5min + small slack
  });

  it("sorts results by age ascending (freshest first)", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(`INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('A', 1, datetime('now', '-1 hour'))`).run();
    db().prepare(`INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('B', 1, datetime('now', '-10 minutes'))`).run();
    db().prepare(`INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('C', 1, datetime('now'))`).run();
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    const fresh = getMarketFreshness();
    expect(fresh.map((f) => f.market_id)).toEqual(["C", "B", "A"]);
  });

  it("ignores rows older than 1 day", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(
      `INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES ('OLD', 1, datetime('now', '-2 days'))`,
    ).run();
    const { getMarketFreshness } = await import("@/lib/arena/snapshot");
    expect(getMarketFreshness()).toEqual([]);
  });
});
