/**
 * Polymarket fill reconciler — pure-logic unit tests.
 *
 * Covers:
 *   - aggregateFillsById indexes a trade under every present id field
 *   - aggregateFillsById sums shares + USD across partial fills
 *   - findMatchingFill prefers broker_order_id but falls back to client_order_id
 *   - reconcileFills writes shares + paid_usd onto the position
 *   - reconcileFills correctly counts matched / no_match summaries
 *   - Positions with confirmed live_filled_shares are skipped (idempotency)
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

async function seedAgent(name: string, positions: any[]) {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT OR IGNORE INTO paper_generations (gen_number) VALUES (1)`).run();
  const r = db().prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, introduced_by, cash_usd_start, cash_usd_current, peak_equity_usd, position_basket_json)
     VALUES (?, 1, '{}', 'test', 100, 100, 100, ?)`,
  ).run(name, JSON.stringify(positions));
  return Number(r.lastInsertRowid);
}

describe("aggregateFillsById", () => {
  it("indexes a trade under every present id field", async () => {
    const { aggregateFillsById } = await import("@/lib/arena/reconcile-polymarket");
    const trades = [{
      taker_order_id: "broker-1",
      client_order_id: "client-1",
      size: "10", price: "0.55", trade_id: "t1",
    }];
    const m = aggregateFillsById(trades);
    expect(m.get("broker-1")?.shares).toBe(10);
    expect(m.get("broker-1")?.usd).toBeCloseTo(5.5, 6);
    expect(m.get("client-1")?.shares).toBe(10);
  });

  it("sums shares + USD across partial fills", async () => {
    const { aggregateFillsById } = await import("@/lib/arena/reconcile-polymarket");
    const trades = [
      { taker_order_id: "broker-1", size: "5", price: "0.50", trade_id: "t1" },
      { taker_order_id: "broker-1", size: "5", price: "0.60", trade_id: "t2" },
    ];
    const m = aggregateFillsById(trades);
    expect(m.get("broker-1")?.shares).toBe(10);
    expect(m.get("broker-1")?.usd).toBeCloseTo(5.5, 6);   // 5*0.5 + 5*0.6
    expect(m.get("broker-1")?.trade_ids).toEqual(["t1", "t2"]);
  });

  it("rejects malformed rows (zero/NaN size or price)", async () => {
    const { aggregateFillsById } = await import("@/lib/arena/reconcile-polymarket");
    const trades = [
      { taker_order_id: "broker-1", size: "0", price: "0.5" },
      { taker_order_id: "broker-2", size: "10", price: "not-a-number" },
      { taker_order_id: "broker-3", size: "10", price: "0.5" },
    ];
    const m = aggregateFillsById(trades);
    expect(m.has("broker-1")).toBe(false);
    expect(m.has("broker-2")).toBe(false);
    expect(m.has("broker-3")).toBe(true);
  });
});

describe("findMatchingFill", () => {
  it("matches by broker_order_id when present", async () => {
    const { findMatchingFill } = await import("@/lib/arena/reconcile-polymarket");
    const fills = new Map([["broker-1", { shares: 10, usd: 5, trade_ids: [] }]]);
    const result = findMatchingFill(fills, {
      agentId: 1, agentName: "a", positionIdx: 0,
      brokerOrderId: "broker-1", clientOrderId: "client-1",
    });
    expect(result?.shares).toBe(10);
  });

  it("falls back to client_order_id when broker_order_id misses", async () => {
    const { findMatchingFill } = await import("@/lib/arena/reconcile-polymarket");
    const fills = new Map([["client-1", { shares: 10, usd: 5, trade_ids: [] }]]);
    const result = findMatchingFill(fills, {
      agentId: 1, agentName: "a", positionIdx: 0,
      brokerOrderId: "broker-unknown", clientOrderId: "client-1",
    });
    expect(result?.shares).toBe(10);
  });

  it("returns null when neither id matches", async () => {
    const { findMatchingFill } = await import("@/lib/arena/reconcile-polymarket");
    const fills = new Map([["other", { shares: 10, usd: 5, trade_ids: [] }]]);
    expect(findMatchingFill(fills, {
      agentId: 1, agentName: "a", positionIdx: 0,
      brokerOrderId: "broker-1", clientOrderId: "client-1",
    })).toBeNull();
  });
});

describe("reconcileFills", () => {
  it("writes shares + paid_usd onto matched positions", async () => {
    const agentId = await seedAgent("a1", [{
      venue: "sim-poly", market_id: "btc-yes", side: "BUY",
      size_usd: 5, entry_price: 0.5, opened_at: "2026-05-26T11:55:00Z",
      live_token_id: "btc-yes",
      live_broker_order_id: "broker-1",
      live_client_order_id: "client-1",
      // live_filled_shares: undefined → unreconciled
    }]);
    const { reconcileFills } = await import("@/lib/arena/reconcile-polymarket");
    const summary = reconcileFills([
      { taker_order_id: "broker-1", size: "10", price: "0.5", trade_id: "t1" },
    ]);
    expect(summary.unreconciled_count).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.no_match).toBe(0);

    const { db } = await import("@/lib/db/client");
    const row = db().prepare(`SELECT position_basket_json FROM paper_agents WHERE id = ?`).get(agentId) as { position_basket_json: string };
    const pos = JSON.parse(row.position_basket_json)[0];
    expect(pos.live_filled_shares).toBe(10);
    expect(pos.live_paid_usd).toBeCloseTo(5, 6);
  });

  it("matches via client_order_id when broker_order_id is absent from trades", async () => {
    const agentId = await seedAgent("a2", [{
      venue: "sim-poly", market_id: "eth-yes", side: "BUY",
      size_usd: 5, entry_price: 0.5, opened_at: "2026-05-26T11:55:00Z",
      live_broker_order_id: "broker-unknown",
      live_client_order_id: "arena-cap123-1-entry-abc",
    }]);
    const { reconcileFills } = await import("@/lib/arena/reconcile-polymarket");
    const summary = reconcileFills([
      // CLOB returns client_order_id but not the broker id we have on file.
      { client_order_id: "arena-cap123-1-entry-abc", size: "12", price: "0.5", trade_id: "t1" },
    ]);
    expect(summary.matched).toBe(1);
    expect(summary.written).toBe(1);

    const { db } = await import("@/lib/db/client");
    const row = db().prepare(`SELECT position_basket_json FROM paper_agents WHERE id = ?`).get(agentId) as { position_basket_json: string };
    expect(JSON.parse(row.position_basket_json)[0].live_filled_shares).toBe(12);
  });

  it("counts no_match when neither id is found in CLOB trades", async () => {
    await seedAgent("a3", [{
      venue: "sim-poly", market_id: "btc-yes", side: "BUY",
      size_usd: 5, entry_price: 0.5, opened_at: "now",
      live_broker_order_id: "broker-1",
    }]);
    const { reconcileFills } = await import("@/lib/arena/reconcile-polymarket");
    const summary = reconcileFills([
      { taker_order_id: "completely-different", size: "10", price: "0.5", trade_id: "t1" },
    ]);
    expect(summary.matched).toBe(0);
    expect(summary.no_match).toBe(1);
  });

  it("skips already-reconciled positions (idempotency)", async () => {
    await seedAgent("a4", [{
      venue: "sim-poly", market_id: "btc-yes", side: "BUY",
      size_usd: 5, entry_price: 0.5, opened_at: "now",
      live_broker_order_id: "broker-1",
      live_filled_shares: 10,        // already reconciled
      live_paid_usd: 5,
    }]);
    const { reconcileFills } = await import("@/lib/arena/reconcile-polymarket");
    const summary = reconcileFills([
      { taker_order_id: "broker-1", size: "999", price: "0.99", trade_id: "t1" },
    ]);
    // No unreconciled positions → matched/written stay 0.
    expect(summary.unreconciled_count).toBe(0);
    expect(summary.matched).toBe(0);
  });

  it("aggregates partial fills into a single position update", async () => {
    const agentId = await seedAgent("a5", [{
      venue: "sim-poly", market_id: "btc-yes", side: "BUY",
      size_usd: 5, entry_price: 0.5, opened_at: "now",
      live_broker_order_id: "broker-1",
    }]);
    const { reconcileFills } = await import("@/lib/arena/reconcile-polymarket");
    reconcileFills([
      { taker_order_id: "broker-1", size: "4", price: "0.50", trade_id: "t1" },
      { taker_order_id: "broker-1", size: "6", price: "0.55", trade_id: "t2" },
    ]);
    const { db } = await import("@/lib/db/client");
    const row = db().prepare(`SELECT position_basket_json FROM paper_agents WHERE id = ?`).get(agentId) as { position_basket_json: string };
    const pos = JSON.parse(row.position_basket_json)[0];
    expect(pos.live_filled_shares).toBe(10);
    expect(pos.live_paid_usd).toBeCloseTo(5.3, 6);  // 4*0.50 + 6*0.55
  });
});
