/**
 * Elite preservation tests for runEvolveOnce().
 *
 * Covers:
 *   - top-N alive agents (by fitness) get is_elite=1 after the seal
 *   - elites are NOT retired at gen seal (alive=1 stays)
 *   - elites are excluded from the cull partition
 *   - elites with max_dd_pct > ARENA_ELITE_MAX_DD_PCT get demoted (alive,
 *     is_elite=0, eligible for normal cull next time)
 *   - only agents with entries_count > 0 are eligible for elite promotion
 *   - the elite count is configurable via opts.eliteCount
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

// Stub out the live tick context — runEvolveOnce uses it to MtM-close
// positions before sealing. We hand it an empty snapshot map so nothing
// closes (we set agents to have 0 positions in fixtures anyway).
vi.mock("@/lib/arena/context", () => ({
  buildLiveTickContext: () => ({ now: new Date().toISOString(), snapshots: new Map() }),
}));

// Stub the mutation + replay paths so evolve doesn't try to run a candle
// replay or hit the LLM for child genomes. We only care about the elite
// promote/cull logic in this test.
vi.mock("@/lib/arena/mutate", () => ({
  mutate: async (g: any) => g,
  mutateProgrammatic: async (g: any) => g,
  mutateLlm: async (g: any) => g,
}));
vi.mock("@/lib/arena/replay-fitness", () => ({
  computeReplayFitness: () => ({ trades_count: 1 }),
}));

beforeEach(() => {
  memDb?.close(); memDb = null;
  delete process.env.ARENA_ELITE_COUNT;
  delete process.env.ARENA_ELITE_MAX_DD_PCT;
  delete process.env.ARENA_MUTATION_MODE;
});

async function seedGen(gen: number) {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT INTO paper_generations (gen_number) VALUES (?)`).run(gen);
}

async function seedAgent(opts: {
  name: string; generation: number; entries?: number; trades?: number;
  realized?: number; peakEquity?: number; maxDd?: number;
  cashCurrent?: number; isElite?: 0 | 1;
}): Promise<number> {
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
  // Default `trades` to `entries` so existing tests keep their semantics —
  // they assumed entries = closed round-trips. The new elite filter requires
  // trades_count > 0, so a test passing entries=5 but no trades would now
  // fail elite eligibility. Explicit `trades: 0` overrides.
  const trades = opts.trades !== undefined ? opts.trades : (opts.entries ?? 0);
  const r = db().prepare(
    `INSERT INTO paper_agents (
       name, generation, genome_json, introduced_by,
       cash_usd_start, cash_usd_current, peak_equity_usd, max_drawdown_usd,
       realized_pnl_usd, entries_count, trades_count, is_elite, position_basket_json
     ) VALUES (?, ?, ?, 'test', 100, ?, ?, ?, ?, ?, ?, ?, '[]')`,
  ).run(
    opts.name, opts.generation, genome,
    opts.cashCurrent ?? 100,
    opts.peakEquity ?? 100,
    opts.maxDd ?? 0,
    opts.realized ?? 0,
    opts.entries ?? 0,
    trades,
    opts.isElite ?? 0,
  );
  return Number(r.lastInsertRowid);
}

describe("runEvolveOnce — elite preservation", () => {
  it("promotes top-N entries-having agents to is_elite=1 at seal time", async () => {
    await seedGen(1);
    // 6 agents seeded sequentially (Promise.all interleaves the async-import
    // awaits and can race the SQL UNIQUE constraint via the cached statement).
    // cashCurrent above cash_usd_start (=100) is what surfaces as positive
    // pnl_pct in the fitness score; realized_pnl_usd alone isn't included in
    // liveEquity until it's reflected in cash + open principal.
    const id1 = await seedAgent({ name: "high-1", generation: 1, entries: 3, realized: 30, cashCurrent: 130 });
    const id2 = await seedAgent({ name: "high-2", generation: 1, entries: 3, realized: 20, cashCurrent: 120 });
    const id3 = await seedAgent({ name: "mid-3",  generation: 1, entries: 2, realized: 10, cashCurrent: 110 });
    await seedAgent({ name: "low-4",  generation: 1, entries: 1, realized: 5,  cashCurrent: 105 });
    await seedAgent({ name: "low-5",  generation: 1, entries: 1, realized: 2,  cashCurrent: 102 });
    await seedAgent({ name: "no-act", generation: 1, entries: 0, realized: 0,  cashCurrent: 100 });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    const result = await runEvolveOnce({ eliteCount: 3, survivalPct: 0.5 });
    expect("skipped" in result).toBe(false);

    const { db } = await import("@/lib/db/client");
    const elites = db().prepare(`SELECT id, name FROM paper_agents WHERE is_elite = 1`).all() as Array<{ id: number; name: string }>;
    expect(elites).toHaveLength(3);
    // Top 3 by fitness/realized: high-1, high-2, mid-3.
    const eliteIds = new Set(elites.map((e) => e.id));
    expect(eliteIds.has(id1)).toBe(true);
    expect(eliteIds.has(id2)).toBe(true);
    expect(eliteIds.has(id3)).toBe(true);
  });

  it("keeps elites alive (alive=1) after seal — does not retire them", async () => {
    await seedGen(1);
    const elite = await seedAgent({ name: "elite", generation: 1, entries: 5, realized: 50 });
    await seedAgent({ name: "loser-a", generation: 1, entries: 1, realized: -5 });
    await seedAgent({ name: "loser-b", generation: 1, entries: 1, realized: -10 });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    await runEvolveOnce({ eliteCount: 1, survivalPct: 0.5 });

    const { db } = await import("@/lib/db/client");
    const eliteRow = db().prepare(`SELECT alive, is_elite, retire_reason FROM paper_agents WHERE id = ?`).get(elite) as { alive: 0 | 1; is_elite: 0 | 1; retire_reason: string | null };
    expect(eliteRow.alive).toBe(1);
    expect(eliteRow.is_elite).toBe(1);
    expect(eliteRow.retire_reason).toBeNull();
  });

  it("demotes elites whose drawdown exceeds ARENA_ELITE_MAX_DD_PCT", async () => {
    await seedGen(1);
    // Make blownElite the TOP performer by realized PnL so it survives the
    // regular cull (rankAgents tie-breaks by realized_pnl_usd). The DD check
    // demotes it from elite, but its high fitness keeps it in the survivors
    // partition rather than the cull bucket.
    const blownElite = await seedAgent({
      name: "blew-up", generation: 1, entries: 5,
      peakEquity: 200, maxDd: 50,         // 25% drawdown — exceeds the 20% cap
      cashCurrent: 150, realized: 50,     // 50% PnL ranks it #1 by fitness
      isElite: 1,
    });
    await seedAgent({ name: "other", generation: 1, entries: 5, realized: 5, cashCurrent: 105 });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    await runEvolveOnce({ eliteCount: 1, eliteMaxDdPct: 0.20, survivalPct: 0.5 });

    const { db } = await import("@/lib/db/client");
    const row = db().prepare(`SELECT alive, is_elite FROM paper_agents WHERE id = ?`).get(blownElite) as { alive: 0 | 1; is_elite: 0 | 1 };
    // DD-demoted, so loses elite flag — but its high score puts it in the
    // survivor partition rather than the cull, so the evolve retire path is
    // "carried over (survivor)" with the carryover child carrying the genome.
    // The DEMOTED ELITE ITSELF still has alive=0 (carried over), but is_elite=0.
    expect(row.is_elite).toBe(0);
    // Confirm a carryover child for this lineage exists in gen 2.
    const child = db().prepare(`SELECT id FROM paper_agents WHERE parent_paper_agent_id = ? AND generation = 2`).get(blownElite) as { id: number } | undefined;
    expect(child).toBeTruthy();
  });

  it("excludes zero-entry agents from elite promotion", async () => {
    await seedGen(1);
    // High realized but never traded — should NOT be elite.
    const ghost = await seedAgent({ name: "ghost", generation: 1, entries: 0, realized: 999 });
    const real = await seedAgent({ name: "real",  generation: 1, entries: 5, realized: 10 });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    await runEvolveOnce({ eliteCount: 5, survivalPct: 0.5 });

    const { db } = await import("@/lib/db/client");
    const elites = db().prepare(`SELECT id FROM paper_agents WHERE is_elite = 1`).all() as Array<{ id: number }>;
    expect(elites.map((e) => e.id)).toContain(real);
    expect(elites.map((e) => e.id)).not.toContain(ghost);
  });

  it("excludes 'never-closes' agents (entries > 0 but trades_count = 0) from elite", async () => {
    // Mirrors the real-world fade-spike pathology: opens many positions with
    // time_stop_h=12-168h, so within a 30-min gen seal NO position closes.
    // Such agents racked up entries + activity-bonus fitness but contributed
    // no resolved PnL. The filter must require trades_count > 0.
    await seedGen(1);
    const noClose = await seedAgent({
      name: "never-closes", generation: 1,
      entries: 50,    // many open positions
      trades: 0,      // but zero round-trips closed
      realized: 0,
    });
    const closer = await seedAgent({
      name: "closer", generation: 1,
      entries: 3, trades: 3, realized: 5,
    });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    await runEvolveOnce({ eliteCount: 5, survivalPct: 0.5 });

    const { db } = await import("@/lib/db/client");
    const elites = db().prepare(`SELECT id, name FROM paper_agents WHERE is_elite = 1`).all() as Array<{ id: number; name: string }>;
    expect(elites.map((e) => e.id)).toContain(closer);
    expect(elites.map((e) => e.id)).not.toContain(noClose);
  });

  it("an active elite (still top-N, no DD breach) stays alive AND keeps elite flag through seal", async () => {
    await seedGen(1);
    // Top performer with existing is_elite=1 and small DD — should remain
    // alive=1 + is_elite=1 across the seal boundary. This is the core
    // protection: a winner that keeps winning is never retired.
    const elite = await seedAgent({
      name: "elite", generation: 1, entries: 10,
      realized: 50, cashCurrent: 150,    // big +PnL
      peakEquity: 152, maxDd: 2,         // ~1.3% DD — well within cap
      isElite: 1,
    });
    // Loser that gets culled normally.
    const loser = await seedAgent({
      name: "loser", generation: 1, entries: 5,
      realized: -30, cashCurrent: 70,
    });

    const { runEvolveOnce } = await import("@/lib/arena/evolve");
    await runEvolveOnce({ eliteCount: 1, eliteMaxDdPct: 0.20, survivalPct: 0.5 });

    const { db } = await import("@/lib/db/client");
    const eliteRow = db().prepare(`SELECT alive, is_elite, retire_reason FROM paper_agents WHERE id = ?`).get(elite) as { alive: 0 | 1; is_elite: 0 | 1; retire_reason: string | null };
    expect(eliteRow.is_elite).toBe(1);
    expect(eliteRow.alive).toBe(1);
    expect(eliteRow.retire_reason).toBeNull();
    // Loser was culled.
    const loserRow = db().prepare(`SELECT alive FROM paper_agents WHERE id = ?`).get(loser) as { alive: 0 | 1 };
    expect(loserRow.alive).toBe(0);
  });
});
