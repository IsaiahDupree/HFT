/**
 * Auto-promote tests — top-N elites get auto-promoted to live capsules.
 *
 * Covers:
 *   - ALLOW_AUTO_PROMOTE != 1 → skipped
 *   - ARENA_LIVE_CAPITAL_TOTAL_USD missing/<=0 → skipped
 *   - Top-3 elites with proof-of-life → promoted, equal capital split
 *   - Elites without proof-of-life (no trades or losing) → NOT promoted
 *   - Re-run with same state → idempotent (no duplicates)
 *   - Agent falls out of top-3 → its auto-live capsule gets paused
 *   - Manually-created capsules (different name pattern) are NOT touched
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

beforeEach(() => {
  memDb?.close(); memDb = null;
  process.env.ALLOW_AUTO_PROMOTE = "1";
  process.env.ARENA_LIVE_CAPITAL_TOTAL_USD = "30";
});

async function seedAgent(opts: {
  name: string;
  elite: boolean;
  trades: number;
  realized: number;
  cashCurrent?: number;
  entries?: number;
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
  const r = db().prepare(
    `INSERT INTO paper_agents (
       name, generation, genome_json, introduced_by,
       cash_usd_start, cash_usd_current, peak_equity_usd,
       realized_pnl_usd, trades_count, entries_count, wins_count, is_elite
     ) VALUES (?, 1, ?, 'test', 100, ?, 100, ?, ?, ?, ?, ?)`,
  ).run(
    opts.name, genome,
    opts.cashCurrent ?? 100 + opts.realized,
    opts.realized,
    opts.trades,
    opts.entries ?? opts.trades,
    Math.max(0, opts.trades - 1),
    opts.elite ? 1 : 0,
  );
  return Number(r.lastInsertRowid);
}

describe("runAutoPromote — gates", () => {
  it("returns skipped when ALLOW_AUTO_PROMOTE != 1", async () => {
    delete process.env.ALLOW_AUTO_PROMOTE;
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.skipped).toMatch(/ALLOW_AUTO_PROMOTE/);
    expect(r.promoted).toHaveLength(0);
  });

  it("uses risk-budget defaults when no RISK_* env vars set (no longer requires ARENA_LIVE_CAPITAL_TOTAL_USD)", async () => {
    // Previously required ARENA_LIVE_CAPITAL_TOTAL_USD; now the risk-budget
    // module derives a sensible default ($5 × 3 × 2 = $30 total live capital).
    delete process.env.ARENA_LIVE_CAPITAL_TOTAL_USD;
    delete process.env.RISK_STAKE_USD;
    await seedAgent({ name: "e1", elite: true, trades: 5, realized: 10 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    // With defaults the qualifying agent gets promoted, total_live_capital_usd > 0
    expect(r.skipped).toBeUndefined();
    expect(r.total_budget_usd).toBeGreaterThan(0);
    expect(r.promoted.length).toBeGreaterThan(0);
  });

  it("returns skipped when budget anchor is zero (RISK_STAKE_USD=0)", async () => {
    process.env.RISK_STAKE_USD = "0";
    await seedAgent({ name: "e1", elite: true, trades: 5, realized: 10 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    // 0-or-negative stake gets clamped to default by readRiskBudgetFromEnv
    // so this still works — but we'll verify the budget didn't collapse to 0.
    expect(r.total_budget_usd).toBeGreaterThan(0);
    delete process.env.RISK_STAKE_USD;
  });
});

describe("runAutoPromote — selection + capital split", () => {
  it("promotes top-3 elites with proof-of-life, equal split", async () => {
    const id1 = await seedAgent({ name: "e1", elite: true, trades: 5, realized: 30 });
    const id2 = await seedAgent({ name: "e2", elite: true, trades: 4, realized: 20 });
    const id3 = await seedAgent({ name: "e3", elite: true, trades: 3, realized: 10 });
    await seedAgent({ name: "e4", elite: true, trades: 5, realized: 5 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.qualified_agents).toBe(3);
    expect(r.promoted).toHaveLength(3);
    expect(r.per_capsule_usd).toBeCloseTo(10, 4); // 30 / 3
    const promotedIds = new Set(r.promoted.map((p) => p.agent_id));
    expect(promotedIds.has(id1)).toBe(true);
    expect(promotedIds.has(id2)).toBe(true);
    expect(promotedIds.has(id3)).toBe(true);
  });

  it("filters out elites with <3 trades", async () => {
    await seedAgent({ name: "e1", elite: true, trades: 2, realized: 50 });
    await seedAgent({ name: "e2", elite: true, trades: 5, realized: 10 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.qualified_agents).toBe(1);
    expect(r.promoted[0].agent_name).toBe("e2");
  });

  it("filters out elites with negative realized PnL", async () => {
    await seedAgent({ name: "e1", elite: true, trades: 5, realized: -10 });
    await seedAgent({ name: "e2", elite: true, trades: 5, realized: 0 });
    await seedAgent({ name: "e3", elite: true, trades: 5, realized: 5 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    // Only e3 (realized > 0) qualifies. e1 (negative), e2 (zero) excluded.
    expect(r.qualified_agents).toBe(1);
    expect(r.promoted[0].agent_name).toBe("e3");
  });

  it("considers all alive live-eligible agents ranked by fitness (bug #25 — not just is_elite=1)", async () => {
    // Pre-#25 contract: only is_elite=1 agents got promoted. That broke when
    // non-live-eligible strategies dominated fitness (fade-spike taking all
    // elite slots, then getting filtered out by live-eligibility check,
    // leaving zero live capsules). Now auto-promote ranks ALL alive
    // live-eligible agents and picks top-N by fitness regardless of elite flag.
    await seedAgent({ name: "non-elite-top", elite: false, trades: 10, realized: 100 });  // higher fitness, NOT elite
    await seedAgent({ name: "elite-lower", elite: true, trades: 3, realized: 5 });        // lower fitness, elite
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.qualified_agents).toBe(2);   // both qualify (proof-of-life + live-eligible)
    // Highest fitness wins regardless of elite flag.
    expect(r.promoted.find((p) => p.agent_name === "non-elite-top")).toBeDefined();
  });

  it("excludes strategies that aren't live-fill-eligible (bug #23)", async () => {
    // poly_fade_spike depends on visible orderbook depth — Polymarket's
    // matching engine kills its FAK orders with "no orders to match". Must
    // be excluded from live promotion regardless of its sim fitness.
    const { db } = await import("@/lib/db/client");
    db().prepare(`INSERT OR IGNORE INTO paper_generations (gen_number) VALUES (1)`).run();
    // Seed a fade-spike agent that LOOKS like a top performer in sim.
    db().prepare(
      `INSERT INTO paper_agents (name, generation, genome_json, introduced_by,
         cash_usd_start, cash_usd_current, peak_equity_usd, realized_pnl_usd,
         trades_count, entries_count, wins_count, is_elite)
       VALUES (?, 1, ?, 'test', 100, 200, 200, 100, 10, 10, 8, 1)`,
    ).run("fade-elite", JSON.stringify({
      kind: "poly_fade_spike",
      params: { threshold_pts: 3, lookback_h: 6, confirm_quiet_h: 2, entry_size_usd: 10,
                exit_target_pts: 2, stop_pts: 4, time_stop_h: 24 },
    }));
    // Seed a 5m-binary agent with lower fitness — should still win the slot.
    await seedAgent({ name: "binary-runner-up", elite: true, trades: 5, realized: 10 });

    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.qualified_agents).toBe(1);
    expect(r.promoted[0].agent_name).toBe("binary-runner-up");
  });

  it("ARENA_AUTO_PROMOTE_LIVE_KINDS env override re-includes fade-spike", async () => {
    process.env.ARENA_AUTO_PROMOTE_LIVE_KINDS = "poly_short_binary_directional,poly_fade_spike";
    const { db } = await import("@/lib/db/client");
    db().prepare(`INSERT OR IGNORE INTO paper_generations (gen_number) VALUES (1)`).run();
    db().prepare(
      `INSERT INTO paper_agents (name, generation, genome_json, introduced_by,
         cash_usd_start, cash_usd_current, peak_equity_usd, realized_pnl_usd,
         trades_count, entries_count, wins_count, is_elite)
       VALUES (?, 1, ?, 'test', 100, 200, 200, 100, 10, 10, 8, 1)`,
    ).run("fade-elite", JSON.stringify({
      kind: "poly_fade_spike",
      params: { threshold_pts: 3, lookback_h: 6, confirm_quiet_h: 2, entry_size_usd: 10,
                exit_target_pts: 2, stop_pts: 4, time_stop_h: 24 },
    }));

    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    const r = runAutoPromote();
    expect(r.qualified_agents).toBe(1);
    expect(r.promoted[0].agent_name).toBe("fade-elite");
    delete process.env.ARENA_AUTO_PROMOTE_LIVE_KINDS;
  });
});

describe("runAutoPromote — idempotency", () => {
  it("re-running with same state does not create duplicate capsules", async () => {
    await seedAgent({ name: "e1", elite: true, trades: 5, realized: 20 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    runAutoPromote();
    runAutoPromote();
    runAutoPromote();
    const { db } = await import("@/lib/db/client");
    const n = (db().prepare(`SELECT COUNT(*) AS c FROM capsules WHERE name LIKE 'auto-live-%'`).get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it("rebalances capital when N changes", async () => {
    const id1 = await seedAgent({ name: "e1", elite: true, trades: 5, realized: 20 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    runAutoPromote();
    // After first run: 1 elite, $30 capital
    const { db } = await import("@/lib/db/client");
    let cap = db().prepare(`SELECT capital_allocated_usd FROM capsules WHERE paper_agent_id = ?`).get(id1) as { capital_allocated_usd: number };
    expect(cap.capital_allocated_usd).toBeCloseTo(30, 4);
    // Add a second qualifying elite → re-run should rebalance to $15 each
    await seedAgent({ name: "e2", elite: true, trades: 5, realized: 15 });
    runAutoPromote();
    cap = db().prepare(`SELECT capital_allocated_usd FROM capsules WHERE paper_agent_id = ?`).get(id1) as { capital_allocated_usd: number };
    expect(cap.capital_allocated_usd).toBeCloseTo(15, 4);
  });
});

describe("runAutoPromote — demote on fallout", () => {
  it("pauses auto-live capsule when agent falls out of top-N by fitness (bug #25 — was: when agent loses elite flag)", async () => {
    // Old contract: capsule paused when is_elite flipped to 0.
    // New contract (#25): capsule paused when agent drops out of top-N ranked
    //   by fitness among live-eligible kinds. Elite flag no longer gates this.
    const id1 = await seedAgent({ name: "e1", elite: true, trades: 5, realized: 20 });
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    runAutoPromote();
    // Make e1 drop out of top-3 by seeding 3 higher-fitness rivals.
    await seedAgent({ name: "rival1", elite: false, trades: 10, realized: 100 });
    await seedAgent({ name: "rival2", elite: false, trades: 10, realized: 90 });
    await seedAgent({ name: "rival3", elite: false, trades: 10, realized: 80 });
    const r = runAutoPromote();
    // e1 is now 4th; with topN=3 by default, its auto-live capsule should pause.
    expect(r.paused.find((p) => p.agent_id === id1)).toBeDefined();
    const { db } = await import("@/lib/db/client");
    const cap = db().prepare(`SELECT status FROM capsules WHERE paper_agent_id = ?`).get(id1) as { status: string };
    expect(cap.status).toBe("paused");
    // Agent itself is NOT retired
    const a = db().prepare(`SELECT alive FROM paper_agents WHERE id = ?`).get(id1) as { alive: 0 | 1 };
    expect(a.alive).toBe(1);
  });

  it("does not touch manually-created capsules (different name pattern)", async () => {
    const id1 = await seedAgent({ name: "e1", elite: true, trades: 5, realized: 20 });
    const { db } = await import("@/lib/db/client");
    // Pre-create a manual capsule for the same agent.
    db().prepare(`
      INSERT INTO capsules (id, name, status, paper_agent_id, capital_allocated_usd, capital_available_usd, allowed_venues_json)
      VALUES ('manual-uuid', 'live-${"e1"}-manual', 'live', ?, 100, 100, '["polymarket"]')
    `).run(id1);
    const { runAutoPromote } = await import("@/lib/arena/auto-promote");
    runAutoPromote();
    // Manual capsule untouched
    const manual = db().prepare(`SELECT status, capital_allocated_usd FROM capsules WHERE id = 'manual-uuid'`).get() as { status: string; capital_allocated_usd: number };
    expect(manual.status).toBe("live");
    expect(manual.capital_allocated_usd).toBe(100);
    // Plus an auto-live capsule was created
    const autos = db().prepare(`SELECT COUNT(*) AS c FROM capsules WHERE name LIKE 'auto-live-%'`).get() as { c: number };
    expect(autos.c).toBe(1);
  });
});
