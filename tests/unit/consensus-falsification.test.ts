import { describe, it, expect } from "vitest";
import { falsifyConsensus } from "@/lib/wallets/consensus-falsification";
import type { ConsensusSignal } from "@/lib/wallets/consensus";
import type { ResolvedMarket } from "@/lib/wallets/copy-backtest";

const sig = (key: string, direction: string, avgPrice: number): ConsensusSignal => ({
  marketKey: key, direction, wallets: [], combinedTrust: 3, combinedUsd: 300, walletCount: 3, effectiveWallets: 3,
  clusterIds: ["a", "b", "c"], avgPrice, windowStart: "t0", windowEnd: "t1",
});
const mkt = (key: string, winningIndex: number): [string, ResolvedMarket] => [key, { conditionId: key, winningIndex, outcomePayouts: winningIndex === 0 ? [1, 0] : [0, 1], clobTokenIds: ["y", "n"] }];

describe("falsifyConsensus — balanced control (skeptic random/flip + advocate implied-prob)", () => {
  it("REAL EDGE: consensus right 80% at a 0.50 price beats BOTH random direction AND fair odds", () => {
    const signals: ConsensusSignal[] = [], resolved = new Map<string, ResolvedMarket>();
    for (let i = 0; i < 10; i++) { signals.push(sig(`m${i}`, "yes", 0.5)); resolved.set(...mkt(`m${i}`, i < 8 ? 0 : 1)); } // 8 of 10 resolve YES (dir right)
    const f = falsifyConsensus(signals, resolved, { minDistinctSignals: 5 }, 500);
    expect(f.realWinRate).toBeCloseTo(0.8, 5);
    expect(f.impliedWinRate).toBeCloseTo(0.5, 5);
    expect(f.edgeVsImplied).toBeGreaterThan(0.2);     // beats the price by ~30pts
    expect(f.randomP).toBeLessThan(0.05);             // beats coin-flip direction
    expect(f.flippedPnlPct).toBeLessThan(f.realPnlPct); // betting opposite is much worse
    expect(f.rating).toBe("real_edge");
  });

  it("NO EDGE / BETA: 50% right at a 0.50 price — random direction does as well", () => {
    const signals: ConsensusSignal[] = [], resolved = new Map<string, ResolvedMarket>();
    for (let i = 0; i < 10; i++) { signals.push(sig(`m${i}`, "yes", 0.5)); resolved.set(...mkt(`m${i}`, i % 2)); } // alternating → 50% right
    const f = falsifyConsensus(signals, resolved, { minDistinctSignals: 5 }, 500);
    expect(f.realWinRate).toBeCloseTo(0.5, 5);
    expect(f.randomP).toBeGreaterThan(0.1);           // a coin-flip does just as well
    expect(f.rating).toBe("no_edge_beta");
  });

  it("FAVORITES-style: high win rate that only matches the price is NOT a real edge", () => {
    // all at 0.90 price, 9 of 10 resolve YES → win rate 90% ≈ implied 90%, PnL ~0 after slippage
    const signals: ConsensusSignal[] = [], resolved = new Map<string, ResolvedMarket>();
    for (let i = 0; i < 10; i++) { signals.push(sig(`m${i}`, "yes", 0.9)); resolved.set(...mkt(`m${i}`, i < 9 ? 0 : 1)); }
    const f = falsifyConsensus(signals, resolved, { minDistinctSignals: 5 }, 500);
    expect(f.impliedWinRate).toBeCloseTo(0.9, 5);
    expect(f.edgeVsImplied).toBeLessThan(0.03);        // win rate ≈ price → no edge vs fair odds
    expect(f.rating).not.toBe("real_edge");
  });

  it("insufficient_data when too few scorable signals", () => {
    const signals = [sig("m0", "yes", 0.5), sig("m1", "yes", 0.5)];
    const resolved = new Map([mkt("m0", 0), mkt("m1", 0)]);
    expect(falsifyConsensus(signals, resolved, { minDistinctSignals: 5 }, 100).rating).toBe("insufficient_data");
  });
});
