/**
 * loadRecentCandlesFromCoindesk — non-Coinbase candle reader.
 *
 * Verifies:
 *   - filters by market + instrument
 *   - returns oldest-first
 *   - respects cutoffUnix (excludes candles after the cutoff)
 *   - respects lookbackMin (excludes candles too old)
 *   - returns empty when no rows match
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

beforeEach(() => { memDb?.close(); memDb = null; });

async function seedOkx(instId: string, tsUnix: number, close: number) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT OR IGNORE INTO coindesk_candles (market, instrument, granularity, start_unix, open, high, low, close, volume, quote_volume, total_trades)
     VALUES ('okx', ?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0, NULL, NULL)`,
  ).run(instId, tsUnix, close, close, close, close);
}

async function seedCoinDesk(instId: string, tsUnix: number, close: number) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT OR IGNORE INTO coindesk_candles (market, instrument, granularity, start_unix, open, high, low, close, volume, quote_volume, total_trades)
     VALUES ('coinbase', ?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0, NULL, NULL)`,
  ).run(instId, tsUnix, close, close, close, close);
}

describe("loadRecentCandlesFromCoindesk", () => {
  it("returns oldest-first, filtered by market + instrument", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await seedOkx("BNB-USDT", now - i * 60, 660 + i);
    }
    const { loadRecentCandlesFromCoindesk } = await import("@/lib/arena/momentum");
    const c = loadRecentCandlesFromCoindesk("okx", "BNB-USDT", 10, { cutoffUnix: now });
    expect(c).toHaveLength(5);
    // Oldest-first: ts_unix ascending
    for (let i = 1; i < c.length; i++) expect(c[i].start_unix).toBeGreaterThan(c[i - 1].start_unix);
  });

  it("excludes other markets and instruments", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedOkx("BNB-USDT", now - 60, 660);
    await seedOkx("HYPE-USDT", now - 60, 25);
    await seedCoinDesk("BNB-USDT", now - 60, 660);

    const { loadRecentCandlesFromCoindesk } = await import("@/lib/arena/momentum");
    const c = loadRecentCandlesFromCoindesk("okx", "BNB-USDT", 10, { cutoffUnix: now });
    expect(c).toHaveLength(1);
    expect(c[0].close).toBe(660);
  });

  it("respects cutoffUnix (excludes candles after cutoff)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedOkx("BNB-USDT", now - 300, 660);   // 5 min ago
    await seedOkx("BNB-USDT", now - 60, 661);    // 1 min ago
    await seedOkx("BNB-USDT", now + 60, 662);    // 1 min in the future

    const { loadRecentCandlesFromCoindesk } = await import("@/lib/arena/momentum");
    // cutoff = now → exclude future bar
    const c = loadRecentCandlesFromCoindesk("okx", "BNB-USDT", 10, { cutoffUnix: now });
    expect(c).toHaveLength(2);
    expect(c[c.length - 1].close).toBe(661);
  });

  it("respects lookbackMin (excludes candles too old)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedOkx("BNB-USDT", now - 600, 660);   // 10 min ago
    await seedOkx("BNB-USDT", now - 60, 661);    // 1 min ago

    const { loadRecentCandlesFromCoindesk } = await import("@/lib/arena/momentum");
    const c = loadRecentCandlesFromCoindesk("okx", "BNB-USDT", 5, { cutoffUnix: now });
    expect(c).toHaveLength(1);
    expect(c[0].close).toBe(661);
  });

  it("returns empty when no rows match", async () => {
    const { loadRecentCandlesFromCoindesk } = await import("@/lib/arena/momentum");
    const c = loadRecentCandlesFromCoindesk("okx", "BNB-USDT", 10);
    expect(c).toHaveLength(0);
  });
});
