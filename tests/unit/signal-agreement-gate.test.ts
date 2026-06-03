/**
 * Robustness / invariant tests for the signal-agreement gate (Phase 14).
 *
 * Complementary to tests/unit/signal-agreement.test.ts — that file asserts
 * the canonical happy-path bucket behavior. This file targets:
 *
 *   - Unique INDEPENDENT cluster counting: many correlated signals from the
 *     same cluster collapse to one vote (the operator's "one signal wearing
 *     five costumes" principle).
 *   - Score monotonicity in the number of agreeing INDEPENDENT clusters.
 *   - Empty / neutral / reject edge inputs.
 *   - Determinism: the gate is a pure function of its arguments — repeated
 *     calls and shuffled-but-equivalent inputs yield identical results.
 *
 * All inputs are fixed, synthetic, and constructed in-process. Any
 * pseudo-randomness uses a seeded LCG so the suite is fully deterministic —
 * no wall-clock, no entropy source, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  signalAgreementGate,
  type SignalCluster,
  type StrategySignal,
} from "@/lib/decision/gates/signal-agreement";
import type { DecisionContext, GateResult } from "@/lib/decision/types";

const ALL_CLUSTERS: SignalCluster[] = [
  "price-action",
  "volatility",
  "microstructure",
  "cross-venue",
  "smart-money",
  "event",
  "geometric",
];

function mkCtx(signals: StrategySignal[], side: "BUY" | "SELL" = "BUY"): DecisionContext {
  return {
    agentId: 7,
    capsuleId: "cap-robust",
    strategyKind: "robust-test",
    proposal: {
      venue: "polymarket",
      symbol: "0xROBUST",
      side,
      sizeUsd: 5,
      price: 0.5,
      conditionId: "0xROBUST",
      metadata: { signals },
    },
    ts: "2026-05-28T00:00:00Z",
  };
}

/** N distinct pro clusters at a fixed safe confidence (below rejectOnConflict). */
function proClusters(n: number, conf = 0.6, side: "BUY" | "SELL" = "BUY"): StrategySignal[] {
  return ALL_CLUSTERS.slice(0, n).map((cluster) => ({
    cluster,
    direction: side,
    confidence: conf,
  }));
}

/** Deterministic LCG (Numerical Recipes constants) → floats in [0,1). */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Stable structural snapshot for determinism comparisons. */
function snap(r: GateResult): string {
  return JSON.stringify({
    gate: r.gate,
    status: r.status,
    score: r.score,
    action: r.action,
    reason: r.reason,
    details: r.details,
  });
}

describe("signalAgreementGate — independent cluster counting (dedup)", () => {
  it("emits the fixed gate id regardless of outcome", () => {
    expect(signalAgreementGate(mkCtx(proClusters(1))).gate).toBe("signal_agreement");
    expect(signalAgreementGate(mkCtx([])).gate).toBe("signal_agreement");
    expect(signalAgreementGate(mkCtx(proClusters(2, 0.6, "SELL"))).gate).toBe("signal_agreement");
  });

  it("20 correlated same-cluster signals collapse to ONE pro cluster", () => {
    const many: StrategySignal[] = Array.from({ length: 20 }, (_, i) => ({
      cluster: "price-action",
      direction: "BUY",
      confidence: 0.55 + (i % 5) * 0.02, // all >= minConfidence, varied sources
      source: `agent-${i}`,
    }));
    const r = signalAgreementGate(mkCtx(many));
    expect(r.details?.pro_clusters).toBe(1);
    expect(r.details?.signal_count).toBe(20); // all valid, all counted as signals
    expect(r.score).toBe(0.4); // 1 cluster → weak conviction
    expect(r.action).toBe("REDUCE_SIZE");
  });

  it("same cluster keeps only the STRONGEST pro confidence (not a sum)", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "smart-money", direction: "BUY", confidence: 0.55 },
        { cluster: "smart-money", direction: "BUY", confidence: 0.90 },
        { cluster: "smart-money", direction: "BUY", confidence: 0.72 },
      ]),
    );
    const breakdown = r.details?.cluster_breakdown as Record<
      string,
      { pro: number; anti: number; vote: string }
    >;
    expect(breakdown["smart-money"]?.pro).toBe(0.90);
    expect(breakdown["smart-money"]?.anti).toBe(0);
    expect(r.details?.pro_clusters).toBe(1);
  });

  it("five identical-cluster pro signals never reach full conviction (1.0)", () => {
    // The core principle: correlated signals are not independent evidence.
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.95 },
        { cluster: "price-action", direction: "BUY", confidence: 0.95 },
        { cluster: "price-action", direction: "BUY", confidence: 0.95 },
        { cluster: "price-action", direction: "BUY", confidence: 0.95 },
        { cluster: "price-action", direction: "BUY", confidence: 0.95 },
      ]),
    );
    expect(r.score).toBeLessThan(1.0);
    expect(r.score).toBe(0.4);
  });

  it("anti signals in the same cluster do not inflate the pro count", () => {
    // 2 distinct pro clusters; a third cluster nets neutral (tie within 0.05).
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.60 },
        { cluster: "volatility", direction: "BUY", confidence: 0.62 },
        { cluster: "event", direction: "BUY", confidence: 0.60 },
        { cluster: "event", direction: "SELL", confidence: 0.60 }, // ties → neutral
      ]),
    );
    expect(r.details?.pro_clusters).toBe(2);
    expect(r.details?.anti_clusters).toBe(0);
    const breakdown = r.details?.cluster_breakdown as Record<string, { vote: string }>;
    expect(breakdown["event"]?.vote).toBe("neutral");
  });
});

