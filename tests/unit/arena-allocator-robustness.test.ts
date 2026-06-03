/**
 * Robustness / invariant tests for the capital allocator
 * (`src/lib/arena/allocator.ts`). Complementary to `allocator.test.ts` —
 * these focus on structural invariants that must hold for ANY synthetic
 * input: non-negativity, budget conservation, concentration monotonicity,
 * fitness-ordering of grants, determinism, and edge/empty inputs.
 *
 * Pure + deterministic: all agents are constructed by hand or by a seeded
 * LCG. No DB, no network, no wall-clock, no Math.random.
 */
import { describe, it, expect } from "vitest";
import { planAllocations, DEFAULT_ALLOCATION } from "@/lib/arena/allocator";
import type { AllocationInput, AllocationPlan } from "@/lib/arena/allocator";
import { scoreAgent } from "@/lib/arena/score";
import type { PaperAgentRow } from "@/lib/arena/types";

// ---------------------------------------------------------------------------
// Deterministic helpers (no entropy / wall-clock).
// ---------------------------------------------------------------------------

/** Seeded linear congruential generator → reproducible pseudo-random [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeAgent(p: Partial<PaperAgentRow> & { id: number; name: string }): PaperAgentRow {
  const base = {
    generation: 0,
    parent_paper_agent_id: null,
    genome_json: '{"kind":"momentum","params":{}}',
    introduced_by: "test",
    cash_usd_start: 100,
    cash_usd_current: 100,
    position_basket_json: "[]",
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    peak_equity_usd: 100,
    max_drawdown_usd: 0,
    trades_count: 0,
    entries_count: 0,
    wins_count: 0,
    alive: 1,
    is_elite: 0,
    retire_reason: null,
    retired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...p } as unknown as PaperAgentRow;
}

/**
 * Build an agent whose equity (and hence pnl_pct / fitness) is a clean
 * function of `pnlUsd` on a $100 base, with `trades` trades, no drawdown.
 * fitness == pnl_pct == pnlUsd/100 (no DD, no activity bonus when entries=0).
 */
function gainAgent(id: number, pnlUsd: number, trades = 3): PaperAgentRow {
  return makeAgent({
    id,
    name: `a${id}`,
    cash_usd_current: 100 + pnlUsd,
    peak_equity_usd: 100 + Math.max(pnlUsd, 0),
    trades_count: trades,
    entries_count: 0,
    wins_count: 0,
  });
}

const BASE: AllocationInput = {
  totalBudgetUsd: 1000,
  maxCapsules: 10,
  minFitness: 0,
  minTrades: 1,
  maxShare: 0.9,
};

// Sum of grants across the FUNDED subset, taken from the per-agent decisions.
function fundedGrantSum(plan: AllocationPlan): number {
  return plan.funded.reduce((s, d) => s + d.grantUsd, 0);
}

// ===========================================================================
// 1. Non-negativity + budget conservation invariants
// ===========================================================================
describe("planAllocations — non-negativity & budget conservation", () => {
  it("no grant or share is ever negative", () => {
    const agents = [
      gainAgent(1, 40),
      gainAgent(2, 20),
      gainAgent(3, 5),
      makeAgent({ id: 4, name: "dead", alive: 0, trades_count: 9 }),
    ];
    const plan = planAllocations(agents, BASE);
    for (const d of plan.decisions) {
      expect(d.grantUsd).toBeGreaterThanOrEqual(0);
      expect(d.share).toBeGreaterThanOrEqual(0);
    }
  });

  it("total allocated never exceeds the budget (within rounding)", () => {
    const agents = [gainAgent(1, 80), gainAgent(2, 30), gainAgent(3, 10)];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 1000, maxShare: 0.9 });
    expect(plan.totalAllocatedUsd).toBeLessThanOrEqual(1000 + 0.01 * plan.funded.length + 1e-9);
  });

  it("plan.totalAllocatedUsd equals the rounded sum of funded grants", () => {
    const agents = [gainAgent(1, 50), gainAgent(2, 25), gainAgent(3, 12)];
    const plan = planAllocations(agents, BASE);
    const expected = Math.round(fundedGrantSum(plan) * 100) / 100;
    expect(plan.totalAllocatedUsd).toBeCloseTo(expected, 9);
  });

  it("plan echoes the input budget and stamps generatedAt as null", () => {
    const plan = planAllocations([gainAgent(1, 30)], { ...BASE, totalBudgetUsd: 777 });
    expect(plan.totalBudgetUsd).toBe(777);
    expect(plan.generatedAt).toBeNull();
  });

  it("each funded decision's share == grantUsd / totalBudgetUsd", () => {
    const agents = [gainAgent(1, 60), gainAgent(2, 20)];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 1000 });
    for (const d of plan.funded) {
      expect(d.share).toBeCloseTo(d.grantUsd / 1000, 9);
    }
  });

  it("with a generous cap the whole budget is deployed (near-fully)", () => {
    const agents = [gainAgent(1, 70), gainAgent(2, 40), gainAgent(3, 15)];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 1000, maxShare: 0.95 });
    expect(plan.totalAllocatedUsd).toBeGreaterThan(999);
    expect(plan.totalAllocatedUsd).toBeLessThanOrEqual(1000.01);
  });
});

