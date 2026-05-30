/**
 * Binary resolver — sim (paper-only) settlement + iteration.
 *
 * Complements binary-resolver-live.test.ts (which covers the live_token_id
 * branch). Here we exercise:
 *   - resolveBinary on a paper-only BUY position → settles at outcome
 *   - resolveBinary on a paper-only SELL position → sim "short" math
 *   - Missing candles → status="skipped_no_candles", binary remains unsettled
 *   - UNKNOWN asset → markBinaryUnresolvable (outcome_yes stays NULL, settled=1)
 *   - resolveExpiredBinaries iterates and aggregates by_status
 *   - Skips binaries whose expiry is still in the future
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

async function seedAgent(positions: any[]): Promise<number> {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT INTO paper_generations (gen_number) VALUES (1)`).run();
  const genome = JSON.stringify({
    kind: "poly_short_binary_directional",
    params: {
      assets: "BTC,ETH,SOL,XRP,DOGE,BNB,HYPE",
      vel_window_min: 3, vel_entry_pct: 0.001,
      pre_cutoff_min: 3, max_window_min: 6,
      max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3,
      entry_size_usd: 5, max_positions_per_asset: 1,
    },
  });
  const r = db().prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, introduced_by, cash_usd_start, cash_usd_current, peak_equity_usd, position_basket_json)
     VALUES (?, 1, ?, 'test', 100, 95, 100, ?)`,
  ).run("test-agent", genome, JSON.stringify(positions));
  return Number(r.lastInsertRowid);
}

async function seedBinary(meta: any) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, start_iso, expiry_iso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meta.token_id, meta.condition_id, meta.no_token_id ?? null, meta.question ?? "q",
    meta.asset, meta.duration_kind ?? "5M", meta.start_iso ?? null, meta.expiry_iso,
  );
}

async function seedCandle(productId: string, tsUnix: number, close: number) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT OR IGNORE INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES (?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0)`,
  ).run(productId, tsUnix, close, close, close, close);
}

describe("resolveBinary — sim positions", () => {
  it("BUY-YES sim position pays $5 → $11.11 on YES win (mirror of live path)", async () => {
    const tokenYes = "btc-yes-sim";
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    await seedCandle("BTC-USD", expiryUnix - 300, 70000);
    await seedCandle("BTC-USD", expiryUnix, 70500);
    await seedBinary({ token_id: tokenYes, condition_id: "c1", asset: "BTC", expiry_iso: expiry });
    const agentId = await seedAgent([{
      venue: "sim-poly", market_id: tokenYes, side: "BUY",
      size_usd: 5, entry_price: 0.45,
      opened_at: "2026-05-26T11:57:00Z",
      // NO live_token_id → sim path
    }]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const result = resolveBinary(getBinaryMeta(tokenYes)!, "2026-05-26T12:01:00Z");
    expect(result.status).toBe("settled");
    expect(result.outcome_yes).toBe(1);

    const { db } = await import("@/lib/db/client");
    const a = db().prepare(`SELECT realized_pnl_usd FROM paper_agents WHERE id = ?`).get(agentId) as { realized_pnl_usd: number };
    // shareRet = (1 - 0.45) / 0.45 = 1.222 → $5 * 1.222 = $6.11
    expect(a.realized_pnl_usd).toBeCloseTo(6.111, 1);
  });

  it("SELL-YES sim position uses bounded BUY-NO math on NO win", async () => {
    const tokenYes = "btc-yes-sim-sell";
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    await seedCandle("BTC-USD", expiryUnix - 300, 70000);
    await seedCandle("BTC-USD", expiryUnix, 69500);    // BTC down → NO wins
    await seedBinary({ token_id: tokenYes, condition_id: "c2", asset: "BTC", expiry_iso: expiry });
    const agentId = await seedAgent([{
      venue: "sim-poly", market_id: tokenYes, side: "SELL",
      size_usd: 5, entry_price: 0.55,
      opened_at: "2026-05-26T11:57:00Z",
    }]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const result = resolveBinary(getBinaryMeta(tokenYes)!, "2026-05-26T12:01:00Z");
    expect(result.outcome_yes).toBe(0);
    const { db } = await import("@/lib/db/client");
    const a = db().prepare(`SELECT realized_pnl_usd FROM paper_agents WHERE id = ?`).get(agentId) as { realized_pnl_usd: number };
    // SELL-YES = BUY-NO at $0.45. NO wins → 5/0.45 = 11.11 shares × $1 - $5 paid = $6.11.
    // Equivalent: shareRet = (entry - exit) / (1 - entry) = (0.55 - 0) / 0.45 = 1.222
    expect(a.realized_pnl_usd).toBeCloseTo(6.111, 2);
  });

  it("skipped_no_candles when neither start nor end candle exists", async () => {
    const tokenYes = "btc-yes-nocandles";
    const expiry = "2026-05-26T12:00:00Z";
    await seedBinary({ token_id: tokenYes, condition_id: "c3", asset: "BTC", expiry_iso: expiry });
    await seedAgent([]);  // no positions but need an agent in DB

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const result = resolveBinary(getBinaryMeta(tokenYes)!, "2026-05-26T12:01:00Z");
    expect(result.status).toBe("skipped_no_candles");

    // Binary should remain UNSETTLED so the next tick (when candles arrive) can retry.
    const m = getBinaryMeta(tokenYes);
    expect(m?.settled).toBe(0);
  });

  it("UNKNOWN asset → markBinaryUnresolvable (settled=1, outcome_yes=NULL)", async () => {
    const tokenYes = "unknown-yes";
    const expiry = "2026-05-26T12:00:00Z";
    await seedBinary({ token_id: tokenYes, condition_id: "c4", asset: "UNKNOWN", expiry_iso: expiry });
    await seedAgent([]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const result = resolveBinary(getBinaryMeta(tokenYes)!, "2026-05-26T12:01:00Z");
    expect(result.status).toBe("skipped_no_product");

    const m = getBinaryMeta(tokenYes);
    expect(m?.settled).toBe(1);
    expect(m?.outcome_yes).toBeNull();      // explicit: not a real NO
  });
});

describe("resolveExpiredBinaries", () => {
  it("iterates only expired-and-unsettled binaries", async () => {
    const expiredA = "2026-05-26T11:55:00Z";    // expired (past)
    const expiredB = "2026-05-26T11:50:00Z";    // expired (past)
    const future = "2026-05-26T13:00:00Z";       // future
    const expiredAUnix = Math.floor(new Date(expiredA).getTime() / 1000);
    const expiredBUnix = Math.floor(new Date(expiredB).getTime() / 1000);

    // BTC binary with candles → should settle
    await seedCandle("BTC-USD", expiredAUnix - 300, 70000);
    await seedCandle("BTC-USD", expiredAUnix, 70500);
    await seedBinary({ token_id: "expA", condition_id: "c-a", asset: "BTC", expiry_iso: expiredA });

    // ETH binary without candles → skipped_no_candles
    await seedBinary({ token_id: "expB", condition_id: "c-b", asset: "ETH", expiry_iso: expiredB });

    // Future binary — should NOT be touched
    await seedBinary({ token_id: "future", condition_id: "c-f", asset: "BTC", expiry_iso: future });

    await seedAgent([]);

    const { resolveExpiredBinaries } = await import("@/lib/arena/binary-resolver");
    const r = resolveExpiredBinaries("2026-05-26T12:00:00Z");
    expect(r.candidates).toBe(2);
    expect(r.settled).toBe(1);
    expect(r.by_status.settled).toBe(1);
    expect(r.by_status.skipped_no_candles).toBe(1);

    // Future binary still unsettled
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    expect(getBinaryMeta("future")?.settled).toBe(0);
  });

  it("returns zero counts when no binaries are expired", async () => {
    await seedBinary({ token_id: "future", condition_id: "c", asset: "BTC", expiry_iso: "2030-01-01T00:00:00Z" });
    await seedAgent([]);
    const { resolveExpiredBinaries } = await import("@/lib/arena/binary-resolver");
    const r = resolveExpiredBinaries("2026-05-26T12:00:00Z");
    expect(r.candidates).toBe(0);
    expect(r.settled).toBe(0);
    expect(r.positions_closed).toBe(0);
  });
});
