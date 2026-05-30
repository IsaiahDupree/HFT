import { describe, expect, it } from "vitest";
import { findSingleMarketArbs, kellyFraction, type MarketPair } from "@/lib/polymarket/arb";
import { book, samplePair } from "../helpers/fixtures";

// Helper to build a single candidate row
function candidate(yesAsk: number, yesSize: number, noAsk: number, noSize: number, pair: MarketPair = samplePair) {
  return { pair, yesBook: book([[yesAsk, yesSize]]), noBook: book([[noAsk, noSize]]) };
}

describe("findSingleMarketArbs — basic detection", () => {
  it("finds an arb when YES+NO < $1 - fees", () => {
    const arbs = findSingleMarketArbs([candidate(0.45, 100, 0.45, 100)], { feeBps: 50, minProfitUsd: 0 });
    expect(arbs).toHaveLength(1);
    expect(arbs[0].sumOfAsks).toBeCloseTo(0.9);
    expect(arbs[0].edgeAfterFeesPerShare).toBeGreaterThan(0);
  });

  it("returns empty when YES+NO == $1", () => {
    expect(findSingleMarketArbs([candidate(0.5, 100, 0.5, 100)], { feeBps: 0, minProfitUsd: 0 })).toEqual([]);
  });

  it("returns empty when YES+NO > $1", () => {
    expect(findSingleMarketArbs([candidate(0.6, 100, 0.5, 100)], { feeBps: 0, minProfitUsd: 0 })).toEqual([]);
  });

  it("returns empty when fee buffer exceeds gross edge", () => {
    // 0.95 sum → 0.05 gross edge, 600bps fee = 0.06 → net -0.01
    expect(findSingleMarketArbs([candidate(0.47, 100, 0.48, 100)], { feeBps: 600, minProfitUsd: 0 })).toEqual([]);
  });

  it("respects minProfitUsd (default depth cap 0.5 → 5 shares × 0.05 = $0.25)", () => {
    const arbs = findSingleMarketArbs([candidate(0.47, 10, 0.48, 10)], { feeBps: 0, minProfitUsd: 0.30 });
    expect(arbs).toEqual([]);
  });

  it("caps executable shares at depth × depthCapFraction", () => {
    const arbs = findSingleMarketArbs([candidate(0.4, 100, 0.4, 100)], { feeBps: 0, depthCapFraction: 0.25, minProfitUsd: 0 });
    expect(arbs[0].maxExecutableShares).toBe(25);
  });

  it("uses the smaller side's depth as binding constraint", () => {
    const arbs = findSingleMarketArbs([candidate(0.4, 200, 0.4, 20)], { feeBps: 0, depthCapFraction: 0.5, minProfitUsd: 0 });
    expect(arbs[0].maxExecutableShares).toBe(10); // 0.5 × min(200, 20) = 10
  });

  it("handles missing yes book gracefully", () => {
    const row = { pair: samplePair, yesBook: null, noBook: book([[0.5, 100]]) };
    expect(findSingleMarketArbs([row], {})).toEqual([]);
  });

  it("handles missing no book gracefully", () => {
    const row = { pair: samplePair, yesBook: book([[0.5, 100]]), noBook: null };
    expect(findSingleMarketArbs([row], {})).toEqual([]);
  });

  it("handles empty asks array", () => {
    const row = { pair: samplePair, yesBook: book([]), noBook: book([[0.5, 100]]) };
    expect(findSingleMarketArbs([row], {})).toEqual([]);
  });

  it("handles zero-size top-of-book", () => {
    const row = { pair: samplePair, yesBook: book([[0.45, 0]]), noBook: book([[0.45, 100]]) };
    expect(findSingleMarketArbs([row], {})).toEqual([]);
  });

  it("orders results by qualityScore desc", () => {
    const small = candidate(0.47, 5, 0.47, 5, { ...samplePair, conditionId: "0xSMALL" });
    const big = candidate(0.47, 500, 0.47, 500, { ...samplePair, conditionId: "0xBIG" });
    const arbs = findSingleMarketArbs([small, big], { feeBps: 0, minProfitUsd: 0, depthCapFraction: 1 });
    expect(arbs[0].conditionId).toBe("0xBIG");
  });
});

