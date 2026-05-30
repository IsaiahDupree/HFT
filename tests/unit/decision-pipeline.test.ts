/**
 * Tests for the decision pipeline (Phase 2):
 *   - score.ts: weighted scoring, decision bucketing, kill-switch override,
 *               reject override, score → size_multiplier mapping
 *   - regime.ts: classifier on synthetic trending / chop / breakout / news /
 *                low-vol / unknown inputs; regimeFitScore against strategy preferences
 *   - gates.ts: each wrapper returns a valid GateResult; reject conditions
 *   - pipeline.ts: end-to-end orchestrator on representative scenarios
 */
import { describe, expect, it } from "vitest";
import {
  bucketDecision,
  finalizeDecision,
  weightedScore,
} from "@/lib/decision/score";
import {
  classifyRegime,
  regimeFitScore,
  type Tick,
} from "@/lib/decision/regime";
import {
  dataQualityGate,
  edgeGate,
  executionGate,
  marketEligibilityGate,
  riskGate,
} from "@/lib/decision/gates";
import { runDecisionPipeline } from "@/lib/decision/pipeline";
import {
  DEFAULT_GATE_WEIGHTS,
  Gate,
  type DecisionContext,
  type GateResult,
} from "@/lib/decision/types";

// ─── score / bucketing ─────────────────────────────────────────────────────

describe("weightedScore", () => {
  it("perfect scores across all default-weighted gates → 1.0", () => {
    const results: GateResult[] = Object.keys(DEFAULT_GATE_WEIGHTS).map((g) =>
      Gate.pass(g, 1.0, "ok"),
    );
    expect(weightedScore(results)).toBeCloseTo(1.0, 6);
  });

  it("zero scores across all gates → 0.0", () => {
    const results: GateResult[] = Object.keys(DEFAULT_GATE_WEIGHTS).map((g) =>
      Gate.pass(g, 0, "zero"),
    );
    expect(weightedScore(results)).toBe(0);
  });

  it("missing gates renormalize — only-present gates determine the score", () => {
    const r = weightedScore([Gate.pass("regime", 1.0, "x")]);
    expect(r).toBe(1.0);
  });

  it("unweighted gates contribute 0 (not in DEFAULT_GATE_WEIGHTS)", () => {
    const r = weightedScore([Gate.pass("unknown_gate", 1.0, "x")]);
    expect(r).toBe(0);
  });

  it("mixed scores produce the expected weighted average", () => {
    // After Phase 9, weights are:
    //   data_quality 0.15, market_eligibility 0.10, regime 0.15,
    //   signal_agreement 0.15, edge 0.15, risk 0.10, governor 0.15, execution 0.05
    const r = weightedScore([
      Gate.pass("data_quality", 1.0, "x"),       // 0.15
      Gate.pass("market_eligibility", 0.5, "x"), // 0.10
      Gate.pass("regime", 1.0, "x"),             // 0.15
      Gate.pass("edge", 0.8, "x"),               // 0.15
      Gate.pass("risk", 1.0, "x"),               // 0.10
      Gate.pass("execution", 1.0, "x"),          // 0.05
    ]);
    // Total weight present: 0.70; weighted sum:
    //   0.15 + 0.05 + 0.15 + 0.12 + 0.10 + 0.05 = 0.62
    // Normalized: 0.62 / 0.70 ≈ 0.8857
    expect(r).toBeCloseTo(0.8857, 3);
  });
});

describe("bucketDecision", () => {
  it("score > 0.80 → APPROVED_FULL, size 1.0", () => {
    const d = bucketDecision(0.85, [Gate.pass("regime", 1.0, "x")]);
    expect(d.decision).toBe("APPROVED_FULL");
    expect(d.size_multiplier).toBe(1.0);
  });

  it("0.65 < score ≤ 0.80 → APPROVED_REDUCED, size in [0.5, 0.9]", () => {
    const d = bucketDecision(0.73, []);
    expect(d.decision).toBe("APPROVED_REDUCED");
    expect(d.size_multiplier).toBeGreaterThanOrEqual(0.5);
    expect(d.size_multiplier).toBeLessThanOrEqual(0.9);
  });

  it("size mapping is linear within the REDUCED band", () => {
    expect(bucketDecision(0.65 + 0.001, []).size_multiplier).toBeCloseTo(0.5, 1);
    expect(bucketDecision(0.80, []).size_multiplier).toBeCloseTo(0.9, 2);
    expect(bucketDecision(0.725, []).size_multiplier).toBeCloseTo(0.7, 2);
  });

  it("0.50 < score ≤ 0.65 → WATCHLIST, size 0", () => {
    const d = bucketDecision(0.55, []);
    expect(d.decision).toBe("WATCHLIST");
    expect(d.size_multiplier).toBe(0);
  });

  it("score ≤ 0.50 → REJECTED, size 0", () => {
    expect(bucketDecision(0.5, []).decision).toBe("REJECTED");
    expect(bucketDecision(0.0, []).decision).toBe("REJECTED");
  });

  it("KILL_SWITCH action overrides any score", () => {
    const d = bucketDecision(1.0, [Gate.killSwitch("risk", "global drawdown")]);
    expect(d.decision).toBe("KILL_SWITCH");
    expect(d.size_multiplier).toBe(0);
  });

  it("REJECT action overrides any non-kill score", () => {
    const d = bucketDecision(1.0, [Gate.reject("execution", "duplicate order")]);
    expect(d.decision).toBe("REJECTED");
    expect(d.size_multiplier).toBe(0);
  });

  it("KILL_SWITCH wins over REJECT", () => {
    const d = bucketDecision(0.3, [
      Gate.reject("execution", "bad"),
      Gate.killSwitch("risk", "panic"),
    ]);
    expect(d.decision).toBe("KILL_SWITCH");
  });
});

