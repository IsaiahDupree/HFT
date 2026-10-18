/**
 * loadRecentCandles unions live coinbase_candles + historical coindesk_candles.
 * Conflict resolution: when both tables have a bar at the same start_unix,
 * the Coinbase row wins (it's our trading-venue truth source).
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

const NOW = 1_780_000_000; // fixed cutoff for deterministic tests

function insertCb(h: ReturnType<typeof makeMemoryDb>, t: number, close: number) {
  h.prepare(
    `INSERT INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES ('BTC-USD', 'ONE_MINUTE', ?, ?, ?, ?, ?, 0)`,
  ).run(t, close, close, close, close);
}
function insertCd(h: ReturnType<typeof makeMemoryDb>, t: number, close: number) {
  h.prepare(
    `INSERT INTO coindesk_candles (market, instrument, granularity, start_unix, open, high, low, close, volume)
     VALUES ('coinbase', 'BTC-USD', 'ONE_MINUTE', ?, ?, ?, ?, ?, 0)`,
  ).run(t, close, close, close, close);
}

describe("loadRecentCandles — union of coinbase_candles + coindesk_candles", () => {
  it("returns only coinbase rows when coindesk table is empty", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    for (let i = 5; i >= 0; i--) insertCb(h, NOW - i * 60, 100 + i);
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 10, { cutoffUnix: NOW });
    expect(candles).toHaveLength(6);
    expect(candles.map((c) => c.close)).toEqual([105, 104, 103, 102, 101, 100]);
  });

  it("returns only coindesk rows when coinbase table is empty", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    for (let i = 5; i >= 0; i--) insertCd(h, NOW - i * 60, 200 + i);
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 10, { cutoffUnix: NOW });
    expect(candles).toHaveLength(6);
    expect(candles[0].close).toBe(205);
    expect(candles[5].close).toBe(200);
  });

  it("merges disjoint timestamps from both tables, sorted ascending", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    // CoinDesk fills older 6-10 min ago, Coinbase fills 0-4 min ago.
    insertCd(h, NOW - 600, 100);
    insertCd(h, NOW - 540, 101);
    insertCd(h, NOW - 480, 102);
    insertCb(h, NOW - 240, 110);
    insertCb(h, NOW - 180, 111);
    insertCb(h, NOW - 120, 112);
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 15, { cutoffUnix: NOW });
    expect(candles).toHaveLength(6);
    expect(candles.map((c) => c.start_unix)).toEqual([NOW - 600, NOW - 540, NOW - 480, NOW - 240, NOW - 180, NOW - 120]);
  });

  it("Coinbase wins on overlap (same start_unix in both tables)", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    insertCd(h, NOW - 120, 999);   // CoinDesk says 999
    insertCb(h, NOW - 120, 100);   // Coinbase says 100 — should win
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 5, { cutoffUnix: NOW });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(100);
  });

  it("opts.unionHistorical = false skips coindesk lookup entirely", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    insertCd(h, NOW - 120, 999);   // would otherwise show
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    expect(loadRecentCandles("BTC-USD", 5, { cutoffUnix: NOW, unionHistorical: false })).toHaveLength(0);
    expect(loadRecentCandles("BTC-USD", 5, { cutoffUnix: NOW })).toHaveLength(1);  // default = union
  });

  it("respects lookbackMin window — older rows excluded", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    insertCd(h, NOW - 7200, 1);   // 2h old, outside 30-min window
    insertCb(h, NOW - 60, 2);     // 1min old, inside
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 30, { cutoffUnix: NOW });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(2);
  });

  it("respects cutoffUnix — bars at or before cutoff included, future excluded", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    insertCb(h, NOW - 60, 1);
    insertCb(h, NOW + 60, 2);   // future relative to cutoff
    const { loadRecentCandles } = await import("@/lib/arena/momentum");
    const candles = loadRecentCandles("BTC-USD", 5, { cutoffUnix: NOW });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(1);
  });
});
