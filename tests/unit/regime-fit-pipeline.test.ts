import { describe, it, expect } from "vitest";
import { runDecisionPipeline } from "@/lib/decision/pipeline";
import { buildRegimeFitTableFromRows } from "@/lib/decision/regime-fit-table";
import { featureRowFromResult } from "@/lib/decision/meta-label";
import type { DecisionContext } from "@/lib/decision/types";
import type { LabeledDecision } from "@/lib/decision/calibration";

// Default snapshot has NO ticks → classifyRegime → 'unknown' (static fit 0.7).
function mkCtx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    agentId: 1, capsuleId: "cap-x", strategyKind: "poly_fade_spike",
    proposal: { venue: "polymarket", symbol: "0xABC", side: "BUY", sizeUsd: 2, price: 0.52, conditionId: "0xABC", metadata: { edge: 0.08 } },
    snapshot: { midPrice: 0.52, bestBid: 0.51, bestAsk: 0.53, liquidityUsd: 5000 },
    ts: "2026-05-27T00:00:00Z",
    ...over,
  };
}
// ±5% oscillation at $100 → high sigma, ~0 efficiency → news_shock.
const newsShockTicks = (n = 40) => Array.from({ length: n }, (_, i) => ({ ts: i, price: i % 2 ? 105 : 100 }));
// Steady monotonic drift → efficiency ~1.0, tiny sigma → 'trending'.
const trendingTicks = (n = 30) => Array.from({ length: n }, (_, i) => ({ ts: i, price: 100 + i * 0.02 }));
const rows = (kind: string, regime: string, wins: number, total: number): LabeledDecision[] =>
  Array.from({ length: total }, (_, i) => ({ id: i, approval_score: 0.5, decision: "X", won: i < wins, strategy_kind: kind, regime }));
const regimeGate = (r: ReturnType<typeof runDecisionPipeline>) => r.gate_results.find((g) => g.gate === "regime")!;

describe("build-6 regime-fit in the pipeline", () => {
  it("NO-OP when off: regimeFitTable undefined → regime gate is the static unknown score 0.7, no [meta-fit] tag", () => {
    const g = regimeGate(runDecisionPipeline(mkCtx(), { skipGovernor: true }));
    expect(g.score).toBe(0.7);
    expect(g.reason).not.toContain("meta-fit");
    expect((g.details as Record<string, unknown>).regime_fit_static).toBeUndefined();
  });

  it("overrides the static score with the learned LCB for a dense, parity-clean cell", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "unknown", 30, 40), { minTrades: 30 });
    const lcb = table.cells["poly_fade_spike|unknown"].lcb;
    const g = regimeGate(runDecisionPipeline(mkCtx(), { skipGovernor: true, regimeFitTable: table }));
    expect(g.score).toBe(lcb);
    expect(g.score).not.toBe(0.7);                       // the static value was replaced
    expect(g.reason).toContain("[meta-fit n=40]");
    expect((g.details as Record<string, unknown>).regime_fit_learned).toBe(lcb);
  });

  it("overrides via the Gate.pass (matched) branch too — records the matched static score 1.0 for the leakage guard", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "trending", 30, 40), { minTrades: 30 });
    const lcb = table.cells["poly_fade_spike|trending"].lcb;
    const ctx = mkCtx({ snapshot: { midPrice: 100, bestBid: 99, bestAsk: 101, ticks: trendingTicks() } });
    const g = regimeGate(runDecisionPipeline(ctx, { skipGovernor: true, strategyRegimes: ["trending"], regimeFitTable: table }));
    expect((g.details as Record<string, unknown>).regime).toBe("trending");
    expect(g.action).toBe("CONTINUE");                  // matched → Gate.pass branch
    expect(g.score).toBe(lcb);                          // approval uses the learned LCB
    expect(g.reason).toContain("strategy match");
    expect(g.reason).toContain("[meta-fit n=40]");
    expect((g.details as Record<string, unknown>).regime_fit_static).toBe(1.0); // matched static, recorded for the guard
  });

  it("thin cell (n=10 < minTrades) → falls back EXACTLY to the static score (0/10 must NOT hard-zero)", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "unknown", 0, 10), { minTrades: 30 });
    const g = regimeGate(runDecisionPipeline(mkCtx(), { skipGovernor: true, regimeFitTable: table }));
    expect(g.score).toBe(0.7);
    expect(g.reason).not.toContain("meta-fit");
  });

  it("out-of-vocab strategy_kind (venue) → static, never a wrong-vocabulary hit", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "unknown", 30, 40), { minTrades: 30 });
    // ctx serves a venue string (what live-capsule passes) → lookup refuses it
    const g = regimeGate(runDecisionPipeline(mkCtx({ strategyKind: "sim-poly" }), { skipGovernor: true, regimeFitTable: table }));
    expect(g.score).toBe(0.7);
  });

  it("SAFETY: news_shock hard-reject survives even a high-LCB learned cell for (kind × news_shock)", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "news_shock", 38, 40), { minTrades: 30 });
    const ctx = mkCtx({ snapshot: { midPrice: 100, bestBid: 99, bestAsk: 101, ticks: newsShockTicks() } });
    const g = regimeGate(runDecisionPipeline(ctx, { skipGovernor: true, regimeFitTable: table }));
    expect((g.details as Record<string, unknown>).regime).toBe("news_shock");
    expect(g.action).toBe("REJECT");
    expect(g.score).toBe(0);                              // learned cell cannot resurrect it
  });

  it("LEAKAGE GUARD: the meta-labeler feature reads the STATIC regime score, not the learned one", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "unknown", 30, 40), { minTrades: 30 });
    const result = runDecisionPipeline(mkCtx(), { skipGovernor: true, regimeFitTable: table });
    const lcb = table.cells["poly_fade_spike|unknown"].lcb;
    expect(regimeGate(result).score).toBe(lcb);                       // approval uses the learned score
    expect(featureRowFromResult(result).gateScores!.regime).toBe(0.7); // meta-label trains on the static score
    expect(featureRowFromResult(result).gateScores!.regime).not.toBe(lcb);
  });
});