// ===========================================================================
// 2. Concentration cap + monotonicity (concentrates on higher fitness)
// ===========================================================================
describe("planAllocations — concentration on higher fitness", () => {
  it("higher fitness ⇒ strictly larger grant when uncapped", () => {
    const agents = [gainAgent(1, 80), gainAgent(2, 40), gainAgent(3, 10)];
    const plan = planAllocations(agents, { ...BASE, maxShare: 0.95 });
    const byId = Object.fromEntries(plan.decisions.map((d) => [d.agentId, d]));
    expect(byId[1].grantUsd).toBeGreaterThan(byId[2].grantUsd);
    expect(byId[2].grantUsd).toBeGreaterThan(byId[3].grantUsd);
  });

  it("funded list is sorted by descending grant", () => {
    const agents = [gainAgent(3, 12), gainAgent(1, 90), gainAgent(2, 45)];
    const plan = planAllocations(agents, { ...BASE, maxShare: 0.95 });
    for (let i = 1; i < plan.funded.length; i++) {
      expect(plan.funded[i - 1].grantUsd).toBeGreaterThanOrEqual(plan.funded[i].grantUsd);
    }
  });

  it("no funded share exceeds maxShare (tight cap forces equality on the leader)", () => {
    const agents = [gainAgent(1, 500), gainAgent(2, 10)]; // 1 dominates
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 1000, maxShare: 0.6 });
    for (const d of plan.funded) expect(d.share).toBeLessThanOrEqual(0.6 + 1e-9);
    const top = plan.funded[0];
    expect(top.share).toBeCloseTo(0.6, 6); // dominant agent pinned at the cap
  });

  it("a tighter cap cannot increase the leader's grant (monotone in maxShare)", () => {
    const agents = [gainAgent(1, 400), gainAgent(2, 50), gainAgent(3, 20)];
    const loose = planAllocations(agents, { ...BASE, maxShare: 0.9 });
    const tight = planAllocations(agents, { ...BASE, maxShare: 0.4 });
    const leaderLoose = loose.decisions.find((d) => d.agentId === 1)!;
    const leaderTight = tight.decisions.find((d) => d.agentId === 1)!;
    expect(leaderTight.grantUsd).toBeLessThanOrEqual(leaderLoose.grantUsd + 1e-9);
  });

  it("equal-fitness agents receive equal grants (symmetry)", () => {
    const agents = [gainAgent(1, 30), gainAgent(2, 30), gainAgent(3, 30)];
    const plan = planAllocations(agents, { ...BASE, maxShare: 0.5 });
    const grants = plan.funded.map((d) => d.grantUsd);
    for (const g of grants) expect(g).toBeCloseTo(grants[0], 2);
  });

  it("if every funded agent is cap-pinned, none exceeds budget*maxShare", () => {
    // 4 equal agents, cap 0.25 → each exactly 25% of budget.
    const agents = [gainAgent(1, 20), gainAgent(2, 20), gainAgent(3, 20), gainAgent(4, 20)];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 1000, maxShare: 0.25 });
    expect(plan.funded.length).toBe(4);
    for (const d of plan.funded) expect(d.grantUsd).toBeLessThanOrEqual(250 + 1e-9);
  });
});

