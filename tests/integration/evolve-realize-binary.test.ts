/**
 * Regression test for the force-close-binary bug (2026-05-26).
 *
 * The bug: realizeOpenPositions() at gen seal time was calling applySignal
 * with kind=exit on every open position, which closed at the snapshot mid
 * price. For binary positions whose mid never moves until expiry-settlement,
 * the close happened at the entry price — producing $0 PnL and ROBBING the
 * agent of the binary's resolution outcome.
 *
 * Audit on prod DB (post-fix discovery) showed 494 force-close trades with
 * 486 returning exactly $0 PnL — almost all phantom.
 *
 * The fix: detect binary positions, settle at the actual 0/1 outcome when
 * the binary is settled, skip otherwise (let the resolver pick them up).
 *
 * Tests cover:
 *   - Binary settled YES, BUY-YES position → wins, exits at $1
 *   - Binary settled NO, BUY-YES position → loses, exits at $0
 *   - Binary settled NO, SELL-YES position → wins, exits at $0 (full credit)
 *   - Binary unsettled → position stays open (not force-closed at mid)
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

async function setupBinary(opts: { tokenId: string; settled: 0 | 1; outcome: 0 | 1 | null }) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, start_iso, expiry_iso, settled, outcome_yes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.tokenId, "c-" + opts.tokenId, "no-" + opts.tokenId,
    "BTC up?", "BTC", "5M",
    "2026-05-26T11:55:00Z", "2026-05-26T12:00:00Z",
    opts.settled, opts.outcome,
  );
}

async function seedAgentWithPosition(opts: {
  name: string;
  tokenId: string;
  side: "BUY" | "SELL";
  entry_price: number;
  size_usd: number;
}): Promise<number> {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT OR IGNORE INTO paper_generations (gen_number) VALUES (1)`).run();
  const genome = JSON.stringify({
    kind: "poly_short_binary_directional",
    params: {
      assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001,
      pre_cutoff_min: 3, max_window_min: 6,
      max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3,
      entry_size_usd: 5, max_positions_per_asset: 1,
    },
  });
  const position = {
    venue: "sim-poly",
    market_id: opts.tokenId,
    side: opts.side,
    size_usd: opts.size_usd,
    entry_price: opts.entry_price,
    opened_at: "2026-05-26T11:57:00Z",
  };
  const r = db().prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, introduced_by,
       cash_usd_start, cash_usd_current, peak_equity_usd, position_basket_json,
       entries_count)
     VALUES (?, 1, ?, 'test', 100, ?, 100, ?, 1)`,
  ).run(opts.name, genome, 100 - opts.size_usd, JSON.stringify([position]));
  return Number(r.lastInsertRowid);
}

// Helper to call runEvolveOnce indirectly — easier: just call the internal
// realize helper by triggering the seal path. We test through the exported
// runEvolveOnce since realizeOpenPositions is module-internal.
async function runEvolveAndGetAgentState(agentId: number): Promise<{ realized_pnl_usd: number; cash_usd_current: number; trades_count: number; wins_count: number; positions: any[] }> {
  // Stub dependencies that evolve calls but we don't care about
  vi.doMock("@/lib/arena/context", () => ({
    buildLiveTickContext: () => ({ now: new Date().toISOString(), snapshots: new Map() }),
  }));
  vi.doMock("@/lib/arena/mutate", () => ({
    mutate: async (g: any) => g, mutateProgrammatic: async (g: any) => g, mutateLlm: async (g: any) => g,
  }));
  vi.doMock("@/lib/arena/replay-fitness", () => ({ computeReplayFitness: () => ({ trades_count: 1 }) }));
  vi.doMock("@/lib/arena/auto-promote", () => ({ runAutoPromote: () => ({ skipped: "test" }) }));

  const { runEvolveOnce } = await import("@/lib/arena/evolve");
  await runEvolveOnce({ eliteCount: 0, survivalPct: 0.5 });

  const { db } = await import("@/lib/db/client");
  const a = db().prepare(`SELECT realized_pnl_usd, cash_usd_current, trades_count, wins_count, position_basket_json FROM paper_agents WHERE id = ?`).get(agentId) as any;
  return {
    realized_pnl_usd: a.realized_pnl_usd,
    cash_usd_current: a.cash_usd_current,
    trades_count: a.trades_count,
    wins_count: a.wins_count,
    positions: JSON.parse(a.position_basket_json),
  };
}

describe("realizeOpenPositions — binary positions force-close at outcome", () => {
  it("BUY-YES on settled-YES binary → wins, exits at $1, +PnL", async () => {
    await setupBinary({ tokenId: "btc-yes-up", settled: 1, outcome: 1 });
    const agentId = await seedAgentWithPosition({
      name: "buy-yes-wins", tokenId: "btc-yes-up", side: "BUY",
      entry_price: 0.45, size_usd: 5,
    });
    const state = await runEvolveAndGetAgentState(agentId);
    // shareRet = (1 - 0.45) / 0.45 = 1.222 → realized = $5 × 1.222 = $6.11
    expect(state.realized_pnl_usd).toBeCloseTo(6.111, 1);
    expect(state.trades_count).toBe(1);
    expect(state.wins_count).toBe(1);
    expect(state.positions).toHaveLength(0);
    // Cash: started 95 (after $5 entry), now 95 + 5 + 6.11 = 106.11
    expect(state.cash_usd_current).toBeCloseTo(106.11, 1);
  });

  it("BUY-YES on settled-NO binary → loses, exits at $0, full -PnL", async () => {
    await setupBinary({ tokenId: "btc-yes-down", settled: 1, outcome: 0 });
    const agentId = await seedAgentWithPosition({
      name: "buy-yes-loses", tokenId: "btc-yes-down", side: "BUY",
      entry_price: 0.55, size_usd: 5,
    });
    const state = await runEvolveAndGetAgentState(agentId);
    // shareRet = (0 - 0.55) / 0.55 = -1.0 → realized = -$5
    expect(state.realized_pnl_usd).toBeCloseTo(-5, 1);
    expect(state.trades_count).toBe(1);
    expect(state.wins_count).toBe(0);
    expect(state.positions).toHaveLength(0);
  });

  it("SELL-YES on settled-NO binary → wins (NO won), bounded +PnL via BUY-NO math", async () => {
    // SELL-YES = BUY-NO at price (1 - yes_mid). Entry at YES=0.055 means
    // buying NO at $0.945. When NO wins, $5 stake → 5/0.945 = 5.29 shares
    // each paying $1 = $5.29 payout, realized = $0.29.
    // Pre-2026-05-26 (broken): shareRet = (0.055 - 0)/0.055 = 1.0 → $5 win.
    // Post-fix:                shareRet = (0.055 - 0)/(1-0.055) = 0.0582 → $0.29.
    await setupBinary({ tokenId: "btc-sell-wins", settled: 1, outcome: 0 });
    const agentId = await seedAgentWithPosition({
      name: "sell-yes-wins", tokenId: "btc-sell-wins", side: "SELL",
      entry_price: 0.055, size_usd: 5,
    });
    const state = await runEvolveAndGetAgentState(agentId);
    expect(state.realized_pnl_usd).toBeCloseTo(0.291, 2);
    expect(state.trades_count).toBe(1);
    expect(state.wins_count).toBe(1);
    expect(state.positions).toHaveLength(0);
  });

  it("SELL-YES on settled-YES binary → loses, bounded -PnL = -stake (the unbounded-short bug)", async () => {
    // The exact case that burned agent 1552. Pre-fix: SELL at $0.30 with YES
    // winning lost $11.67 on a $5 stake (-2.33x). Post-fix: bounded at -$5.
    await setupBinary({ tokenId: "btc-sell-loses", settled: 1, outcome: 1 });
    const agentId = await seedAgentWithPosition({
      name: "sell-yes-loses", tokenId: "btc-sell-loses", side: "SELL",
      entry_price: 0.30, size_usd: 5,
    });
    const state = await runEvolveAndGetAgentState(agentId);
    // shareRet = (0.30 - 1) / (1 - 0.30) = -1.0 → realized = -$5 (bounded)
    expect(state.realized_pnl_usd).toBeCloseTo(-5, 2);
    expect(state.trades_count).toBe(1);
    expect(state.wins_count).toBe(0);
    expect(state.positions).toHaveLength(0);
  });

  it("unsettled binary → position stays open (resolver will handle later)", async () => {
    await setupBinary({ tokenId: "btc-still-open", settled: 0, outcome: null });
    const agentId = await seedAgentWithPosition({
      name: "still-open", tokenId: "btc-still-open", side: "BUY",
      entry_price: 0.5, size_usd: 5,
    });
    const state = await runEvolveAndGetAgentState(agentId);
    // Should NOT close — leave open for resolver
    expect(state.realized_pnl_usd).toBe(0);
    expect(state.trades_count).toBe(0);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].market_id).toBe("btc-still-open");
  });
});
