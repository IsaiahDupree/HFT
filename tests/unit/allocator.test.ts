/**
 * Pure unit tests for the capital allocator (no DB). Verifies the
 * "which agents get a capsule and why" policy: eligibility gates, fitness-
 * weighted sizing, the per-capsule concentration cap, and budget conservation.
 */
import { describe, it, expect } from "vitest";
import { planAllocations, DEFAULT_ALLOCATION } from "@/lib/arena/allocator";
import type { PaperAgentRow } from "@/lib/arena/types";

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

describe("planAllocations", () => {
  it("funds positive-edge agents proportionally and skips negative-edge ones", () => {
    const agents = [
      makeAgent({ id: 1, name: "strong", cash_usd_current: 120, peak_equity_usd: 120, trades_count: 6, entries_count: 6, wins_count: 5 }), // +20%
      makeAgent({ id: 2, name: "mild", cash_usd_current: 105, peak_equity_usd: 105, trades_count: 4, entries_count: 4, wins_count: 2 }), // +5%
      makeAgent({ id: 3, name: "loser", cash_usd_current: 90, peak_equity_usd: 100, max_drawdown_usd: 10, trades_count: 3, entries_count: 3 }), // -10%
    ];
    const plan = planAllocations(agents, { totalBudgetUsd: 1000, maxCapsules: 5, minFitness: 0, minTrades: 1, maxShare: 0.9 });

    const byId = Object.fromEntries(plan.decisions.map((d) => [d.agentId, d]));
    expect(byId[1].funded).toBe(true);
    expect(byId[2].funded).toBe(true);
    expect(byId[3].funded).toBe(false); // negative fitness → not funded
    expect(byId[1].grantUsd).toBeGreaterThan(byId[2].grantUsd); // stronger gets more
    expect(plan.totalAllocatedUsd).toBeGreaterThan(990); // budget ~fully deployed
    expect(plan.totalAllocatedUsd).toBeLessThanOrEqual(1000.01);
  });

  it("respects the per-capsule concentration cap", () => {
    const agents = [
      makeAgent({ id: 1, name: "a", cash_usd_current: 200, peak_equity_usd: 200, trades_count: 5, entries_count: 5 }), // +100%
      makeAgent({ id: 2, name: "b", cash_usd_current: 110, peak_equity_usd: 110, trades_count: 5, entries_count: 5 }), // +10%
    ];
    const plan = planAllocations(agents, { totalBudgetUsd: 1000, maxCapsules: 5, minFitness: 0, minTrades: 1, maxShare: 0.6 });
    for (const d of plan.funded) expect(d.share).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(plan.funded.length).toBe(2);
  });

  it("gates on minimum trade count (proof of activity)", () => {
    const agents = [
      makeAgent({ id: 1, name: "idle", cash_usd_current: 130, peak_equity_usd: 130, trades_count: 0 }), // great pnl but never traded
      makeAgent({ id: 2, name: "active", cash_usd_current: 103, peak_equity_usd: 103, trades_count: 3, entries_count: 3 }),
    ];
    const plan = planAllocations(agents, { ...DEFAULT_ALLOCATION, totalBudgetUsd: 500, minTrades: 1 });
    const idle = plan.decisions.find((d) => d.agentId === 1)!;
    const active = plan.decisions.find((d) => d.agentId === 2)!;
    expect(idle.funded).toBe(false);
    expect(active.funded).toBe(true);
  });
});