describe("signalAgreementGate — score monotonicity in independent cluster count", () => {
  it("score is non-decreasing as distinct pro clusters increase 1→7", () => {
    let prev = -Infinity;
    const seen: number[] = [];
    for (let n = 1; n <= ALL_CLUSTERS.length; n++) {
      const r = signalAgreementGate(mkCtx(proClusters(n)));
      expect(r.score).toBeGreaterThanOrEqual(prev);
      expect(r.details?.pro_clusters).toBe(n);
      prev = r.score;
      seen.push(r.score);
    }
    // Buckets: 1-2 → 0.4, 3-4 → 0.7, 5+ → 1.0
    expect(seen).toEqual([0.4, 0.4, 0.7, 0.7, 1.0, 1.0, 1.0]);
  });

  it("action severity is monotonic: REDUCE_SIZE for 1-4, CONTINUE for 5+", () => {
    for (let n = 1; n <= 4; n++) {
      expect(signalAgreementGate(mkCtx(proClusters(n))).action).toBe("REDUCE_SIZE");
    }
    for (let n = 5; n <= ALL_CLUSTERS.length; n++) {
      expect(signalAgreementGate(mkCtx(proClusters(n))).action).toBe("CONTINUE");
    }
  });

  it("crossing a bucket boundary changes the score upward, never downward", () => {
    const two = signalAgreementGate(mkCtx(proClusters(2))).score;
    const three = signalAgreementGate(mkCtx(proClusters(3))).score;
    const four = signalAgreementGate(mkCtx(proClusters(4))).score;
    const five = signalAgreementGate(mkCtx(proClusters(5))).score;
    expect(three).toBeGreaterThan(two);
    expect(four).toBe(three); // same bucket
    expect(five).toBeGreaterThan(four);
  });
});

describe("signalAgreementGate — empty / neutral / reject edges", () => {
  it("undefined metadata → neutral pass (0.7)", () => {
    const ctx = mkCtx([]);
    const stripped: DecisionContext = {
      ...ctx,
      proposal: { ...ctx.proposal, metadata: undefined },
    };
    const r = signalAgreementGate(stripped);
    expect(r.action).toBe("CONTINUE");
    expect(r.status).toBe("pass");
    expect(r.score).toBe(0.7);
  });

  it("signals present but not an array → neutral pass (0.7)", () => {
    const ctx = mkCtx([]);
    const bad: DecisionContext = {
      ...ctx,
      proposal: { ...ctx.proposal, metadata: { signals: "not-an-array" as never } },
    };
    const r = signalAgreementGate(bad);
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(0.7);
    expect(r.reason).toMatch(/no multi-source/);
  });

  it("confidence exactly at minConfidence (0.50) is KEPT (boundary inclusive)", () => {
    const r = signalAgreementGate(
      mkCtx([{ cluster: "price-action", direction: "BUY", confidence: 0.5 }]),
    );
    // 0.5 is NOT below 0.5 → it counts → 1 valid cluster → weak pass
    expect(r.score).toBe(0.4);
    expect(r.details?.signal_count).toBe(1);
  });

  it("a single signal one tick below minConfidence is dropped → low neutral pass", () => {
    const r = signalAgreementGate(
      mkCtx([{ cluster: "price-action", direction: "BUY", confidence: 0.4999 }]),
    );
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(0.5);
    expect(r.reason).toMatch(/none cleared/);
    expect((r.details as { rawCount: number }).rawCount).toBe(1);
  });

  it("non-finite confidences (Infinity / NaN) are filtered out", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: Infinity } as never,
        { cluster: "volatility", direction: "BUY", confidence: NaN } as never,
        { cluster: "event", direction: "BUY", confidence: 0.7 },
      ]),
    );
    expect(r.details?.signal_count).toBe(1); // only the 0.7 survives
    expect(r.details?.pro_clusters).toBe(1);
  });

  it("reject score and status are pinned to (0, fail) on a no-support reject", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "SELL", confidence: 0.55 },
        { cluster: "volatility", direction: "SELL", confidence: 0.55 },
      ]),
    );
    expect(r.action).toBe("REJECT");
    expect(r.status).toBe("fail");
    expect(r.score).toBe(0);
  });

  it("strong opposite cluster vetoes even with more pro clusters present", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.65 },
        { cluster: "volatility", direction: "BUY", confidence: 0.64 },
        { cluster: "microstructure", direction: "BUY", confidence: 0.63 },
        { cluster: "smart-money", direction: "SELL", confidence: 0.80 }, // strong opposite
      ]),
    );
    expect(r.action).toBe("REJECT");
    expect(r.status).toBe("fail");
    expect(r.details?.strong_opposite).toBe(1);
    expect(r.details?.pro_clusters).toBe(3);
  });
});