// ===========================================================================
// 3. Eligibility gates (alive / minTrades / minFitness / maxCapsules)
// ===========================================================================
describe("planAllocations — eligibility gates", () => {
  it("dead agents are never funded, regardless of fitness", () => {
    const agents = [
      makeAgent({ id: 1, name: "dead-winner", alive: 0, cash_usd_current: 500, peak_equity_usd: 500, trades_count: 9 }),
      gainAgent(2, 10),
    ];
    const plan = planAllocations(agents, BASE);
    const dead = plan.decisions.find((d) => d.agentId === 1)!;
    expect(dead.funded).toBe(false);
    expect(dead.grantUsd).toBe(0);
    expect(dead.reason).toMatch(/retired|dead/i);
  });

  it("agents below minTrades are gated out (no proof of activity)", () => {
    const agents = [
      makeAgent({ id: 1, name: "idle", cash_usd_current: 150, peak_equity_usd: 150, trades_count: 1 }),
      makeAgent({ id: 2, name: "active", cash_usd_current: 130, peak_equity_usd: 130, trades_count: 5 }),
    ];
    const plan = planAllocations(agents, { ...BASE, minTrades: 5 });
    expect(plan.decisions.find((d) => d.agentId === 1)!.funded).toBe(false);
    expect(plan.decisions.find((d) => d.agentId === 2)!.funded).toBe(true);
  });

  it("agents below minFitness are gated out (negative/insufficient edge)", () => {
    const agents = [
      gainAgent(1, -10), // fitness -0.10
      gainAgent(2, 30), //  fitness +0.30
    ];
    const plan = planAllocations(agents, { ...BASE, minFitness: 0.05 });
    expect(plan.decisions.find((d) => d.agentId === 1)!.funded).toBe(false);
    expect(plan.decisions.find((d) => d.agentId === 2)!.funded).toBe(true);
  });

  it("maxCapsules bounds the number of funded agents", () => {
    const agents = Array.from({ length: 6 }, (_, k) => gainAgent(k + 1, 60 - k * 5));
    const plan = planAllocations(agents, { ...BASE, maxCapsules: 3, maxShare: 0.95 });
    expect(plan.funded.length).toBe(3);
    expect(plan.decisions.filter((d) => d.funded).length).toBe(3);
  });

  it("maxCapsules = 0 funds nobody and allocates nothing", () => {
    const agents = [gainAgent(1, 40), gainAgent(2, 20)];
    const plan = planAllocations(agents, { ...BASE, maxCapsules: 0 });
    expect(plan.funded.length).toBe(0);
    expect(plan.totalAllocatedUsd).toBe(0);
    for (const d of plan.decisions) expect(d.funded).toBe(false);
  });

  it("the top-K funded are the highest-fitness eligible agents", () => {
    const agents = [gainAgent(1, 5), gainAgent(2, 90), gainAgent(3, 50), gainAgent(4, 1)];
    const plan = planAllocations(agents, { ...BASE, maxCapsules: 2, maxShare: 0.95 });
    const fundedIds = new Set(plan.funded.map((d) => d.agentId));
    expect(fundedIds.has(2)).toBe(true); // +90
    expect(fundedIds.has(3)).toBe(true); // +50
    expect(fundedIds.has(1)).toBe(false);
    expect(fundedIds.has(4)).toBe(false);
  });
});

// ===========================================================================
// 4. Zero-fitness / boundary handling
// ===========================================================================
describe("planAllocations — zero & boundary fitness", () => {
  it("an exactly-zero-fitness agent is still eligible at minFitness=0 and funded", () => {
    // pnl 0, no DD, no entries → fitness exactly 0, which is >= minFitness(0).
    const flat = makeAgent({ id: 1, name: "flat", trades_count: 3 });
    expect(scoreAgent(flat).fitness).toBe(0);
    const plan = planAllocations([flat], { ...BASE, minFitness: 0 });
    const d = plan.decisions.find((x) => x.agentId === 1)!;
    expect(d.funded).toBe(true); // funded via the +0.01 base weight
    expect(d.grantUsd).toBeGreaterThan(0);
  });

  it("all-zero-fitness eligible agents split the budget evenly (base-weight equality)", () => {
    const agents = [
      makeAgent({ id: 1, name: "z1", trades_count: 2 }),
      makeAgent({ id: 2, name: "z2", trades_count: 2 }),
      makeAgent({ id: 3, name: "z3", trades_count: 2 }),
    ];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 900, maxShare: 0.95 });
    expect(plan.funded.length).toBe(3);
    for (const d of plan.funded) expect(d.grantUsd).toBeCloseTo(300, 2);
  });

  it("a single zero-fitness eligible agent gets the whole budget up to the cap", () => {
    const plan = planAllocations([makeAgent({ id: 1, name: "solo", trades_count: 2 })], {
      ...BASE,
      totalBudgetUsd: 1000,
      maxShare: 0.5,
    });
    const d = plan.funded[0];
    expect(d.grantUsd).toBeCloseTo(500, 2); // pinned at the 50% cap
    expect(d.share).toBeCloseTo(0.5, 6);
  });

  it("minFitness=0 includes zero, excludes a tiny-negative agent", () => {
    const agents = [makeAgent({ id: 1, name: "zero", trades_count: 2 }), gainAgent(2, -1)];
    const plan = planAllocations(agents, { ...BASE, minFitness: 0 });
    expect(plan.decisions.find((d) => d.agentId === 1)!.funded).toBe(true);
    expect(plan.decisions.find((d) => d.agentId === 2)!.funded).toBe(false);
  });
});

