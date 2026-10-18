/**
 * End-to-end arena lifecycle test (in-memory DB):
 *   init 4 agents → run 30 ticks against canned snapshots → evolve gen 0 →
 *   verify gen sealed, survivors persisted, children written for gen 1.
 *
 * Uses the project's standard vi.mock pattern for the singleton db().
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

async function seedSnapshots(productIds: string[], polyTokenIds: string[], n = 100) {
  const { db } = await import("@/lib/db/client");
  const handle = db();
  const insertCb = handle.prepare(
    `INSERT INTO coinbase_snapshots (product_id, best_bid, best_ask, midpoint, captured_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPm = handle.prepare(
    `INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, captured_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const start = Date.now() - n * 5 * 60_000;
  for (let i = 0; i < n; i++) {
    const t = new Date(start + i * 5 * 60_000).toISOString();
    for (const pid of productIds) {
      const price = 60_000 + Math.sin(i / 6) * 1500 + (Math.random() - 0.5) * 200;
      insertCb.run(pid, price - 1, price + 1, price, t);
    }
    for (const tid of polyTokenIds) {
      const mid = 0.5 + Math.sin(i / 10) * 0.20 + (Math.random() - 0.5) * 0.05;
      insertPm.run(`cond-${tid}`, tid, `q-${tid}`, Math.max(0.01, Math.min(0.99, mid)), t);
    }
  }
}

describe("arena lifecycle — in-memory end-to-end", () => {
  it("init → tick × 30 → evolve → next gen exists with children", async () => {
    const { db } = await import("@/lib/db/client");
    const { randomGenome, GENOME_KINDS } = await import("@/lib/arena/genome");
    const { insertPaperAgent, startGeneration, setGenerationAgentCount, listAliveAgentsForGen, getCurrentGeneration, toLiveAgent, persistAgentTick, insertPaperTrade, sealGeneration, listGenerations } = await import("@/lib/arena/db");
    const { applySignal, decide, markToMarket } = await import("@/lib/arena/sim");
    const { buildLiveTickContext } = await import("@/lib/arena/context");
    const { partitionSurvivors, rankAgents } = await import("@/lib/arena/score");
    const { mutateProgrammatic, mutate } = await import("@/lib/arena/mutate");

    // Snapshots first so context isn't empty.
    await seedSnapshots(["BTC-USD", "ETH-USD"], ["poly-tok-1", "poly-tok-2"], 200);

    // Seed gen 0 with 4 deterministic agents. Two random-walkers with high
    // trade_prob so the deterministic seed reliably produces trades.
    const genId = startGeneration(0, undefined, "test seed");
    const seedRng = (() => { let s = 7; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })();
    const ids: number[] = [];
    // High trade_prob random walkers — guarantees several trades over 30 ticks.
    ids.push(insertPaperAgent({ name: "g0-rand-hi-a", generation: 0, genome: { kind: "random_walk_baseline", params: { trade_prob: 0.08, buy_bias_pct: 0.5, entry_size_usd: 25 } } as any }));
    ids.push(insertPaperAgent({ name: "g0-rand-hi-b", generation: 0, genome: { kind: "random_walk_baseline", params: { trade_prob: 0.08, buy_bias_pct: 0.5, entry_size_usd: 25 } } as any }));
    for (const k of ["cb_breakout", "cb_mean_reversion"] as const) {
      const g = randomGenome(seedRng, k, { polyConditionIdPool: ["seed-x"] });
      ids.push(insertPaperAgent({ name: `g0-${k}`, generation: 0, genome: g }));
    }
    setGenerationAgentCount(genId, ids.length);
    expect(listAliveAgentsForGen(0).length).toBe(4);

    // Run 30 ticks with a SEEDED rng (deterministic) so trade count is stable.
    const gen = getCurrentGeneration()!;
    const tickRng = (() => { let s = 1234; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })();
    for (let t = 0; t < 30; t++) {
      const agents = listAliveAgentsForGen(gen.gen_number).map(toLiveAgent);
      const ctx = buildLiveTickContext();
      for (const agent of agents) {
        const sig = decide(agent, ctx, tickRng);
        if (sig.kind !== "hold") {
          const res = applySignal(agent, sig, ctx, gen.gen_number);
          if (res.trade) insertPaperTrade(res.trade);
        }
        markToMarket(agent, ctx);
        persistAgentTick(agent);
      }
    }

    // Some random_walk trades should have fired.
    const trades = db().prepare("SELECT COUNT(*) AS n FROM paper_trades").get() as { n: number };
    expect(trades.n).toBeGreaterThan(0);

    // Score + seal.
    const alive = listAliveAgentsForGen(0);
    const ranked = rankAgents(alive);
    const { survivors, cull } = partitionSurvivors(ranked, 0.5);
    expect(survivors.length).toBe(2);
    expect(cull.length).toBe(2);
    sealGeneration(gen.id, { n_alive: alive.length, top_agent_id: ranked[0].agent.id, top_score: ranked[0].score.fitness, n_promoted_children: survivors.length });
    const sealed = listGenerations(5).find((g) => g.gen_number === 0)!;
    expect(sealed.sealed_at).toBeTruthy();
    expect(sealed.n_alive_at_seal).toBe(alive.length);
    expect(sealed.top_paper_agent_id).toBe(ranked[0].agent.id);

    // Spawn gen 1 by mutating each survivor.
    const nextGenId = startGeneration(1, undefined, "evolved");
    let nChildren = 0;
    for (const s of survivors) {
      const child = await mutate(JSON.parse(s.agent.genome_json), { fitness: s.score.fitness, pnl_pct: s.score.pnl_pct, max_dd_pct: s.score.max_dd_pct, trades_count: s.score.trades_count });
      const id = insertPaperAgent({ name: `g1-c${nChildren}`, generation: 1, parent_paper_agent_id: s.agent.id, genome: child, introduced_by: "mutate-programmatic" });
      expect(id).toBeGreaterThan(0);
      nChildren += 1;
    }
    setGenerationAgentCount(nextGenId, nChildren);
    expect(listAliveAgentsForGen(1).length).toBe(survivors.length);
  });
});
