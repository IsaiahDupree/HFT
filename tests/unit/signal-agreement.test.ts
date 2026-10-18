/**
 * Tests for the signal-agreement gate (Phase 14).
 *
 * Covers:
 *   - Empty signals → neutral pass (0.7)
 *   - Below minConfidence → filtered + pass with low score
 *   - 5+ pro clusters → full pass (1.0)
 *   - 3-4 pro clusters → reduce (0.7)
 *   - 1-2 pro clusters → reduce (0.4)
 *   - 0 pro clusters → REJECT
 *   - Strong opposite cluster → REJECT (overrides pro count)
 *   - Same cluster appears multiple times → counts ONCE
 *   - Mixed pro+anti within a cluster → vote uses max-confidence diff
 *   - Custom rejectOnConflictConfidence + minConfidence
 */
import { describe, expect, it } from "vitest";
import {
  signalAgreementGate,
  type StrategySignal,
} from "@/lib/decision/gates/signal-agreement";
import type { DecisionContext } from "@/lib/decision/types";

function mkCtx(signals: StrategySignal[], side: "BUY" | "SELL" = "BUY"): DecisionContext {
  return {
    agentId: 1,
    capsuleId: "cap-x",
    strategyKind: "test",
    proposal: {
      venue: "polymarket",
      symbol: "0xCOND",
      side,
      sizeUsd: 2,
      price: 0.52,
      conditionId: "0xCOND",
      metadata: { signals },
    },
    ts: "2026-05-28T00:00:00Z",
  };
}

describe("signalAgreementGate — empty / invalid input", () => {
  it("no signals attached → neutral pass (0.7)", () => {
    const r = signalAgreementGate({ ...mkCtx([]), proposal: { ...mkCtx([]).proposal, metadata: {} } });
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(0.7);
    expect(r.reason).toMatch(/no multi-source/);
  });

  it("signals array empty → neutral pass", () => {
    const r = signalAgreementGate(mkCtx([]));
    expect(r.action).toBe("CONTINUE");
  });

  it("all signals below minConfidence → pass with low score", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.30 },
        { cluster: "volatility", direction: "BUY", confidence: 0.40 },
      ]),
    );
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(0.5);
    expect(r.reason).toMatch(/none cleared/);
  });

  it("ignores malformed signal entries", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80 },
        // Invalid entries below — should be silently filtered
        { cluster: "", direction: "BUY", confidence: 0.80 } as never,
        null as never,
        { cluster: "volatility", direction: "BUY", confidence: NaN } as never,
      ]),
    );
    expect(r.score).toBe(0.4); // 1 valid cluster
    expect(r.details?.signal_count).toBe(1);
  });
});

describe("signalAgreementGate — cluster counting", () => {
  it("5+ distinct pro clusters → full conviction (1.0)", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80 },
        { cluster: "volatility", direction: "BUY", confidence: 0.75 },
        { cluster: "microstructure", direction: "BUY", confidence: 0.65 },
        { cluster: "cross-venue", direction: "BUY", confidence: 0.70 },
        { cluster: "smart-money", direction: "BUY", confidence: 0.80 },
      ]),
    );
    expect(r.action).toBe("CONTINUE");
    expect(r.score).toBe(1.0);
    expect(r.details?.pro_clusters).toBe(5);
  });

  it("3-4 pro clusters → modest conviction (REDUCE_SIZE, 0.7)", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80 },
        { cluster: "volatility", direction: "BUY", confidence: 0.75 },
        { cluster: "microstructure", direction: "BUY", confidence: 0.65 },
      ]),
    );
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.score).toBe(0.7);
  });

  it("1-2 pro clusters → weak conviction (REDUCE_SIZE, 0.4)", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80 },
      ]),
    );
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.score).toBe(0.4);
  });

  it("0 pro clusters (all anti) → REJECT", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "SELL", confidence: 0.60 },
        { cluster: "volatility", direction: "SELL", confidence: 0.60 },
      ]),
    );
    expect(r.action).toBe("REJECT");
    expect(r.reason).toMatch(/no cluster supports/);
  });

  it("multiple signals in SAME cluster count as ONE vote", () => {
    // 5 signals from same cluster — should count as 1 pro cluster
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80, source: "markov" },
        { cluster: "price-action", direction: "BUY", confidence: 0.85, source: "momentum" },
        { cluster: "price-action", direction: "BUY", confidence: 0.75, source: "trend-MA" },
        { cluster: "price-action", direction: "BUY", confidence: 0.70, source: "rsi" },
        { cluster: "price-action", direction: "BUY", confidence: 0.65, source: "macd" },
      ]),
    );
    // 5 same-cluster signals → 1 pro cluster → weak (0.4)
    expect(r.details?.pro_clusters).toBe(1);
    expect(r.score).toBe(0.4);
  });

  it("mixed pro/anti in same cluster — net vote uses max-confidence delta", () => {
    // pro 0.60 vs anti 0.80 in same cluster → anti wins
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.60 },
        { cluster: "price-action", direction: "SELL", confidence: 0.80 },
        { cluster: "volatility", direction: "BUY", confidence: 0.70 },
      ]),
    );
    // anti is strong (0.80 ≥ 0.70 rejectOnConflict) → REJECT
    expect(r.action).toBe("REJECT");
  });
});