// ===========================================================================
// 5. Determinism + empty / degenerate inputs
// ===========================================================================
describe("planAllocations — determinism & empty inputs", () => {
  it("is deterministic: identical inputs ⇒ byte-identical plans", () => {
    const build = () => [gainAgent(1, 70), gainAgent(2, 35), gainAgent(3, 12), gainAgent(4, 4)];
    const a = planAllocations(build(), BASE);
    const b = planAllocations(build(), BASE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is order-insensitive in funded grants: shuffling input rows yields the same grant-by-id", () => {
    const agents = [gainAgent(1, 60), gainAgent(2, 30), gainAgent(3, 15), gainAgent(4, 7)];
    const rng = lcg(42);
    const shuffled = [...agents].sort(() => rng() - 0.5);
    const grantById = (plan: AllocationPlan) =>
      Object.fromEntries(plan.decisions.map((d) => [d.agentId, d.grantUsd]));
    const planA = planAllocations(agents, { ...BASE, maxShare: 0.95 });
    const planB = planAllocations(shuffled, { ...BASE, maxShare: 0.95 });
    expect(grantById(planB)).toEqual(grantById(planA));
  });

  it("empty agent set ⇒ empty, zero plan (no throw)", () => {
    const plan = planAllocations([], BASE);
    expect(plan.decisions).toEqual([]);
    expect(plan.funded).toEqual([]);
    expect(plan.totalAllocatedUsd).toBe(0);
    expect(plan.totalBudgetUsd).toBe(BASE.totalBudgetUsd);
  });

  it("zero budget ⇒ everyone has share 0 and nothing is allocated", () => {
    const agents = [gainAgent(1, 50), gainAgent(2, 20)];
    const plan = planAllocations(agents, { ...BASE, totalBudgetUsd: 0 });
    expect(plan.totalAllocatedUsd).toBe(0);
    for (const d of plan.decisions) {
      expect(d.share).toBe(0);
      expect(d.grantUsd).toBe(0);
    }
  });

  it("decisions cover every input agent exactly once with sequential ranks", () => {
    const agents = [gainAgent(7, 5), gainAgent(3, 80), gainAgent(9, 40)];
    const plan = planAllocations(agents, BASE);
    expect(plan.decisions.length).toBe(agents.length);
    const ranks = plan.decisions.map((d) => d.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
    const ids = new Set(plan.decisions.map((d) => d.agentId));
    expect(ids).toEqual(new Set([3, 7, 9]));
  });

  it("rank #1 is the highest-fitness agent and funded with the largest grant", () => {
    const agents = [gainAgent(1, 12), gainAgent(2, 95), gainAgent(3, 44)];
    const plan = planAllocations(agents, { ...BASE, maxShare: 0.95 });
    const top = plan.decisions.find((d) => d.rank === 1)!;
    expect(top.agentId).toBe(2); // +95 fitness is the max
    expect(top.grantUsd).toBe(Math.max(...plan.funded.map((d) => d.grantUsd)));
  });

  it("DEFAULT_ALLOCATION produces a self-consistent, in-bounds plan over a random cohort", () => {
    const rng = lcg(2026);
    const agents = Array.from({ length: 14 }, (_, k) => {
      const pnl = Math.round((rng() - 0.4) * 120); // mix of winners & losers
      const trades = 1 + Math.floor(rng() * 6);
      return gainAgent(k + 1, pnl, trades);
    });
    const plan = planAllocations(agents, DEFAULT_ALLOCATION);
    // funded count never exceeds maxCapsules
    expect(plan.funded.length).toBeLessThanOrEqual(DEFAULT_ALLOCATION.maxCapsules);
    // concentration cap + non-negativity hold for everyone
    for (const d of plan.decisions) {
      expect(d.grantUsd).toBeGreaterThanOrEqual(0);
      expect(d.share).toBeLessThanOrEqual(DEFAULT_ALLOCATION.maxShare + 1e-9);
    }
    // only eligible (alive, enough trades, fitness >= floor) agents are funded
    for (const d of plan.funded) {
      const agent = agents.find((a) => a.id === d.agentId)!;
      const sc = scoreAgent(agent);
      expect(agent.alive).toBe(1);
      expect(sc.trades_count).toBeGreaterThanOrEqual(DEFAULT_ALLOCATION.minTrades);
      expect(sc.fitness).toBeGreaterThanOrEqual(DEFAULT_ALLOCATION.minFitness);
    }
    expect(plan.totalAllocatedUsd).toBeLessThanOrEqual(DEFAULT_ALLOCATION.totalBudgetUsd + 0.5);
  });
});
