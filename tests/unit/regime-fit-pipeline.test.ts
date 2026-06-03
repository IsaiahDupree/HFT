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

  it("F5: 'unknown' regime is EXCLUDED from the learned override — stays on the static rail even with a dense cell", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "unknown", 30, 40), { minTrades: 30 });
    const g = regimeGate(runDecisionPipeline(mkCtx(), { skipGovernor: true, regimeFitTable: table }));
    expect(g.score).toBe(0.7);                           // unknown → static, never the learned LCB
    expect(g.reason).not.toContain("meta-fit");
    expect((g.details as Record<string, unknown>).regime_fit_static).toBeUndefined();
  });

  it("F1 SAFETY: a high-LCB learned cell can only TRIM, never RAISE — mismatch branch keeps the static 0.4 penalty", () => {
    // poly_fade_spike prefers 'chop'; serve 'trending' → mismatch (static 0.4). A 38/40
    // cell's LCB (~0.83) must NOT replace 0.4 — that would amplify a penalized regime + up-size.
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "trending", 38, 40), { minTrades: 30 });
    const ctx = mkCtx({ snapshot: { midPrice: 100, bestBid: 99, bestAsk: 101, ticks: trendingTicks() } });
    const g = regimeGate(runDecisionPipeline(ctx, { skipGovernor: true, strategyRegimes: ["chop"], regimeFitTable: table }));
    expect(g.action).toBe("REDUCE_SIZE");                // mismatch branch
    expect(g.score).toBe(0.4);                           // static penalty preserved; high LCB did NOT amplify
    expect(g.reason).not.toContain("meta-fit");          // override did not fire (learned >= static)
  });

  it("F1: a LOW-LCB learned cell DOES trim below the static penalty (override fires when learned < static)", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "trending", 2, 40), { minTrades: 30 });
    const lcb = table.cells["poly_fade_spike|trending"].lcb;
    expect(lcb).toBeLessThan(0.4);
    const ctx = mkCtx({ snapshot: { midPrice: 100, bestBid: 99, bestAsk: 101, ticks: trendingTicks() } });
    const g = regimeGate(runDecisionPipeline(ctx, { skipGovernor: true, strategyRegimes: ["chop"], regimeFitTable: table }));
    expect(g.score).toBe(lcb);                           // trimmed below the static 0.4
    expect(g.reason).toContain("[meta-fit");
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

  it("LEAKAGE GUARD: when the override fires (matched branch), the meta-labeler feature reads the STATIC regime score, not the learned LCB", () => {
    const table = buildRegimeFitTableFromRows(rows("poly_fade_spike", "trending", 30, 40), { minTrades: 30 });
    const lcb = table.cells["poly_fade_spike|trending"].lcb;          // < 1.0 → trims the matched 1.0
    const ctx = mkCtx({ snapshot: { midPrice: 100, bestBid: 99, bestAsk: 101, ticks: trendingTicks() } });
    const result = runDecisionPipeline(ctx, { skipGovernor: true, strategyRegimes: ["trending"], regimeFitTable: table });
    expect(regimeGate(result).score).toBe(lcb);                       // approval uses the learned score
    expect(featureRowFromResult(result).gateScores!.regime).toBe(1.0); // meta-label trains on the STATIC matched score
    expect(featureRowFromResult(result).gateScores!.regime).not.toBe(lcb);
  });
});