describe("findSingleMarketArbs — parameterized price grid", () => {
  // Generate (yesAsk, noAsk) combinations across the typical bps space
  const cases: Array<{ yesAsk: number; noAsk: number; feeBps: number; expectArb: boolean }> = [];
  for (const ya of [0.05, 0.15, 0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95]) {
    for (const na of [0.05, 0.15, 0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95]) {
      const sum = ya + na;
      const grossEdge = 1 - sum;
      for (const feeBps of [0, 50, 100, 300]) {
        const feeShare = feeBps / 10_000;
        cases.push({ yesAsk: ya, noAsk: na, feeBps, expectArb: grossEdge - feeShare > 0 });
      }
    }
  }

  it.each(cases)("ask=$yesAsk+$noAsk fee=$feeBps → expectArb=$expectArb", ({ yesAsk, noAsk, feeBps, expectArb }) => {
    const arbs = findSingleMarketArbs([candidate(yesAsk, 100, noAsk, 100)], { feeBps, depthCapFraction: 0.5, minProfitUsd: 0 });
    if (expectArb) {
      expect(arbs.length).toBeGreaterThanOrEqual(1);
      expect(arbs[0].sumOfAsks).toBeCloseTo(yesAsk + noAsk, 5);
    } else {
      expect(arbs).toEqual([]);
    }
  });
});

describe("findSingleMarketArbs — depth sensitivity grid", () => {
  const depths = [1, 5, 10, 50, 100, 500, 1000];
  const fractions = [0.1, 0.25, 0.5, 0.75, 1.0];

  it.each(
    depths.flatMap((d) => fractions.map((f) => ({ depth: d, frac: f, expected: Math.floor(d * f) })))
  )("depth=$depth frac=$frac → executable=$expected", ({ depth, frac, expected }) => {
    const arbs = findSingleMarketArbs([candidate(0.4, depth, 0.4, depth)], { feeBps: 0, depthCapFraction: frac, minProfitUsd: 0 });
    if (expected <= 0) {
      expect(arbs).toEqual([]);
    } else {
      expect(arbs[0].maxExecutableShares).toBe(expected);
    }
  });
});

describe("kellyFraction", () => {
  it.each([
    { p: 0, odds: 1, expected: 0 },
    { p: 1, odds: 1, expected: 0 }, // p ≥ 1 → 0
    { p: 0.5, odds: 0, expected: 0 },
    { p: 0.5, odds: -1, expected: 0 },
  ])("returns 0 for boundary p=$p odds=$odds", ({ p, odds, expected }) => {
    expect(kellyFraction(p, odds)).toBe(expected);
  });

  it("returns positive fraction when EV is positive", () => {
    // p=0.6, odds=1 (2:1 payoff). Kelly = (1*0.6 - 0.4)/1 = 0.2
    // With default 10% exec-failure shrinkage: 0.2 * 0.9 = 0.18
    expect(kellyFraction(0.6, 1, 0.1)).toBeCloseTo(0.18, 5);
  });

  it("returns 0 when EV is negative", () => {
    expect(kellyFraction(0.4, 1, 0)).toBe(0);
  });

  it("scales down with executionFailureRate", () => {
    const f0 = kellyFraction(0.7, 1, 0);
    const f10 = kellyFraction(0.7, 1, 0.1);
    const f50 = kellyFraction(0.7, 1, 0.5);
    expect(f10).toBeCloseTo(f0 * 0.9, 5);
    expect(f50).toBeCloseTo(f0 * 0.5, 5);
  });

  it("caps fraction at 1.0", () => {
    expect(kellyFraction(0.99, 100, 0)).toBeLessThanOrEqual(1);
  });

  it.each([
    { p: 0.55, odds: 1 },
    { p: 0.6, odds: 1 },
    { p: 0.65, odds: 1 },
    { p: 0.7, odds: 1 },
    { p: 0.75, odds: 1 },
    { p: 0.8, odds: 1 },
    { p: 0.55, odds: 2 },
    { p: 0.6, odds: 2 },
    { p: 0.7, odds: 0.5 },
    { p: 0.55, odds: 5 },
  ])("Kelly(p=$p, odds=$odds) is non-negative and ≤ 1", ({ p, odds }) => {
    const f = kellyFraction(p, odds);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});
