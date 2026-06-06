import { describe, it, expect } from "vitest";
import { riskAdjustedMultiplier, applyRiskSizing } from "@/lib/decision/risk-sizing";

describe("riskAdjustedMultiplier — continuous risk-budget size scaling (only reduces, never martingales)", () => {
  it("full budget, no constraints → multiplier 1", () => {
    expect(riskAdjustedMultiplier({ sizeUsd: 100 }).multiplier).toBe(1);
  });
  it("DRAWDOWN: shrinks toward 0 as today's losses approach the daily cap", () => {
    expect(riskAdjustedMultiplier({ sizeUsd: 100, dailyPnlUsd: -50, dailyLossCapUsd: 100 }).multiplier).toBeCloseTo(0.5, 6);
    expect(riskAdjustedMultiplier({ sizeUsd: 100, dailyPnlUsd: -100, dailyLossCapUsd: 100 }).multiplier).toBe(0); // at cap → no size
    expect(riskAdjustedMultiplier({ sizeUsd: 100, dailyPnlUsd: +30, dailyLossCapUsd: 100 }).multiplier).toBe(1); // winning → no reduction
  });
  it("CORRELATION: shrinks as correlated exposure fills the cap", () => {
    expect(riskAdjustedMultiplier({ sizeUsd: 100, correlatedExposureUsd: 750, maxCorrelatedExposureUsd: 1000 }).multiplier).toBeCloseTo(0.25, 6);
  });
  it("LIQUIDITY: caps size at a fraction of depth", () => {
    // size $5000, depth $20k, 10% cap → max $2000 → multiplier 0.4
    expect(riskAdjustedMultiplier({ sizeUsd: 5000, liquidityUsd: 20_000 }).multiplier).toBeCloseTo(0.4, 6);
    expect(riskAdjustedMultiplier({ sizeUsd: 100, liquidityUsd: 1_000_000 }).multiplier).toBe(1); // tiny vs deep → no cap
  });
  it("constraints COMPOUND (product)", () => {
    const m = riskAdjustedMultiplier({ sizeUsd: 100, dailyPnlUsd: -50, dailyLossCapUsd: 100, correlatedExposureUsd: 500, maxCorrelatedExposureUsd: 1000 }).multiplier;
    expect(m).toBeCloseTo(0.5 * 0.5, 6); // drawdown 0.5 × correlation 0.5
  });
  it("NEVER exceeds 1 (no martingale / no scale-up)", () => {
    expect(riskAdjustedMultiplier({ sizeUsd: 100, dailyPnlUsd: 9999, dailyLossCapUsd: 100, liquidityUsd: 1e9 }).multiplier).toBeLessThanOrEqual(1);
  });
});

describe("applyRiskSizing", () => {
  it("scales the base size by the multiplier", () => {
    expect(applyRiskSizing(1000, { sizeUsd: 1000, dailyPnlUsd: -50, dailyLossCapUsd: 100 })).toBe(500);
  });
});
