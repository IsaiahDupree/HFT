import { describe, expect, it } from "vitest";
import { DD_PENALTY, partitionSurvivors, rankAgents, scoreAgent } from "@/lib/arena/score";
import type { PaperAgentRow } from "@/lib/arena/types";

function agent(overrides: Partial<PaperAgentRow> = {}): PaperAgentRow {
  return {
    id: 1, name: "a", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "init",
    cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: 1000, max_drawdown_usd: 0,
    trades_count: 0, wins_count: 0, alive: 1, retire_reason: null, retired_at: null,
    created_at: "", updated_at: "",
    ...overrides,
  };
}

describe("scoreAgent — fitness = pnl_pct − 2 × max_dd_pct", () => {
  it("zero pnl + zero drawdown → fitness 0", () => {
    const s = scoreAgent(agent());
    expect(s.pnl_pct).toBe(0);
    expect(s.max_dd_pct).toBe(0);
    expect(s.fitness).toBe(0);
  });

  it("+10% pnl, 0 drawdown → fitness = +0.10", () => {
    const s = scoreAgent(agent({ cash_usd_current: 1100 }));
    expect(s.pnl_pct).toBeCloseTo(0.10, 6);
    expect(s.fitness).toBeCloseTo(0.10, 6);
  });

  it("+5% pnl with 10% drawdown → fitness = 0.05 − 0.20 = −0.15", () => {
    const s = scoreAgent(agent({ cash_usd_current: 1050, peak_equity_usd: 1100, max_drawdown_usd: 110 }));
    expect(s.pnl_pct).toBeCloseTo(0.05, 6);
    expect(s.max_dd_pct).toBeCloseTo(0.10, 6);
    expect(s.fitness).toBeCloseTo(0.05 - DD_PENALTY * 0.10, 6);
  });

  it("win_rate divides wins_count by trades_count", () => {
    const s = scoreAgent(agent({ trades_count: 10, wins_count: 7 }));
    expect(s.win_rate).toBeCloseTo(0.7);
  });

  it("includes unrealized pnl in the equity used for pnl_pct", () => {
    const s = scoreAgent(agent({ cash_usd_current: 800, unrealized_pnl_usd: 250 })); // equity 1050
    expect(s.pnl_pct).toBeCloseTo(0.05, 6);
  });
});

describe("rankAgents + partitionSurvivors", () => {
  it("ranks by fitness descending and breaks ties by realized PnL", () => {
    const a = agent({ id: 1, cash_usd_current: 1100, realized_pnl_usd: 100 });
    const b = agent({ id: 2, cash_usd_current: 1100, realized_pnl_usd: 50 }); // same fitness, lower realized
    const c = agent({ id: 3, cash_usd_current: 900, realized_pnl_usd: -100 });
    const ranked = rankAgents([c, b, a]);
    expect(ranked[0].agent.id).toBe(1);
    expect(ranked[1].agent.id).toBe(2);
    expect(ranked[2].agent.id).toBe(3);
  });

  it("partitionSurvivors at 50% picks top half", () => {
    const ranked = rankAgents([
      agent({ id: 1, cash_usd_current: 1500 }),
      agent({ id: 2, cash_usd_current: 1200 }),
      agent({ id: 3, cash_usd_current: 1000 }),
      agent({ id: 4, cash_usd_current: 700 }),
    ]);
    const { survivors, cull } = partitionSurvivors(ranked, 0.5);
    expect(survivors.map((r) => r.agent.id)).toEqual([1, 2]);
    expect(cull.map((r) => r.agent.id)).toEqual([3, 4]);
  });

  it("partitionSurvivors leaves at least 1 survivor", () => {
    const ranked = rankAgents([agent({ id: 9 })]);
    const { survivors, cull } = partitionSurvivors(ranked, 0.0);
    expect(survivors.length).toBe(1);
    expect(cull.length).toBe(0);
  });
});
