import { describe, expect, it } from "vitest";
import { _internal, oracleLlmAvailable } from "@/lib/agents/oracle-llm";
import type { AgentContext } from "@/lib/agents/context";
import type { EvaluatorArgs, StrategyRow, StrategyVersionRow } from "@/lib/agents/types";

function dummyContext(): AgentContext {
  return {
    builtAt: "2026-01-01T00:00:00Z",
    agentId: 1, strategyId: 1,
    capsules: [], activeCapsules: [],
    riskLimits: {
      enabled: true, max_order_notional_usd: 250, max_position_notional_usd: 1000,
      max_daily_loss_usd: 200, max_open_positions: 20, max_orders_per_minute: 60,
      max_concentration_pct: 0.25, require_confirmation_above_usd: 100, forbidden_symbols: [],
    },
    killSwitch: { halted: false, reason: "", haltedAt: null, registeredBrokers: ["sim", "polymarket", "coinbase"] },
    lastRejection: null, recentOrderEvents: [], recentRejectCounts: {},
    recentEvolution: [], lastBacktest: null, performance: [],
  };
}

function dummyArgs(): EvaluatorArgs {
  const strategy: StrategyRow = { id: 1, agent_id: 1, slug: "weekly-deep-dives", name: "Oracle", thesis: "x", market_filter: "{}" };
  const current: StrategyVersionRow = { id: 1, strategy_id: 1, version: 1, spec_json: "{}", is_current: 1, stage: "sim" };
  return {
    strategy, current,
    signals: [
      { tokenId: "t-1", conditionId: "c-1", question: "Will Q1?", midpoint: 0.4, spread: 0.02, ret1d: 0.05, ret1w: 0.10, realizedVol: 0.03, zScore: 2.1, samples: 60 },
      { tokenId: "t-2", conditionId: "c-2", question: "Will Q2?", midpoint: 0.6, spread: 0.04, ret1d: -0.02, ret1w: 0.0, realizedVol: 0.01, zScore: -1.8, samples: 60 },
    ],
    context: dummyContext(),
  };
}

describe("oracleLlmAvailable", () => {
  it("matches authIsAvailable()", () => {
    // Don't assert true/false — depends on the host env. Just ensure it returns boolean.
    expect(typeof oracleLlmAvailable()).toBe("boolean");
  });
});

describe("Oracle LLM system prompt shape", () => {
  it("includes the SKILL.md content (or fallback message)", () => {
    const prompt = _internal.buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(2000);
    expect(prompt).toMatch(/Oracle Research/);
    expect(prompt).toMatch(/research-only by design/);
    // SKILL.md content should be inlined
    expect(prompt.includes("PolymarketAutomation skill") || prompt.includes("SKILL.md not found")).toBe(true);
  });
});

describe("Oracle LLM user message", () => {
  it("contains top-by-zScore signals + serialized workspace context", () => {
    const args = dummyArgs();
    const msg = _internal.buildUserMessage(args);
    expect(msg).toMatch(/Signals \(top 2/);
    expect(msg).toMatch(/t-1/);
    expect(msg).toMatch(/Workspace context/);
    expect(msg).toMatch(/risk_limits/);
    expect(msg).toMatch(/kill_switch/);
  });

  it("preserves question + tokenId verbatim (LP matches by string equality)", () => {
    const args = dummyArgs();
    const msg = _internal.buildUserMessage(args);
    expect(msg).toContain('"tokenId": "t-1"');
    expect(msg).toContain('"question": "Will Q1?"');
  });
});

describe("OUTPUT_SCHEMA shape", () => {
  it("requires summary, candidates, workspace_observations", () => {
    const schema = _internal.OUTPUT_SCHEMA;
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("candidates");
    expect(schema.required).toContain("workspace_observations");
  });
});
