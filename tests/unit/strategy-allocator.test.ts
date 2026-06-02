import { describe, it, expect } from "vitest";
import { correlation, metaAllocate, strategyHealth, diversificationRatio } from "@/lib/meta/strategy-allocator";

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

describe("diversificationRatio", () => {
  it("negatively-correlated combo → ratio > 1 (the de-correlation payoff)", () => {
    const a = series(5);
    const b = a.map((x) => -0.7 * x); // negatively correlated, combined ≠ 0
    expect(diversificationRatio([{ strategy: "a", returns: a }, { strategy: "b", returns: b }], { a: 0.5, b: 0.5 })).toBeGreaterThan(1);
  });
});