describe("finalizeDecision", () => {
  it("returns a complete DecisionResult", () => {
    const r = finalizeDecision(
      [Gate.pass("regime", 1.0, "ok"), Gate.pass("edge", 1.0, "ok")],
      undefined,
      "2026-05-27T00:00:00Z",
    );
    expect(r.decision).toBe("APPROVED_FULL");
    expect(r.approval_score).toBe(1.0);
    expect(r.size_multiplier).toBe(1.0);
    expect(r.gate_results).toHaveLength(2);
    expect(r.decision_ts).toBe("2026-05-27T00:00:00Z");
  });
});

// ─── regime classifier ─────────────────────────────────────────────────────

function trendingTicks(open: number, slope: number, n: number, noise = 0.1): Tick[] {
  const out: Tick[] = [];
  let seed = 0x1234;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    out.push({ ts: i * 1000, price: open + slope * i + rand() * noise });
  }
  return out;
}

function chopTicks(center: number, amplitude: number, n: number): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < n; i++) {
    // Alternating +/− amplitude → high path length, zero net drift
    out.push({ ts: i * 1000, price: center + (i % 2 === 0 ? amplitude : -amplitude) });
  }
  return out;
}

describe("classifyRegime", () => {
  it("returns 'unknown' for too-few ticks", () => {
    const r = classifyRegime([{ ts: 0, price: 100 }]);
    expect(r.regime).toBe("unknown");
    expect(r.confidence).toBe(0);
  });

  it("classifies modest monotonic upward trend as 'trending'", () => {
    // slope 0.02/tick on $100 base → log-returns ~0.02% → sigma_total ~0.12%
    // (below 0.5% breakout threshold). Efficiency ~1.0 → trending.
    const r = classifyRegime(trendingTicks(100, 0.02, 40, 0.001));
    expect(r.regime).toBe("trending");
    expect(r.efficiency).toBeGreaterThan(0.4);
  });

  it("classifies tight zigzag (±$0.01) as 'chop'", () => {
    // ±$0.01 on $100 = ±0.01% swings → low sigma (below news_shock threshold).
    // Strict alternation → delta=0 → efficiency=0 → chop.
    const r = classifyRegime(chopTicks(100, 0.01, 40));
    expect(r.regime).toBe("chop");
    expect(r.efficiency).toBeLessThan(0.15);
  });

  it("classifies high-vol monotonic move as 'breakout' (or 'trending' if vol below breakout threshold)", () => {
    // 40 ticks, $1 per step, $0 noise → efficiency ~1.0, sigma sufficient
    const r = classifyRegime(trendingTicks(100, 5, 40, 0));
    expect(["trending", "breakout"]).toContain(r.regime);
    expect(r.efficiency).toBeGreaterThan(0.9);
  });

  it("classifies high-vol no-direction as 'news_shock'", () => {
    // Tight oscillation but large amplitude per step → high sigma, low efficiency
    const r = classifyRegime(chopTicks(100, 5, 40)); // ±$5 swings at $100 ≈ 5% per step
    expect(r.regime).toBe("news_shock");
  });

  it("filters non-finite + non-monotonic ts ticks", () => {
    const ticks: Tick[] = [
      { ts: 0, price: 100 },
      { ts: NaN, price: 101 },          // skipped
      { ts: 1000, price: -1 },           // skipped (negative price)
      { ts: 500, price: 102 },           // skipped (ts regression)
      ...trendingTicks(100, 1, 30, 0.01).map((t) => ({ ts: t.ts + 2000, price: t.price })),
    ];
    const r = classifyRegime(ticks);
    expect(r.regime).not.toBe("unknown");
  });
});