describe("signalAgreementGate — output invariants", () => {
  it("score is always within [0,1] across a fuzzed seeded input space", () => {
    const rand = makeLcg(0xC0FFEE);
    for (let trial = 0; trial < 200; trial++) {
      const count = Math.floor(rand() * 8); // 0..7 signals
      const signals: StrategySignal[] = [];
      for (let i = 0; i < count; i++) {
        signals.push({
          cluster: ALL_CLUSTERS[Math.floor(rand() * ALL_CLUSTERS.length)],
          direction: rand() < 0.5 ? "BUY" : "SELL",
          confidence: rand(), // [0,1)
        });
      }
      const side = rand() < 0.5 ? "BUY" : "SELL";
      const r = signalAgreementGate(mkCtx(signals, side));
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(["CONTINUE", "REDUCE_SIZE", "REJECT"]).toContain(r.action);
      expect(["pass", "fail", "partial"]).toContain(r.status);
    }
  });

  it("pro_clusters never exceeds the number of distinct clusters present", () => {
    const rand = makeLcg(0x1234);
    for (let trial = 0; trial < 100; trial++) {
      const count = Math.floor(rand() * 8);
      const signals: StrategySignal[] = [];
      const distinct = new Set<SignalCluster>();
      for (let i = 0; i < count; i++) {
        const cluster = ALL_CLUSTERS[Math.floor(rand() * ALL_CLUSTERS.length)];
        distinct.add(cluster);
        signals.push({ cluster, direction: "BUY", confidence: 0.55 + rand() * 0.4 });
      }
      const r = signalAgreementGate(mkCtx(signals));
      const pro = (r.details?.pro_clusters as number | undefined) ?? 0;
      const anti = (r.details?.anti_clusters as number | undefined) ?? 0;
      // pro + anti + neutral == distinct clusters; pro alone <= distinct.
      expect(pro).toBeLessThanOrEqual(distinct.size);
      expect(pro + anti).toBeLessThanOrEqual(distinct.size);
    }
  });

  it("CONTINUE/REDUCE outcomes carry a positive score; REJECT carries zero", () => {
    const rand = makeLcg(0x99);
    for (let trial = 0; trial < 100; trial++) {
      const count = 1 + Math.floor(rand() * 7);
      const signals: StrategySignal[] = Array.from({ length: count }, () => ({
        cluster: ALL_CLUSTERS[Math.floor(rand() * ALL_CLUSTERS.length)],
        direction: rand() < 0.7 ? "BUY" : "SELL",
        confidence: 0.5 + rand() * 0.5,
      }));
      const r = signalAgreementGate(mkCtx(signals));
      if (r.action === "REJECT") {
        expect(r.score).toBe(0);
      } else {
        expect(r.score).toBeGreaterThan(0);
      }
    }
  });
});

