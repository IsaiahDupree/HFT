/**
 * Binary resolver — live-aware settlement.
 *
 * Covers the new code path where a Position carries `live_token_id` +
 * `live_filled_shares` + `live_paid_usd` (set by the live router when
 * ALLOW_TRADE=1 fills are tracked). The resolver should compute PnL against
 * the ACTUAL filled token, not the genome's intended YES token.
 *
 * Two scenarios:
 *  - long YES, YES wins → +profit
 *  - SELL-YES swapped to long NO, NO wins → +profit (different math)
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

async function seedAgent(positions: any[]) {
  const { db } = await import("@/lib/db/client");
  const genome = JSON.stringify({
    kind: "poly_short_binary_directional",
    params: {
      assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001,
      pre_cutoff_min: 3, max_window_min: 6,
      max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3,
      entry_size_usd: 5, max_positions_per_asset: 1,
    },
  });
  const gen = db().prepare(`INSERT INTO paper_generations (gen_number) VALUES (1)`).run();
  void gen;
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
    meta.token_id, meta.condition_id, meta.no_token_id, meta.question,
    meta.asset, meta.duration_kind, meta.start_iso, meta.expiry_iso,
  );
}

async function seedCoinbaseCandle(productId: string, ts: number, close: number) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT OR IGNORE INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES (?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0)`,
  ).run(productId, ts, close, close, close, close);
}

describe("binary-resolver — live settlement", () => {
  it("settles a BUY-YES live position at the actual outcome", async () => {
    const tokenYes = "yes-token-btc";
    const tokenNo = "no-token-btc";
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);

    // BTC went UP: 70000 at window-start (12:00 - 5min = 11:55), 70500 at expiry.
    await seedCoinbaseCandle("BTC-USD", expiryUnix - 300, 70000);
    await seedCoinbaseCandle("BTC-USD", expiryUnix, 70500);

    await seedBinary({
      token_id: tokenYes, condition_id: "c1", no_token_id: tokenNo,
      question: "BTC up?", asset: "BTC", duration_kind: "5M",
      start_iso: "2026-05-26T11:55:00Z", expiry_iso: expiry,
    });

    const agentId = await seedAgent([{
      venue: "sim-poly", market_id: tokenYes, side: "BUY",
      size_usd: 5, entry_price: 0.45,
      opened_at: "2026-05-26T11:57:00Z",
      live_token_id: tokenYes,         // we hold YES tokens
      live_filled_shares: 5 / 0.45,    // 11.11 shares
      live_paid_usd: 5,
    }]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const meta = getBinaryMeta(tokenYes)!;
    const result = resolveBinary(meta, "2026-05-26T12:01:00Z");
    expect(result.status).toBe("settled");
    expect(result.outcome_yes).toBe(1);

    // Verify: paid $5 for 11.11 YES shares, YES wins → each pays $1 → $11.11
    // realized_pnl = 11.11 - 5 = $6.11
    const { db } = await import("@/lib/db/client");
    const a = db().prepare(`SELECT realized_pnl_usd, cash_usd_current FROM paper_agents WHERE id = ?`).get(agentId) as { realized_pnl_usd: number; cash_usd_current: number };
    expect(a.realized_pnl_usd).toBeCloseTo(6.111, 1);
    // cash before resolve = 95; cash after = 95 + paid + realized = 95 + 5 + 6.111 = 106.11
    expect(a.cash_usd_current).toBeCloseTo(106.11, 1);
  });

  it("settles a SELL-YES-swapped-to-BUY-NO live position at the NO outcome", async () => {
    const tokenYes = "yes-token-eth";
    const tokenNo = "no-token-eth";
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);

    // ETH went DOWN: 3000 → 2950. NO wins.
    await seedCoinbaseCandle("ETH-USD", expiryUnix - 300, 3000);
    await seedCoinbaseCandle("ETH-USD", expiryUnix, 2950);

    await seedBinary({
      token_id: tokenYes, condition_id: "c2", no_token_id: tokenNo,
      question: "ETH up?", asset: "ETH", duration_kind: "5M",
      start_iso: "2026-05-26T11:55:00Z", expiry_iso: expiry,
    });

    const agentId = await seedAgent([{
      venue: "sim-poly", market_id: tokenYes,       // intent recorded as YES
      side: "SELL", size_usd: 5, entry_price: 0.55, // arena thinks: shorted YES @ 0.55
      opened_at: "2026-05-26T11:57:00Z",
      live_token_id: tokenNo,         // ACTUAL fill: BUY NO (the swap)
      live_filled_shares: 5 / 0.45,   // bought NO @ (1 - 0.55) = 0.45 → 11.11 shares
      live_paid_usd: 5,
    }]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const meta = getBinaryMeta(tokenYes)!;
    const result = resolveBinary(meta, "2026-05-26T12:01:00Z");
    expect(result.status).toBe("settled");
    expect(result.outcome_yes).toBe(0);  // NO won

    // Verify: paid $5 for 11.11 NO shares, NO wins → each pays $1 → $11.11
    // realized = 11.11 - 5 = $6.11. Same as the YES-wins case (symmetric).
    const { db } = await import("@/lib/db/client");
    const a = db().prepare(`SELECT realized_pnl_usd FROM paper_agents WHERE id = ?`).get(agentId) as { realized_pnl_usd: number };
    expect(a.realized_pnl_usd).toBeCloseTo(6.111, 1);
  });

  it("settles a BUY-YES live position to LOSS when YES loses", async () => {
    const tokenYes = "yes-token-sol";
    const tokenNo = "no-token-sol";
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);

    // SOL went DOWN: 200 → 199. YES (BTC-up bet) loses.
    await seedCoinbaseCandle("SOL-USD", expiryUnix - 300, 200);
    await seedCoinbaseCandle("SOL-USD", expiryUnix, 199);

    await seedBinary({
      token_id: tokenYes, condition_id: "c3", no_token_id: tokenNo,
      question: "SOL up?", asset: "SOL", duration_kind: "5M",
      start_iso: "2026-05-26T11:55:00Z", expiry_iso: expiry,
    });

    const agentId = await seedAgent([{
      venue: "sim-poly", market_id: tokenYes, side: "BUY",
      size_usd: 5, entry_price: 0.55,
      opened_at: "2026-05-26T11:57:00Z",
      live_token_id: tokenYes, live_filled_shares: 5 / 0.55, live_paid_usd: 5,
    }]);

    const { resolveBinary } = await import("@/lib/arena/binary-resolver");
    const { getBinaryMeta } = await import("@/lib/arena/short-binaries");
    const meta = getBinaryMeta(tokenYes)!;
    const result = resolveBinary(meta, "2026-05-26T12:01:00Z");
    expect(result.outcome_yes).toBe(0);
    const { db } = await import("@/lib/db/client");
    const a = db().prepare(`SELECT realized_pnl_usd FROM paper_agents WHERE id = ?`).get(agentId) as { realized_pnl_usd: number };
    // Paid $5, lost all. realized = -$5.
    expect(a.realized_pnl_usd).toBeCloseTo(-5, 1);
  });
});