describe("signalAgreementGate — strong opposite", () => {
  it("REJECT when any cluster has strong opposite signal (default 0.70)", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.65 },
        { cluster: "volatility", direction: "BUY", confidence: 0.60 },
        { cluster: "smart-money", direction: "SELL", confidence: 0.85 }, // STRONG OPPOSITE
      ]),
    );
    expect(r.action).toBe("REJECT");
    expect(r.reason).toMatch(/STRONG opposite/);
  });

  it("opposite cluster below threshold does NOT trigger reject", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.65 },
        { cluster: "volatility", direction: "BUY", confidence: 0.60 },
        { cluster: "smart-money", direction: "SELL", confidence: 0.55 }, // opposite but weak
      ]),
    );
    // 2 pro clusters + 1 anti (weak) → REDUCE, not REJECT
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.details?.pro_clusters).toBe(2);
    expect(r.details?.anti_clusters).toBe(1);
  });

  it("custom rejectOnConflictConfidence makes the threshold stricter / looser", () => {
    // 0.60 anti — wouldn't trip default 0.70 but trips at 0.55
    const ctx = mkCtx([
      { cluster: "price-action", direction: "BUY", confidence: 0.80 },
      { cluster: "smart-money", direction: "SELL", confidence: 0.60 },
    ]);
    expect(signalAgreementGate(ctx, { rejectOnConflictConfidence: 0.70 }).action).toBe("REDUCE_SIZE");
    expect(signalAgreementGate(ctx, { rejectOnConflictConfidence: 0.55 }).action).toBe("REJECT");
  });
});

describe("signalAgreementGate — direction handling", () => {
  it("matches proposal direction (SELL proposal + SELL signals = pro)", () => {
    const r = signalAgreementGate(
      mkCtx(
        [
          { cluster: "price-action", direction: "SELL", confidence: 0.80 },
          { cluster: "volatility", direction: "SELL", confidence: 0.75 },
          { cluster: "microstructure", direction: "SELL", confidence: 0.70 },
        ],
        "SELL",
      ),
    );
    expect(r.action).toBe("REDUCE_SIZE");
    expect(r.score).toBe(0.7);
    expect(r.details?.pro_clusters).toBe(3);
  });
});

describe("signalAgreementGate — details payload", () => {
  it("includes cluster_breakdown for downstream UI", () => {
    const r = signalAgreementGate(
      mkCtx([
        { cluster: "price-action", direction: "BUY", confidence: 0.80 },
        { cluster: "volatility", direction: "BUY", confidence: 0.75 },
      ]),
    );
    expect(r.details?.cluster_breakdown).toBeDefined();
    const breakdown = r.details?.cluster_breakdown as Record<string, { pro: number; anti: number; vote: string }>;
    expect(breakdown["price-action"]?.pro).toBe(0.80);
    expect(breakdown["price-action"]?.vote).toBe("pro");
  });
});
