import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

// Swap the singleton db handle to a fresh in-memory one per test so writes
// don't leak between cases and we don't touch the prod DB.
let memDb: ReturnType<typeof makeMemoryDb>;
vi.mock("@/lib/db/client", () => ({
  db: () => memDb,
}));

beforeEach(() => { memDb = makeMemoryDb(); });
afterEach(() => { memDb.close(); });

describe("realtime-ticks: persist + read", () => {
  it("writes a tick for a known symbol", async () => {
    const { persistRealtimeTick, _resetDebounce } = await import("@/lib/arena/realtime-ticks");
    _resetDebounce();
    const ok = persistRealtimeTick("btcusdt", 67500, "test");
    expect(ok).toBe(true);
    const row = memDb.prepare("SELECT * FROM realtime_ticks").get() as { product_id: string; price: number };
    expect(row.product_id).toBe("BTC-USD");
    expect(row.price).toBe(67500);
  });

  it("debounces follow-up ticks within 1 second", async () => {
    const { persistRealtimeTick, _resetDebounce } = await import("@/lib/arena/realtime-ticks");
    _resetDebounce();
    expect(persistRealtimeTick("btcusdt", 67500, "test")).toBe(true);
    expect(persistRealtimeTick("btcusdt", 67510, "test")).toBe(false); // <1s after
    const count = (memDb.prepare("SELECT COUNT(*) AS n FROM realtime_ticks").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("rejects unknown symbols", async () => {
    const { persistRealtimeTick, _resetDebounce } = await import("@/lib/arena/realtime-ticks");
    _resetDebounce();
    expect(persistRealtimeTick("madeup-coin", 100, "test")).toBe(false);
  });

  it("rejects non-positive prices", async () => {
    const { persistRealtimeTick, _resetDebounce } = await import("@/lib/arena/realtime-ticks");
    _resetDebounce();
    expect(persistRealtimeTick("btcusdt", 0, "test")).toBe(false);
    expect(persistRealtimeTick("btcusdt", -5, "test")).toBe(false);
    expect(persistRealtimeTick("btcusdt", NaN, "test")).toBe(false);
  });

  it("latestRealtimeTicks returns per-product latest within maxAgeSec", async () => {
    const { latestRealtimeTicks } = await import("@/lib/arena/realtime-ticks");
    const nowUnix = Math.floor(Date.now() / 1000);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("btcusdt", "BTC-USD", 67000, "test", nowUnix - 10);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("btcusdt", "BTC-USD", 67200, "test", nowUnix - 2);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("ethusdt", "ETH-USD", 2110, "test", nowUnix - 500); // stale
    const map = latestRealtimeTicks(60);
    expect(map.size).toBe(1); // ETH excluded (stale)
    expect(map.get("BTC-USD")?.price).toBe(67200); // newest BTC kept
  });

  it("pruneOldTicks deletes rows older than keepHours", async () => {
    const { pruneOldTicks } = await import("@/lib/arena/realtime-ticks");
    const nowUnix = Math.floor(Date.now() / 1000);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("btcusdt", "BTC-USD", 67000, "test", nowUnix - 100); // fresh
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("btcusdt", "BTC-USD", 60000, "test", nowUnix - 26 * 3600); // 26h old
    const deleted = pruneOldTicks(24);
    expect(deleted).toBe(1);
    const remaining = (memDb.prepare("SELECT COUNT(*) AS n FROM realtime_ticks").get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it("wsHealth returns per-product latest with fresh flag", async () => {
    const { wsHealth } = await import("@/lib/arena/realtime-ticks");
    const nowUnix = Math.floor(Date.now() / 1000);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("btcusdt", "BTC-USD", 67000, "test", nowUnix - 5);
    memDb.prepare(`INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix) VALUES (?, ?, ?, ?, ?)`).run("ethusdt", "ETH-USD", 2110, "test", nowUnix - 200);
    const rows = wsHealth(60);
    expect(rows.length).toBe(2);
    const btc = rows.find((r) => r.product_id === "BTC-USD")!;
    const eth = rows.find((r) => r.product_id === "ETH-USD")!;
    expect(btc.fresh).toBe(true);
    expect(eth.fresh).toBe(false);
  });
});