describe("signalAgreementGate — determinism & symmetry", () => {
  it("repeated calls on the same input are byte-identical", () => {
    const signals = proClusters(3, 0.65);
    const a = signalAgreementGate(mkCtx(signals));
    const b = signalAgreementGate(mkCtx(signals));
    expect(snap(a)).toBe(snap(b));
  });

  it("does not mutate the input signals array or its entries", () => {
    const signals: StrategySignal[] = [
      { cluster: "price-action", direction: "BUY", confidence: 0.8 },
      { cluster: "volatility", direction: "SELL", confidence: 0.6 },
    ];
    const before = JSON.stringify(signals);
    signalAgreementGate(mkCtx(signals));
    expect(JSON.stringify(signals)).toBe(before);
  });

  it("reordering signals does not change the outcome (order-invariance)", () => {
    const base: StrategySignal[] = [
      { cluster: "price-action", direction: "BUY", confidence: 0.62 },
      { cluster: "volatility", direction: "BUY", confidence: 0.66 },
      { cluster: "microstructure", direction: "BUY", confidence: 0.61 },
      { cluster: "smart-money", direction: "SELL", confidence: 0.55 },
    ];
    const original = signalAgreementGate(mkCtx(base));
    // Deterministic shuffle via seeded LCG (Fisher-Yates).
    const rand = makeLcg(0xABCD);
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const reordered = signalAgreementGate(mkCtx(shuffled));
    expect(reordered.action).toBe(original.action);
    expect(reordered.score).toBe(original.score);
    expect(reordered.details?.pro_clusters).toBe(original.details?.pro_clusters);
    expect(reordered.details?.anti_clusters).toBe(original.details?.anti_clusters);
  });

  it("BUY and SELL proposals are symmetric when all signals flip direction", () => {
    const buySignals: StrategySignal[] = [
      { cluster: "price-action", direction: "BUY", confidence: 0.7 },
      { cluster: "volatility", direction: "BUY", confidence: 0.68 },
      { cluster: "event", direction: "SELL", confidence: 0.6 },
    ];
    const sellSignals: StrategySignal[] = buySignals.map((s) => ({
      ...s,
      direction: s.direction === "BUY" ? "SELL" : "BUY",
    }));
    const buy = signalAgreementGate(mkCtx(buySignals, "BUY"));
    const sell = signalAgreementGate(mkCtx(sellSignals, "SELL"));
    // Flipping both proposal side and every signal must yield identical verdicts.
    expect(sell.score).toBe(buy.score);
    expect(sell.action).toBe(buy.action);
    expect(sell.details?.pro_clusters).toBe(buy.details?.pro_clusters);
    expect(sell.details?.anti_clusters).toBe(buy.details?.anti_clusters);
  });
});

describe("signalAgreementGate — options thresholds", () => {
  it("raising minConfidence prunes more signals (monotone in filtering)", () => {
    const signals: StrategySignal[] = [
      { cluster: "price-action", direction: "BUY", confidence: 0.55 },
      { cluster: "volatility", direction: "BUY", confidence: 0.65 },
      { cluster: "event", direction: "BUY", confidence: 0.75 },
    ];
    const low = signalAgreementGate(mkCtx(signals), { minConfidence: 0.5 });
    const mid = signalAgreementGate(mkCtx(signals), { minConfidence: 0.6 });
    const high = signalAgreementGate(mkCtx(signals), { minConfidence: 0.7 });
    expect(low.details?.pro_clusters).toBe(3);
    expect(mid.details?.pro_clusters).toBe(2);
    expect(high.details?.pro_clusters).toBe(1);
  });

  it("lowering rejectOnConflictConfidence makes a borderline opposite trip a veto", () => {
    const signals: StrategySignal[] = [
      { cluster: "price-action", direction: "BUY", confidence: 0.8 },
      { cluster: "volatility", direction: "BUY", confidence: 0.78 },
      { cluster: "smart-money", direction: "SELL", confidence: 0.62 },
    ];
    const lenient = signalAgreementGate(mkCtx(signals), { rejectOnConflictConfidence: 0.7 });
    const strict = signalAgreementGate(mkCtx(signals), { rejectOnConflictConfidence: 0.6 });
    expect(lenient.action).toBe("REDUCE_SIZE"); // 0.62 < 0.7 → not strong
    expect(strict.action).toBe("REJECT"); // 0.62 >= 0.6 → strong opposite
  });

  it("defaults apply when opts is omitted (0.70 conflict / 0.50 min)", () => {
    // 0.69 opposite stays under default reject threshold → no veto.
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.8 },
        { cluster: "volatility", direction: "BUY", confidence: 0.78 },
        { cluster: "smart-money", direction: "SELL", confidence: 0.69 },
      ]),
    );
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.details?.strong_opposite).toBe(0);
    expect(r.details?.anti_clusters).toBe(1);
  });
});