describe("regimeFitScore", () => {
  it("matched regime in strategy list → score 1.0", () => {
    expect(regimeFitScore("trending", ["trending", "breakout"]).score).toBe(1.0);
    expect(regimeFitScore("trending", ["trending"]).matched).toBe(true);
  });

  it("'any' in strategy list → score 1.0 regardless of regime", () => {
    expect(regimeFitScore("chop", ["any"]).score).toBe(1.0);
    expect(regimeFitScore("breakout", ["any"]).matched).toBe(true);
  });

  it("empty strategy list → score 1.0 (no preference)", () => {
    expect(regimeFitScore("trending", []).score).toBe(1.0);
  });

  it("mismatch → score 0.4 (partial penalty)", () => {
    expect(regimeFitScore("chop", ["trending"]).score).toBe(0.4);
  });

  it("news_shock + strategy doesn't allow → score 0.0", () => {
    expect(regimeFitScore("news_shock", ["trending"]).score).toBe(0.0);
  });

  it("news_shock IS in strategy list → score 1.0", () => {
    expect(regimeFitScore("news_shock", ["news_shock", "any"]).score).toBe(1.0);
  });

  it("unknown regime → score 0.7 (mild penalty)", () => {
    expect(regimeFitScore("unknown", ["trending"]).score).toBe(0.7);
  });
});

// ─── gate wrappers ─────────────────────────────────────────────────────────

function mkCtx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    agentId: 1,
    capsuleId: "cap-x",
    strategyKind: "poly_short_binary_directional",
    proposal: {
      venue: "polymarket",
      symbol: "0xABC",
      side: "BUY",
      sizeUsd: 2,
      price: 0.52,
      conditionId: "0xABC",
      metadata: { edge: 0.08 },
    },
    snapshot: { midPrice: 0.52, bestBid: 0.51, bestAsk: 0.53, liquidityUsd: 5000 },
    ts: "2026-05-27T00:00:00Z",
    ...over,
  };
}

describe("gates: dataQualityGate", () => {
  it("v1 stub returns pass with score 1.0", () => {
    const r = dataQualityGate(mkCtx());
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(1.0);
  });
});

describe("gates: marketEligibilityGate", () => {
  it("passes on healthy liquidity + tight spread", () => {
    const r = marketEligibilityGate(mkCtx());
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(1.0);
  });

  it("rejects when liquidity below minimum", () => {
    const r = marketEligibilityGate(
      mkCtx({ snapshot: { liquidityUsd: 100, bestBid: 0.5, bestAsk: 0.51 } }),
      { minLiquidityUsd: 1000 },
    );
    expect(r.action).toBe("REJECT");
  });

  it("rejects when symbol not in allowedSymbols", () => {
    const r = marketEligibilityGate(mkCtx(), { allowedSymbols: ["only-this"] });
    expect(r.action).toBe("REJECT");
  });

  it("reduces (not rejects) on wide spread", () => {
    const r = marketEligibilityGate(
      mkCtx({ snapshot: { bestBid: 0.10, bestAsk: 0.90, liquidityUsd: 5000 } }),
      { maxSpreadFrac: 0.05 },
    );
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.score).toBeLessThan(1);
  });
});

describe("gates: edgeGate", () => {
  it("passes on edge above threshold", () => {
    const r = edgeGate(mkCtx({ proposal: { ...mkCtx().proposal, metadata: { edge: 0.10 } } }));
    expect(r.action).toBe("CONTINUE");
  });

  it("reduces on edge between 0 and threshold", () => {
    const r = edgeGate(mkCtx({ proposal: { ...mkCtx().proposal, metadata: { edge: 0.03 } } }));
    expect(r.action).toBe("REDUCE_SIZE");
  });

  it("rejects when edge ≤ fees", () => {
    const r = edgeGate(mkCtx({ proposal: { ...mkCtx().proposal, metadata: { edge: 0.001 } } }), {
      feeBps: 20,
    });
    expect(r.action).toBe("REJECT");
  });

  it("passes with neutral score when no edge field", () => {
    const r = edgeGate(mkCtx({ proposal: { ...mkCtx().proposal, metadata: {} } }));
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(0.7);
  });

  it("accepts expectedValue as alternative field", () => {
    const r = edgeGate(mkCtx({ proposal: { ...mkCtx().proposal, metadata: { expectedValue: 0.08 } } }));
    expect(r.action).toBe("CONTINUE");
  });
});

describe("gates: riskGate", () => {
  it("v1 stub returns pass", () => {
    const r = riskGate(mkCtx());
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(1.0);
  });
});

