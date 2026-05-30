/**
 * Tests for the 4 gen-2 heuristic evaluators added to research-loop.ts:
 *   - near-resolution-scrape (Nereid)
 *   - cross-timeframe-spread-trade (Lyra)
 *   - orderbook-imbalance-watch (Pulse, research-only)
 *   - consensus-tail-follow (Hydra)
 *
 * Each reads exclusively from AgentContext signal arrays (no upstream signal
 * dependency). We synthesize the context and assert the evaluator produces
 * the expected research-note summary.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentContext } from "@/lib/agents/context";
import type { Evaluator } from "@/lib/agents/types";

function emptyContext(): AgentContext {
  return {
    builtAt: new Date().toISOString(),
    agentId: 1,
    strategyId: 1,
    capsules: [],
    activeCapsules: [],
    riskLimits: {} as any,
    killSwitch: { halted: false, reason: "", haltedAt: null, registeredBrokers: [] },
    lastRejection: null,
    recentOrderEvents: [],
    recentRejectCounts: {},
    recentEvolution: [],
    lastBacktest: null,
    performance: [],
    recentTypologies: [],
    recentConsensusSignals: [],
    recentTradeClassifications: [],
    recentStrategyOpportunities: [],
  };
}

function callEval(name: string, evaluators: Record<string, Evaluator>, context: AgentContext) {
  const e = evaluators[name];
  if (!e) throw new Error(`evaluator not exported: ${name}`);
  return e({ current: {} as any, signals: [] as any, context });
}

describe("gen-2 evaluators", () => {
  let evaluators: Record<string, Evaluator>;
  beforeAll(async () => {
    const mod = await import("../../scripts/research-loop.ts");
    evaluators = (mod as any).evaluators;
  });

  it("near-resolution-scrape returns null when no NRS opportunities exist", async () => {
    const v = await callEval("near-resolution-scrape", evaluators, emptyContext());
    expect(v).toBeNull();
  });

  it("near-resolution-scrape summarizes NRS opportunities and counts high-yield", async () => {
    const ctx = emptyContext();
    ctx.recentStrategyOpportunities = [
      { type: "near-resolution", marketKey: "m1", marketTitle: "BTC reach $90K?", side: "NO", edge: 0.03, annualizedEdge: 0.78, reason: "test", ts: new Date().toISOString() },
      { type: "near-resolution", marketKey: "m2", marketTitle: "BTC reach $85K?", side: "NO", edge: 0.02, annualizedEdge: 0.4, reason: "test", ts: new Date().toISOString() },
      { type: "cross-timeframe-spread", marketKey: "m3", edge: 0.05, reason: "z=3.5", ts: new Date().toISOString() }, // wrong type — should be ignored
    ];
    const v = await callEval("near-resolution-scrape", evaluators, ctx);
    expect(v?.kind).toBe("research-note");
    if (v?.kind === "research-note") {
      expect(v.topic).toContain("Nereid");
      expect(v.topic).toContain("2 NRS");
      expect(v.topic).toContain("1 ≥50%");
      expect(v.tags).toContain("nereid-scrape");
    }
  });

  it("cross-timeframe-spread-trade returns null when no CTS signals exist", async () => {
    const v = await callEval("cross-timeframe-spread-trade", evaluators, emptyContext());
    expect(v).toBeNull();
  });

  it("cross-timeframe-spread-trade summarizes CTS signals + notes no auto-executor", async () => {
    const ctx = emptyContext();
    ctx.recentStrategyOpportunities = [
      { type: "cross-timeframe-spread", marketKey: "cts-1", edge: 0.08, reason: "z=4.2", ts: new Date().toISOString() },
      { type: "cross-timeframe-spread", marketKey: "cts-2", edge: 0.05, reason: "z=3.1", ts: new Date().toISOString() },
    ];
    const v = await callEval("cross-timeframe-spread-trade", evaluators, ctx);
    expect(v?.kind).toBe("research-note");
    if (v?.kind === "research-note") {
      expect(v.topic).toContain("Lyra");
      expect(v.topic).toContain("2 CTS");
      expect(v.body).toContain("no auto-executor");
      expect(v.tags).toContain("lyra-cross-timeframe");
    }
  });

  it("orderbook-imbalance-watch breaks down BUY vs SELL signals", async () => {
    const ctx = emptyContext();
    ctx.recentStrategyOpportunities = [
      { type: "orderbook-imbalance", marketKey: "obi-1", side: "BUY", edge: 0.01, signalStrength: 0.8, reason: "bid 4:1", ts: new Date().toISOString() },
      { type: "orderbook-imbalance", marketKey: "obi-2", side: "BUY", edge: 0.01, signalStrength: 0.7, reason: "bid 3:1", ts: new Date().toISOString() },
      { type: "orderbook-imbalance", marketKey: "obi-3", side: "SELL", edge: 0.01, signalStrength: 0.75, reason: "ask 3:1", ts: new Date().toISOString() },
    ];
    const v = await callEval("orderbook-imbalance-watch", evaluators, ctx);
    expect(v?.kind).toBe("research-note");
    if (v?.kind === "research-note") {
      expect(v.topic).toContain("2 bid-heavy");
      expect(v.topic).toContain("1 ask-heavy");
      expect(v.tags).toContain("research-only");
    }
  });

  it("consensus-tail-follow summarizes signals and surfaces strong-effective ones", async () => {
    const ctx = emptyContext();
    ctx.recentConsensusSignals = [
      { marketKey: "m1", direction: "YES", effectiveWallets: 4, combinedTrust: 12, combinedUsd: 5000, avgPrice: 0.55, ts: new Date().toISOString() },
      { marketKey: "m2", direction: "NO", effectiveWallets: 2, combinedTrust: 5, combinedUsd: 2000, avgPrice: 0.42, ts: new Date().toISOString() },
      { marketKey: "m3", direction: "YES", effectiveWallets: 5, combinedTrust: 18, combinedUsd: 12000, avgPrice: 0.6, ts: new Date().toISOString() },
    ];
    const v = await callEval("consensus-tail-follow", evaluators, ctx);
    expect(v?.kind).toBe("research-note");
    if (v?.kind === "research-note") {
      expect(v.topic).toContain("Hydra");
      expect(v.topic).toContain("3 consensus");
      expect(v.topic).toContain("2 ≥3");
      // Top by trust should be the trust=18 one (m3)
      expect(v.body).toContain("m3");
      expect(v.tags).toContain("hydra-consensus");
    }
  });

  it("each gen-2 evaluator returns null when its specific signal array is empty", async () => {
    const ctx = emptyContext();
    // Only consensus signals exist; the other 3 evaluators should return null
    ctx.recentConsensusSignals = [
      { marketKey: "m1", direction: "YES", effectiveWallets: 4, combinedTrust: 12, combinedUsd: 5000, avgPrice: 0.55, ts: new Date().toISOString() },
    ];
    expect(await callEval("near-resolution-scrape", evaluators, ctx)).toBeNull();
    expect(await callEval("cross-timeframe-spread-trade", evaluators, ctx)).toBeNull();
    expect(await callEval("orderbook-imbalance-watch", evaluators, ctx)).toBeNull();
    expect(await callEval("consensus-tail-follow", evaluators, ctx)).not.toBeNull();
  });
});
