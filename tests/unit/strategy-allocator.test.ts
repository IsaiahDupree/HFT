import { describe, it, expect } from "vitest";
import { correlation, metaAllocate, strategyHealth, diversificationRatio, betaPosteriorMean, betaLowerBound, evidenceFromReturns } from "@/lib/meta/strategy-allocator";

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const series = (seed: number, n = 60, vol = 0.02) => { const r = rng(seed); return Array.from({ length: n }, () => (r() - 0.5) * 2 * vol); };

describe("correlation", () => {
  it("perfect +1 / anti −1", () => {
    const x = [1, 2, 3, 4, 5, 6];
    expect(correlation(x, x)).toBeCloseTo(1, 6);
    expect(correlation(x, x.map((v) => -v))).toBeCloseTo(-1, 6);
  });
});

describe("metaAllocate — de-correlated risk parity", () => {
  it("penalizes a correlated duplicate; boosts the independent strategy", () => {
    const base = series(1);
    const dup = [...base];                 // identical → correlation 1 with base
    const indep = series(42);              // independent seed → ~0 correlation
    const w = metaAllocate([
      { strategy: "base", returns: base },
      { strategy: "dup", returns: dup },
      { strategy: "indep", returns: indep },
    ]);
    expect(w.indep).toBeGreaterThan(w.base); // uncorrelated → more weight than each of the correlated pair
    expect(w.indep).toBeGreaterThan(w.dup);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("higher-vol strategy gets less weight (inverse-vol)", () => {
    const w = metaAllocate([
      { strategy: "low", returns: series(3, 60, 0.01) },
      { strategy: "high", returns: series(3, 60, 0.05) }, // same shape, 5× vol
    ]);
    expect(w.low).toBeGreaterThan(w.high);
  });

  it("dropDecaying excludes a fading strategy", () => {
    const decaying = [...Array(20).fill(0.02), ...Array(20).fill(0).map((_, i) => (i % 2 ? -0.004 : -0.002))];
    const steady = Array.from({ length: 40 }, (_, i) => 0.003 + (i % 2 ? 0.001 : -0.001));
    const w = metaAllocate([{ strategy: "decaying", returns: decaying }, { strategy: "steady", returns: steady }], { dropDecaying: true });
    expect(w.decaying).toBeUndefined();
    expect(w.steady).toBeCloseTo(1, 6);
  });
});

describe("strategyHealth — decay detection", () => {
  it("flags decaying when the trailing Sharpe collapses below full", () => {
    const h = strategyHealth([...Array(20).fill(0.02), ...Array(20).fill(0).map((_, i) => (i % 2 ? -0.004 : -0.002))], {});
    expect(h.annSharpe).toBeGreaterThan(0);
    expect(h.decaying).toBe(true);
  });
  it("steady positive → not decaying, positive Sharpe, small drawdown", () => {
    const h = strategyHealth(Array.from({ length: 40 }, (_, i) => 0.003 + (i % 2 ? 0.001 : -0.001)), {});
    expect(h.decaying).toBe(false);
    expect(h.annSharpe).toBeGreaterThan(0);
    expect(h.maxDrawdown).toBeLessThan(0.05);
  });
});

describe("Bayesian evidence shrinkage (build 3)", () => {
  it("posterior mean pulls a thin record toward the prior; converges with evidence", () => {
    expect(betaPosteriorMean(3, 0)).toBeCloseTo(5 / 7, 6);       // 3/3 → Beta(5,2) mean 0.714, shrunk from 1.0
    expect(betaPosteriorMean(0, 0)).toBeCloseTo(0.5, 6);         // no data → prior mean
    expect(betaPosteriorMean(600, 400)).toBeGreaterThan(0.59);   // lots of evidence → ≈ empirical 0.6
    expect(betaPosteriorMean(600, 400)).toBeLessThan(0.605);
  });

  it("the funding-bug fix: PROVEN (200×0.6) outranks LUCKY-THIN (3×1.0) on the lower bound", () => {
    const lucky = betaLowerBound(3, 0);       // 3/3 win
    const proven = betaLowerBound(120, 80);   // 200 trades, 60%
    expect(betaPosteriorMean(3, 0)).toBeGreaterThan(betaPosteriorMean(120, 80)); // point estimate: lucky LOOKS better
    expect(proven).toBeGreaterThan(lucky);    // …but the evidence-aware lower bound flips it — proven wins
  });

  it("evidenceFromReturns counts positive periods as wins", () => {
    expect(evidenceFromReturns([0.1, -0.2, 0.3, 0, -0.1])).toEqual({ wins: 2, trades: 5 });
  });

  it("metaAllocate with evidence down-weights the lucky-thin strategy vs the proven one", () => {
    // identical return series ⇒ vol + correlation factors are equal for both,
    // so ONLY the evidence factor distinguishes them.
    const r = series(7);
    const w = metaAllocate(
      [{ strategy: "proven", returns: [...r] }, { strategy: "lucky", returns: [...r] }],
      { evidence: { proven: { wins: 120, trades: 200 }, lucky: { wins: 3, trades: 3 } } },
    );
    expect(w.proven).toBeGreaterThan(w.lucky);
    expect(w.proven + w.lucky).toBeCloseTo(1, 6);
  });

  it("no evidence supplied ⇒ allocation unchanged (backward compat)", () => {
    const strats = [{ strategy: "x", returns: series(1) }, { strategy: "y", returns: series(2) }];
    const base = metaAllocate(strats);
    const same = metaAllocate(strats, {});
    expect(same).toEqual(base);
  });
});

describe("diversificationRatio", () => {
  it("negatively-correlated combo → ratio > 1 (the de-correlation payoff)", () => {
    const a = series(5);
    const b = a.map((x) => -0.7 * x); // negatively correlated, combined ≠ 0
    expect(diversificationRatio([{ strategy: "a", returns: a }, { strategy: "b", returns: b }], { a: 0.5, b: 0.5 })).toBeGreaterThan(1);
  });
});
