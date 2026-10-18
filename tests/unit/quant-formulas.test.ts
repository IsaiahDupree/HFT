import { describe, expect, it } from "vitest";
import { bayesianUpdate, bayesianUpdateFromLikelihoods, expectedValue, kellyFraction } from "@/lib/quant/formulas";

describe("expectedValue", () => {
  it("returns positive EV when pTrue > pMarket (the canonical example from the article)", () => {
    // Market 40%, our belief 60% → EV = 0.60*0.60 - 0.40*0.40 = 0.20 per $1
    const r = expectedValue({ pTrue: 0.60, pMarket: 0.40 });
    expect(r.evPerDollar).toBeCloseTo(0.20, 5);
    expect(r.edgeProb).toBeCloseTo(0.20, 5);
    expect(r.recommendation).toBe("STRONG_EDGE");
  });

  it("returns negative EV when pTrue < pMarket (and recommends FADE — buy the other side)", () => {
    const r = expectedValue({ pTrue: 0.40, pMarket: 0.60 });
    expect(r.evPerDollar).toBeCloseTo(-0.20, 5);
    expect(r.recommendation).toBe("FADE");
  });

  it("recommends SKIP when edge is < 5%", () => {
    const r = expectedValue({ pTrue: 0.52, pMarket: 0.50 });
    expect(r.evPerDollar).toBeLessThan(0.05);
    expect(r.recommendation).toBe("SKIP");
  });

  it("returns absolute USD EV when stakeUsd is provided", () => {
    const r = expectedValue({ pTrue: 0.60, pMarket: 0.40, stakeUsd: 1000 });
    expect(r.evUsd).toBeCloseTo(200, 5);
  });

  it("clamps inputs to [0,1]", () => {
    const r = expectedValue({ pTrue: 1.5 as number, pMarket: -0.5 as number });
    // pTrue clamps to 1, pMarket clamps to 0 → EV = 1*1 - 0*0 = 1
    expect(r.evPerDollar).toBeCloseTo(1, 5);
  });
});

describe("kellyFraction", () => {
  it("recommends BUY_YES with Quarter Kelly by default", () => {
    // pTrue=0.60, pMarket=0.40 → b = 0.6/0.4 = 1.5; full Kelly = 0.60 - 0.40/1.5 = 0.333...
    // Quarter Kelly = 0.0833; on $1000 bankroll → $83
    const r = kellyFraction({ pTrue: 0.60, pMarket: 0.40, bankrollUsd: 1000 });
    expect(r.side).toBe("BUY_YES");
    expect(r.fullKellyFraction).toBeCloseTo(0.3333, 3);
    expect(r.recommendedFraction).toBeCloseTo(0.0833, 3);
    expect(r.betUsd).toBeCloseTo(83.33, 1);
  });

  it("recommends BUY_NO when pTrue < pMarket (mirror side)", () => {
    const r = kellyFraction({ pTrue: 0.40, pMarket: 0.60, bankrollUsd: 1000 });
    expect(r.side).toBe("BUY_NO");
    expect(r.betUsd).toBeGreaterThan(0);
  });

  it("recommends SKIP when neither side has positive edge", () => {
    const r = kellyFraction({ pTrue: 0.50, pMarket: 0.50, bankrollUsd: 1000 });
    expect(r.side).toBe("SKIP");
    expect(r.betUsd).toBe(0);
  });

  it("respects the maxFraction clamp at extreme pMarket", () => {
    // pMarket=0.02 with pTrue=0.50 → b = 49; Kelly says huge fraction; should clamp.
    const r = kellyFraction({ pTrue: 0.50, pMarket: 0.02, bankrollUsd: 1000, maxFraction: 0.10 });
    expect(r.recommendedFraction).toBeLessThanOrEqual(0.10);
    expect(r.betUsd).toBeLessThanOrEqual(100);
  });

  it("honors the fraction parameter (e.g. Full Kelly = 1.0)", () => {
    const quarter = kellyFraction({ pTrue: 0.60, pMarket: 0.40, bankrollUsd: 1000, fraction: 0.25 });
    const full = kellyFraction({ pTrue: 0.60, pMarket: 0.40, bankrollUsd: 1000, fraction: 1.0, maxFraction: 1.0 });
    expect(full.recommendedFraction).toBeCloseTo(quarter.recommendedFraction * 4, 3);
  });
});

describe("bayesianUpdate", () => {
  it("reproduces the article's Fed rate-cut example", () => {
    // prior = 0.55, P(E|H) = 0.80, P(E) = 0.50  →  posterior = (0.80 * 0.55) / 0.50 = 0.88
    const r = bayesianUpdate({ prior: 0.55, likelihoodIfH: 0.80, likelihoodOverall: 0.50 });
    expect(r.posterior).toBeCloseTo(0.88, 5);
    expect(r.bayesFactor).toBeCloseTo(1.6, 5);
  });

  it("returns Infinity Bayes factor when likelihoodOverall is 0 (sentinel for input error)", () => {
    const r = bayesianUpdate({ prior: 0.5, likelihoodIfH: 0.8, likelihoodOverall: 0 });
    expect(r.posterior).toBe(0);
    expect(r.bayesFactor).toBe(Infinity);
  });

  it("clamps posterior to [0,1] even on extreme inputs", () => {
    const r = bayesianUpdate({ prior: 0.9, likelihoodIfH: 0.99, likelihoodOverall: 0.1 });
    expect(r.posterior).toBeLessThanOrEqual(1);
    expect(r.posterior).toBeGreaterThanOrEqual(0);
  });
});

describe("bayesianUpdateFromLikelihoods", () => {
  it("computes the same posterior using the numerically-stable form", () => {
    // Equivalent setup: P(E|H)=0.80, P(E|¬H) chosen so P(E) ≈ 0.50 with prior 0.55
    // P(E) = 0.80*0.55 + P(E|¬H)*0.45 = 0.50 → P(E|¬H) = (0.50 - 0.44) / 0.45 ≈ 0.1333
    const r = bayesianUpdateFromLikelihoods({ prior: 0.55, likelihoodIfH: 0.80, likelihoodIfNotH: 0.1333 });
    expect(r.posterior).toBeCloseTo(0.88, 2);
  });

  it("handles the all-zero edge case without NaN", () => {
    const r = bayesianUpdateFromLikelihoods({ prior: 0.5, likelihoodIfH: 0, likelihoodIfNotH: 0 });
    expect(r.posterior).toBe(0);
    expect(r.bayesFactor).toBe(Infinity);
  });

  it("converges to prior when evidence is uninformative (P(E|H) == P(E|¬H))", () => {
    const r = bayesianUpdateFromLikelihoods({ prior: 0.3, likelihoodIfH: 0.5, likelihoodIfNotH: 0.5 });
    expect(r.posterior).toBeCloseTo(0.3, 5);
    expect(r.bayesFactor).toBeCloseTo(1, 5);
  });
});