describe("gates: executionGate", () => {
  it("passes on valid proposal", () => {
    const r = executionGate(mkCtx());
    expect(r.action).toBe("CONTINUE");
  });

  it("rejects on zero sizeUsd", () => {
    const r = executionGate(
      mkCtx({ proposal: { ...mkCtx().proposal, sizeUsd: 0 } }),
    );
    expect(r.action).toBe("REJECT");
  });

  it("rejects price outside (0, 1) for polymarket", () => {
    const r = executionGate(
      mkCtx({ proposal: { ...mkCtx().proposal, price: 1.5 } }),
    );
    expect(r.action).toBe("REJECT");
  });

  it("accepts price=0.001 (minimal but valid)", () => {
    const r = executionGate(
      mkCtx({ proposal: { ...mkCtx().proposal, price: 0.001 } }),
    );
    expect(r.action).toBe("CONTINUE");
  });
});

// ─── pipeline end-to-end ───────────────────────────────────────────────────

describe("runDecisionPipeline", () => {
  it("APPROVED_FULL when all gates pass", () => {
    const result = runDecisionPipeline(mkCtx(), { skipGovernor: true });
    expect(result.gate_results.length).toBeGreaterThanOrEqual(5);
    expect(result.decision).toBe("APPROVED_FULL");
    expect(result.size_multiplier).toBe(1.0);
  });

  it("REJECTED when a gate rejects (e.g. zero edge)", () => {
    const result = runDecisionPipeline(
      mkCtx({ proposal: { ...mkCtx().proposal, metadata: { edge: 0.0001 } } }),
      { skipGovernor: true },
    );
    expect(result.decision).toBe("REJECTED");
    expect(result.size_multiplier).toBe(0);
  });

  it("REJECTED when execution gate rejects (zero size)", () => {
    const result = runDecisionPipeline(
      mkCtx({ proposal: { ...mkCtx().proposal, sizeUsd: 0 } }),
      { skipGovernor: true },
    );
    expect(result.decision).toBe("REJECTED");
  });

  it("regime gate present + scored when ticks supplied (modest trend)", () => {
    // Modest slope → trending bucket (not breakout).
    const ticks: Tick[] = trendingTicks(100, 0.02, 40, 0.001);
    const result = runDecisionPipeline(
      { ...mkCtx(), snapshot: { ...mkCtx().snapshot!, ticks } },
      { strategyRegimes: ["trending"], skipGovernor: true },
    );
    const regimeResult = result.gate_results.find((g) => g.gate === "regime");
    expect(regimeResult).toBeDefined();
    expect(regimeResult!.action).toBe("CONTINUE");
    expect(regimeResult!.details?.regime).toBe("trending");
  });

  it("regime mismatch reduces but doesn't reject", () => {
    const ticks: Tick[] = trendingTicks(100, 0.02, 40, 0.001);
    const result = runDecisionPipeline(
      { ...mkCtx(), snapshot: { ...mkCtx().snapshot!, ticks } },
      { strategyRegimes: ["chop"], skipGovernor: true }, // trending market, strategy wants chop
    );
    const regimeResult = result.gate_results.find((g) => g.gate === "regime")!;
    expect(regimeResult.action).toBe("REDUCE_SIZE");
    expect(regimeResult.score).toBe(0.4);
  });

  it("news_shock rejects when strategy doesn't allow", () => {
    const ticks: Tick[] = chopTicks(100, 5, 40); // high-vol no-direction
    const result = runDecisionPipeline(
      { ...mkCtx(), snapshot: { ...mkCtx().snapshot!, ticks } },
      { strategyRegimes: ["trending"], skipGovernor: true },
    );
    expect(result.decision).toBe("REJECTED");
    const regimeResult = result.gate_results.find((g) => g.gate === "regime")!;
    expect(regimeResult.action).toBe("REJECT");
    expect(regimeResult.details?.regime).toBe("news_shock");
  });

  it("decision_ts is set to provided value when supplied", () => {
    const result = runDecisionPipeline(mkCtx(), { nowIso: "2026-01-01T00:00:00Z", skipGovernor: true });
    expect(result.decision_ts).toBe("2026-01-01T00:00:00Z");
  });

  it("returns gate results in canonical order (with signal_agreement after regime)", () => {
    const result = runDecisionPipeline(mkCtx(), { skipGovernor: true });
    const gates = result.gate_results.map((g) => g.gate);
    expect(gates).toEqual([
      "data_quality",
      "market_eligibility",
      "regime",
      "signal_agreement",
      "edge",
      "risk",
      "execution",
    ]);
  });
});
