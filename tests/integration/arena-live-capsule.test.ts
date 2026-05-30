/**
 * Live-capsule bridge tests — DB-level binding lookup + refresh.
 * Router integration is exercised by the lifecycle test; here we focus on
 * the helpers that ride on top of the existing capsule store.
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

async function seed(): Promise<{ paperAgentId: number; capsuleId: string }> {
  const { db } = await import("@/lib/db/client");
  const handle = db();
  handle.prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, cash_usd_start, cash_usd_current, peak_equity_usd, realized_pnl_usd, unrealized_pnl_usd)
     VALUES ('test-agent', 0, ?, 1000, 1100, 1100, 50, 50)`,
  ).run(JSON.stringify({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 25 } }));
  const paperAgentId = (handle.prepare(`SELECT id FROM paper_agents WHERE name = 'test-agent'`).get() as { id: number }).id;
  const capsuleId = "test-cap-uuid-1";
  handle.prepare(
    `INSERT INTO capsules (id, name, status, paper_agent_id, capital_allocated_usd, capital_available_usd,
                           max_daily_loss_usd, max_total_drawdown_usd, max_position_pct, max_open_positions,
                           max_trades_per_day, allowed_venues_json, min_seconds_between_trades)
     VALUES (?, 'test-cap', 'live', ?, 100, 100, 10, 30, 0.5, 3, 20, '["coinbase","polymarket"]', 0)`,
  ).run(capsuleId, paperAgentId);
  return { paperAgentId, capsuleId };
}

describe("findLiveCapsuleForPaperAgent", () => {
  it("returns the capsule when bound and status=live", async () => {
    const { paperAgentId, capsuleId } = await seed();
    const { findLiveCapsuleForPaperAgent } = await import("@/lib/arena/live-capsule");
    const bind = findLiveCapsuleForPaperAgent(paperAgentId);
    expect(bind).toBeDefined();
    expect(bind!.id).toBe(capsuleId);
    expect(bind!.paper_agent_id).toBe(paperAgentId);
    expect(bind!.status).toBe("live");
  });

  it("returns undefined when capsule status is not 'live'", async () => {
    const { paperAgentId, capsuleId } = await seed();
    const { db } = await import("@/lib/db/client");
    db().prepare(`UPDATE capsules SET status = 'paper' WHERE id = ?`).run(capsuleId);
    const { findLiveCapsuleForPaperAgent } = await import("@/lib/arena/live-capsule");
    expect(findLiveCapsuleForPaperAgent(paperAgentId)).toBeUndefined();
  });

  it("returns undefined for an unbound paper agent", async () => {
    const { db } = await import("@/lib/db/client");
    db().prepare(`INSERT INTO paper_agents (name, generation, genome_json) VALUES ('orphan', 0, ?)`).run(JSON.stringify({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 25 } }));
    const id = (db().prepare(`SELECT id FROM paper_agents WHERE name='orphan'`).get() as { id: number }).id;
    const { findLiveCapsuleForPaperAgent } = await import("@/lib/arena/live-capsule");
    expect(findLiveCapsuleForPaperAgent(id)).toBeUndefined();
  });
});

describe("routeArenaSignal — non-entry early-outs", () => {
  it("returns NO_SIGNAL for a 'hold' signal without touching the router", async () => {
    const { paperAgentId, capsuleId } = await seed();
    const { findLiveCapsuleForPaperAgent, routeArenaSignal } = await import("@/lib/arena/live-capsule");
    const cap = findLiveCapsuleForPaperAgent(paperAgentId)!;
    const result = await routeArenaSignal({ kind: "hold" } as any, cap, paperAgentId, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_SIGNAL");
  });

  it("rejects an 'exit' signal without a passed position", async () => {
    const { paperAgentId } = await seed();
    const { findLiveCapsuleForPaperAgent, routeArenaSignal } = await import("@/lib/arena/live-capsule");
    const cap = findLiveCapsuleForPaperAgent(paperAgentId)!;
    const result = await routeArenaSignal(
      { kind: "exit", venue: "sim-coinbase", market_id: "BTC-USD", rationale: "test exit" },
      cap, paperAgentId, 60000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_POSITION");
  });

  it("accepts a Polymarket ENTRY (v2 — single-side MARKET supported)", async () => {
    const { paperAgentId } = await seed();
    const { supportsLiveRouting } = await import("@/lib/arena/live-capsule");
    const sig = { kind: "entry" as const, venue: "sim-poly" as const, market_id: "tok-1", side: "BUY" as const, size_usd: 10, rationale: "test" };
    expect(supportsLiveRouting(sig)).toBe(true);
    // Note: not invoking routeArenaSignal here because the test seed doesn't
    // configure a fake Polymarket adapter; the router would call into the real
    // CLOB execute path and (without ALLOW_TRADE) DRY_RUN-log it. The unit
    // covering that flow lives in the polymarket-adapter integration test.
  });

  it("rejects a Polymarket EXIT with NO_LIVE_TOKEN when position lacks live data (paper-only)", async () => {
    const { paperAgentId } = await seed();
    const { findLiveCapsuleForPaperAgent, routeArenaSignal, supportsLiveRouting } = await import("@/lib/arena/live-capsule");
    const cap = findLiveCapsuleForPaperAgent(paperAgentId)!;
    const sig = { kind: "exit" as const, venue: "sim-poly" as const, market_id: "tok-1", rationale: "test" };
    // supportsLiveRouting now allows sim-poly exits *attempt* (the per-position
    // gate runs inside routeArenaSignal once it can inspect live_token_id).
    expect(supportsLiveRouting(sig)).toBe(true);
    // Paper-only position has no live_token_id → router refuses.
    const position = {
      venue: "sim-poly" as const, market_id: "tok-1", side: "BUY" as const,
      size_usd: 10, entry_price: 0.5, opened_at: new Date().toISOString(),
    };
    const result = await routeArenaSignal(sig, cap, paperAgentId, 0.5, position);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_LIVE_TOKEN");
  });
});

describe("refreshCapsuleRealtime", () => {
  it("writes lifetime PnL into capsules.current_pnl_usd", async () => {
    const { paperAgentId, capsuleId } = await seed();
    const { refreshCapsuleRealtime } = await import("@/lib/arena/live-capsule");
    refreshCapsuleRealtime(capsuleId, paperAgentId);
    const { db } = await import("@/lib/db/client");
    const cap = db().prepare(`SELECT current_pnl_usd FROM capsules WHERE id = ?`).get(capsuleId) as { current_pnl_usd: number };
    // Agent has realized=50 + unrealized=50 = $100 PnL
    expect(cap.current_pnl_usd).toBeCloseTo(100, 6);
  });
});
