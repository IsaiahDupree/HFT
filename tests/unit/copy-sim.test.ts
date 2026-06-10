import { describe, it, expect } from "vitest";
import { equityFromReturns, simulateCopy, equalWeightLongReturn, signMatchedReturn, sparkline, type SimPeriod } from "@/lib/exec/copy-sim";

describe("equityFromReturns — compound a real bankroll", () => {
  it("a steady +1%/period grows $10k by 1.01^n", () => {
    const e = equityFromReturns(Array(10).fill(0.01), 10_000);
    expect(e.finalUsd).toBeCloseTo(10_000 * 1.01 ** 10, 4);
    expect(e.equityCurve).toHaveLength(11); // start + 10 periods
    expect(e.hitRate).toBe(1);
    expect(e.stoppedOut).toBe(false);
  });
  it("tracks max drawdown felt along the way", () => {
    const e = equityFromReturns([0.1, -0.5, 0.1], 1000); // 1100 → 550 → 605; peak 1100, trough 550 → 50% DD
    expect(e.maxDrawdown).toBeCloseTo(0.5, 6);
  });
  it("stops trading once the drawdown stop is breached (equity goes flat)", () => {
    const e = equityFromReturns([-0.25, 0.5, 0.5], 1000, 0.2); // −25% breaches 20% stop → rest ignored
    expect(e.stoppedOut).toBe(true);
    expect(e.finalUsd).toBeCloseTo(750, 6); // frozen after the stop
  });
});

describe("simulateCopy — net-book bankroll sim with cost + fraction", () => {
  const period = (ret: number): SimPeriod => ({ weights: { BTC: 1 }, rets: { BTC: ret }, nextWeights: { BTC: 1 } });

  it("a cost-free, no-rebalance long book compounds the bankroll at copyFraction × mtm", () => {
    const r = simulateCopy([period(0.02), period(0.02)], { startUsd: 10_000, copyFraction: 1, costBps: 0 });
    expect(r.finalUsd).toBeCloseTo(10_000 * 1.02 ** 2, 4);
    expect(r.costDrag).toBe(0);
    expect(r.totalReturn).toBeCloseTo(1.02 ** 2 - 1, 6);
  });
  it("copyFraction scales exposure — half fraction, ~half the return", () => {
    const full = simulateCopy([period(0.02)], { startUsd: 10_000, copyFraction: 1, costBps: 0 });
    const half = simulateCopy([period(0.02)], { startUsd: 10_000, copyFraction: 0.5, costBps: 0 });
    expect(half.totalReturn).toBeCloseTo(full.totalReturn / 2, 6);
  });
  it("rebalance cost drags net below gross when the book flips each period", () => {
    const flip: SimPeriod[] = [
      { weights: { BTC: 1 }, rets: { BTC: 0.01 }, nextWeights: { BTC: -1 } },
      { weights: { BTC: -1 }, rets: { BTC: -0.01 }, nextWeights: { BTC: 1 } },
    ];
    const r = simulateCopy(flip, { startUsd: 10_000, copyFraction: 1, costBps: 50 });
    expect(r.costDrag).toBeGreaterThan(0);
    expect(r.finalUsd).toBeLessThan(10_000 * (1 + r.grossReturn)); // costs ate into it
  });
  it("empty period stream → bankroll unchanged", () => {
    const r = simulateCopy([], { startUsd: 5000, copyFraction: 1, costBps: 10 });
    expect(r.finalUsd).toBe(5000);
    expect(r.nPeriods).toBe(0);
  });
});

describe("equalWeightLongReturn — the beta baseline", () => {
  it("averages the per-coin returns, all long", () => {
    expect(equalWeightLongReturn({ BTC: 0.1, ETH: -0.02, SOL: 0.04 })).toBeCloseTo((0.1 - 0.02 + 0.04) / 3, 9);
  });
  it("no coins → 0", () => {
    expect(equalWeightLongReturn({})).toBe(0);
  });
  it("a long-only wallet that just rode the market does NOT beat the baseline", () => {
    // wallet weight 100% BTC; baseline = equal-long of the same single coin → identical → alpha 0
    const rets = { BTC: 0.05 };
    const walletRet = 1 * rets.BTC;             // simulateCopy mtm with weight 1
    expect(walletRet - equalWeightLongReturn(rets)).toBeCloseTo(0, 9);
  });
});

describe("signMatchedReturn — the sign-aware benchmark (fixes the −2×bench artifact)", () => {
  it("carries the wallet's SIGN, so a short book's baseline profits when the coin falls", () => {
    // short BTC (weight −0.6), long ETH (weight +0.4); BTC −10%, ETH +5%
    const w = { BTC: -0.6, ETH: 0.4 }, rets = { BTC: -0.1, ETH: 0.05 };
    // equal-weight sign-matched: (sign(−)*−0.1 + sign(+)*0.05)/2 = (+0.1 + 0.05)/2 = +0.075
    expect(signMatchedReturn(w, rets)).toBeCloseTo(0.075, 9);
    // the sign-STRIPPED long-only baseline would (wrongly) be (−0.1+0.05)/2 = −0.025
    expect(equalWeightLongReturn(rets)).toBeCloseTo(-0.025, 9);
  });
  it("for a pure long book it equals the long-only baseline (no artifact to fix)", () => {
    const w = { BTC: 0.5, ETH: 0.5 }, rets = { BTC: 0.1, ETH: -0.02 };
    expect(signMatchedReturn(w, rets)).toBeCloseTo(equalWeightLongReturn(rets), 9);
  });
  it("THE FIX: a net-short book no longer manufactures ±2×bench alpha vs its sign-matched baseline", () => {
    // wallet fully short BTC (weight −1), market falls 10% → copy gains +10%
    const w = { BTC: -1 }, rets = { BTC: -0.1 };
    const copy = w.BTC * rets.BTC; // signed book MTM = (−1)(−0.1) = +0.10
    // sign-stripped baseline = −0.10 → fake alpha +0.20 (the artifact); sign-matched = +0.10 → alpha 0 (honest)
    expect(copy - equalWeightLongReturn(rets)).toBeCloseTo(0.2, 9);   // the BUG
    expect(copy - signMatchedReturn(w, rets)).toBeCloseTo(0, 9);      // the FIX
  });
});

describe("sparkline", () => {
  it("renders a non-empty bar string for a curve", () => {
    expect(sparkline([1, 2, 3, 4, 5]).length).toBeGreaterThan(0);
    expect(sparkline([1])).toBe("");
  });
});
