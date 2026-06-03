/**
 * Activation-gate tests — assert defaults are SAFE and the gate fires under
 * the expected conditions. Mocks the replay-fitness module so we can drive
 * the gate outcome deterministically without seeding hundreds of snapshots.
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

// Mock replay-fitness so we can drive the backtest outcome.
let mockReplay: { pnl_pct: number; max_dd_pct: number; fitness: number; trades_count: number; win_rate: number; starting_cash: number; ending_equity: number; ticks: number } = {
  pnl_pct: 0, max_dd_pct: 0, fitness: 0, trades_count: 0, win_rate: 0,
  starting_cash: 1000, ending_equity: 1000, ticks: 0,
};
vi.mock("@/lib/arena/replay-fitness", () => ({
  computeReplayFitness: () => mockReplay,
}));

let originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  memDb?.close(); memDb = null;
  originalEnv = {
    ARENA_ACTIVATE_MIN_PNL_PCT: process.env.ARENA_ACTIVATE_MIN_PNL_PCT,
    ARENA_ACTIVATE_MAX_DD_PCT: process.env.ARENA_ACTIVATE_MAX_DD_PCT,
    ARENA_ACTIVATE_WINDOW_DAYS: process.env.ARENA_ACTIVATE_WINDOW_DAYS,
    ARENA_ACTIVATE_PROOF_COUNCIL: process.env.ARENA_ACTIVATE_PROOF_COUNCIL,
  };
  for (const k of Object.keys(originalEnv)) delete process.env[k];
  mockReplay = { pnl_pct: 0, max_dd_pct: 0, fitness: 0, trades_count: 0, win_rate: 0, starting_cash: 1000, ending_equity: 1000, ticks: 0 };
});

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  memDb?.close(); memDb = null;
});

async function seedPaperAndCapsule(): Promise<{ paperAgentId: number; capsuleId: string }> {
  const { db } = await import("@/lib/db/client");
  const handle = db();
  handle.prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, cash_usd_start, cash_usd_current, peak_equity_usd)
     VALUES ('champ', 0, ?, 1000, 1000, 1000)`,
  ).run(JSON.stringify({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 25 } }));
  const paperAgentId = (handle.prepare(`SELECT id FROM paper_agents WHERE name = 'champ'`).get() as { id: number }).id;
  const capsuleId = "test-cap-activation-1";
  handle.prepare(
    `INSERT INTO capsules (id, name, status, paper_agent_id, capital_allocated_usd, capital_available_usd,
                           max_daily_loss_usd, max_total_drawdown_usd, max_position_pct, max_open_positions,
                           max_trades_per_day, allowed_venues_json, min_seconds_between_trades)
     VALUES (?, 'champ-cap', 'paper', ?, 100, 100, 10, 30, 0.5, 3, 20, '["coinbase","polymarket"]', 0)`,
  ).run(capsuleId, paperAgentId);
  return { paperAgentId, capsuleId };
}

describe("activateCapsule — defaults are SAFE", () => {
  it("default bypass is false (gate is ON unless explicit opt-out)", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    // Force the gate to FAIL (pnl_pct way below default -2% floor).
    mockReplay = { ...mockReplay, pnl_pct: -0.50, max_dd_pct: 0.05 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test"); // no bypass passed
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pnl/i);
  });

  it("with bypass=true the gate is skipped and the capsule activates", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    mockReplay = { ...mockReplay, pnl_pct: -0.50, max_dd_pct: 0.99 }; // would fail BOTH
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test", { bypass: true });
    expect(result.ok).toBe(true);
  });

  it("logs capsule-activated with (BYPASS gate) in the summary when bypassed", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    mockReplay = { ...mockReplay, pnl_pct: -0.50 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    activateCapsule(capsuleId, "operator-test", { bypass: true });
    const { db } = await import("@/lib/db/client");
    const evt = db().prepare(
      `SELECT summary FROM evolution_log WHERE event_type = 'capsule-activated' ORDER BY id DESC LIMIT 1`,
    ).get() as { summary: string } | undefined;
    expect(evt?.summary).toMatch(/BYPASS/);
  });
});

describe("activateCapsule — gate logic", () => {
  it("passes when pnl & dd are within defaults", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    mockReplay = { ...mockReplay, pnl_pct: 0.05, max_dd_pct: 0.10 }; // +5% / 10% DD
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(true);
  });

  it("rejects when pnl% < min threshold", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    mockReplay = { ...mockReplay, pnl_pct: -0.10, max_dd_pct: 0.05 }; // -10% pnl
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pnl/i);
  });

  it("rejects when max_dd_pct > max threshold", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    mockReplay = { ...mockReplay, pnl_pct: 0.05, max_dd_pct: 0.40 }; // 40% DD
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/drawdown/i);
  });

  it("env override loosens the floor", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    process.env.ARENA_ACTIVATE_MIN_PNL_PCT = "-0.50"; // accept up to -50% loss
    mockReplay = { ...mockReplay, pnl_pct: -0.10, max_dd_pct: 0.05 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(true);
  });

  it("rejects status != 'paper' (already live capsule)", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    const { db } = await import("@/lib/db/client");
    db().prepare(`UPDATE capsules SET status='live' WHERE id = ?`).run(capsuleId);
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/status=live/);
  });

  it("skips gate when capsule has no bound paper_agent (legacy capsule)", async () => {
    const { db } = await import("@/lib/db/client");
    const id = "unbound-cap";
    db().prepare(
      `INSERT INTO capsules (id, name, status, capital_allocated_usd, capital_available_usd,
                             max_daily_loss_usd, max_total_drawdown_usd, max_position_pct, max_open_positions,
                             max_trades_per_day, allowed_venues_json, min_seconds_between_trades)
       VALUES (?, 'unbound', 'paper', 100, 100, 10, 30, 0.5, 3, 20, '["coinbase"]', 0)`,
    ).run(id);
    // Make sure the gate WOULD fail if it ran — it shouldn't run.
    mockReplay = { ...mockReplay, pnl_pct: -0.99 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(id, "operator-test");
    expect(result.ok).toBe(true);
  });
});

describe("activateCapsule — Proof Council gate (opt-in ARENA_ACTIVATE_PROOF_COUNCIL=1)", () => {
  it("is OFF by default — a council-failing replay still activates on the legacy gate", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    // -1% pnl passes the -2% legacy floor, but is net-NEGATIVE → council would block.
    mockReplay = { ...mockReplay, pnl_pct: -0.01, max_dd_pct: 0.05, trades_count: 60, win_rate: 0.6 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    expect(activateCapsule(capsuleId, "operator-test").ok).toBe(true); // flag unset → legacy only
  });

  it("ON: BLOCKS a capsule that passes the legacy gate but is net-negative (council is stricter)", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    process.env.ARENA_ACTIVATE_PROOF_COUNCIL = "1";
    mockReplay = { ...mockReplay, pnl_pct: -0.01, max_dd_pct: 0.05, trades_count: 60, win_rate: 0.6 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/proof council REPAIR_FIRST/);
      expect(result.council?.verdict).toBe("REPAIR_FIRST");
    }
  });

  it("ON: BLOCKS a too-thin sample even with positive PnL", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    process.env.ARENA_ACTIVATE_PROOF_COUNCIL = "1";
    mockReplay = { ...mockReplay, pnl_pct: 0.05, max_dd_pct: 0.05, trades_count: 5, win_rate: 1 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.council?.skeptic.some((s) => /sample only 5 trades/.test(s))).toBe(true);
  });

  it("ON: ACTIVATES a net-positive, deep-enough, low-DD capsule and returns the ADVOCATE_APPROVED council", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    process.env.ARENA_ACTIVATE_PROOF_COUNCIL = "1";
    mockReplay = { ...mockReplay, pnl_pct: 0.05, max_dd_pct: 0.10, trades_count: 60, win_rate: 0.6 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    const result = activateCapsule(capsuleId, "operator-test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.council?.verdict).toBe("ADVOCATE_APPROVED");
  });

  it("ON: logs a capsule-activation-blocked event with the council verdict", async () => {
    const { capsuleId } = await seedPaperAndCapsule();
    process.env.ARENA_ACTIVATE_PROOF_COUNCIL = "1";
    mockReplay = { ...mockReplay, pnl_pct: -0.01, max_dd_pct: 0.05, trades_count: 60, win_rate: 0.6 };
    const { activateCapsule } = await import("@/lib/arena/championship");
    activateCapsule(capsuleId, "operator-test");
    const { db } = await import("@/lib/db/client");
    const evt = db().prepare(
      `SELECT summary FROM evolution_log WHERE event_type = 'capsule-activation-blocked' ORDER BY id DESC LIMIT 1`,
    ).get() as { summary: string } | undefined;
    expect(evt?.summary).toMatch(/BLOCKED by Proof Council/);
  });
});

describe("safety mode defaults — read-only sanity checks", () => {
  it("Polymarket safety.mode() returns DRY_RUN when ALLOW_TRADE is unset", async () => {
    delete process.env.ALLOW_TRADE;
    const { safety } = await import("@/lib/polymarket/execute");
    expect(safety.mode()).toBe("DRY_RUN");
  });

  it("Coinbase cbSafety.mode() returns DRY_RUN when COINBASE_ALLOW_TRADE is unset", async () => {
    delete process.env.COINBASE_ALLOW_TRADE;
    const { cbSafety } = await import("@/lib/coinbase/execute");
    expect(cbSafety.mode()).toBe("DRY_RUN");
  });

  it("Polymarket safety.mode() flips to LIVE only on ALLOW_TRADE=1 (not '0' or 'true')", async () => {
    const { safety } = await import("@/lib/polymarket/execute");
    process.env.ALLOW_TRADE = "1"; expect(safety.mode()).toBe("LIVE");
    process.env.ALLOW_TRADE = "0"; expect(safety.mode()).toBe("DRY_RUN");
    process.env.ALLOW_TRADE = "true"; expect(safety.mode()).toBe("DRY_RUN");
    delete process.env.ALLOW_TRADE;
  });

  it("Coinbase cbSafety.mode() flips to LIVE only on COINBASE_ALLOW_TRADE=1", async () => {
    const { cbSafety } = await import("@/lib/coinbase/execute");
    process.env.COINBASE_ALLOW_TRADE = "1"; expect(cbSafety.mode()).toBe("LIVE");
    process.env.COINBASE_ALLOW_TRADE = "0"; expect(cbSafety.mode()).toBe("DRY_RUN");
    delete process.env.COINBASE_ALLOW_TRADE;
  });
});
