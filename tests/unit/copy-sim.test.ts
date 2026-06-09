import { describe, it, expect } from "vitest";
import { equityFromReturns, simulateCopy, sparkline, type SimPeriod } from "@/lib/exec/copy-sim";

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

describe("sparkline", () => {
  it("renders a non-empty bar string for a curve", () => {
    expect(sparkline([1, 2, 3, 4, 5]).length).toBeGreaterThan(0);
    expect(sparkline([1])).toBe("");
  });
});
