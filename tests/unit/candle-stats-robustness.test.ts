import { describe, it, expect } from "vitest";
import {
  sharpe, median, normalCdf, normalInv, skewness, excessKurtosis,
  deflatedSharpe, pbo, variantReturns, multiFoldWalkForward,
} from "@/lib/backtest/candle/stats";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

// deterministic LCG so any "noise" is reproducible (no Math.random flakiness)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}
const candles = (closes: number[]): DailyCandle[] =>
  closes.map((c, i) => ({ start_unix: i, open: c, high: c, low: c, close: c, volume: 1 }));

describe("stats — sharpe / median", () => {
  it("sharpe is mean/std; constant returns (std 0) → 0", () => {
    expect(sharpe([1, 2, 3])).toBeCloseTo(2 / 1, 9);  // mean 2, sample-std 1
    expect(sharpe([5, 5, 5, 5])).toBe(0);
    expect(sharpe([])).toBe(0);
  });
  it("sharpe is scale-invariant in the returns (×k leaves mean/std ratio fixed)", () => {
    const r = [0.01, -0.005, 0.02, 0.001, -0.003];
    expect(sharpe(r.map((x) => x * 7))).toBeCloseTo(sharpe(r), 9);
  });
  it("sharpe sign tracks the mean", () => {
    expect(sharpe([0.02, 0.01, 0.015, 0.005])).toBeGreaterThan(0);
    expect(sharpe([-0.02, -0.01, -0.015, -0.005])).toBeLessThan(0);
  });
  it("median handles odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("stats — normal CDF / inverse", () => {
  it("normalCdf at the canonical points", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });
  it("normalCdf is symmetric: Φ(−x) = 1 − Φ(x)", () => {
    for (const x of [0.3, 1, 2.5]) expect(normalCdf(-x)).toBeCloseTo(1 - normalCdf(x), 6);
  });
  it("normalInv inverts normalCdf across the body", () => {
    for (const x of [-2, -1, -0.25, 0, 0.5, 1.3, 2]) expect(normalInv(normalCdf(x))).toBeCloseTo(x, 3);
  });
  it("normalInv at the median + tails", () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 6);
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 3);
    expect(normalInv(0)).toBe(-Infinity);
    expect(normalInv(1)).toBe(Infinity);
  });
});

describe("stats — skewness / excess kurtosis", () => {
  it("symmetric data has ~0 skew", () => {
    expect(skewness([-2, -1, 0, 1, 2])).toBeCloseTo(0, 9);
  });
  it("a right tail gives positive skew, a left tail negative", () => {
    expect(skewness([0, 0, 0, 0, 10])).toBeGreaterThan(0);
    expect(skewness([0, 0, 0, 0, -10])).toBeLessThan(0);
  });
  it("a fat-tailed sample has positive excess kurtosis; a uniform-ish one negative", () => {
    expect(excessKurtosis([0, 0, 0, 0, 0, 0, 0, 10, -10])).toBeGreaterThan(0);
    expect(excessKurtosis([-2, -1, 0, 1, 2])).toBeLessThan(0);
  });
});

describe("stats — Deflated Sharpe Ratio (multiple-testing correction)", () => {
  it("returns zeros on too-short a sample (T < 4)", () => {
    expect(deflatedSharpe([0.1, 0.2, 0.3], [0.5, 0.4])).toEqual({ sr: 0, dsr: 0, sr0: 0 });
  });
  it("MORE trials ⇒ more deflation ⇒ a LOWER DSR for the same returns", () => {
    const rng = lcg(42);
    // MODEST Sharpe (~0.13/period) so DSR sits inside (0,1) and is sensitive to deflation
    const ret = Array.from({ length: 300 }, () => 0.0015 + (rng() - 0.5) * 0.04);
    const few = deflatedSharpe(ret, [0.1, 0.12]);
    const spread = Array.from({ length: 60 }, (_, i) => -0.05 + i * 0.005);       // many noisy trials
    const many = deflatedSharpe(ret, spread);
    expect(many.sr0).toBeGreaterThan(few.sr0);   // expected-max grows with trial count + spread
    expect(many.dsr).toBeLessThan(few.dsr);
    expect(few.dsr).toBeLessThan(1);             // not saturated → the comparison is meaningful
  });
  it("a strong, consistent edge tested against few similar trials clears DSR > 0.95", () => {
    const rng = lcg(7);
    const ret = Array.from({ length: 400 }, () => 0.01 + (rng() - 0.5) * 0.004); // high SR, low noise
    const { dsr, sr } = deflatedSharpe(ret, [0.6, 0.62, 0.58]);
    expect(sr).toBeGreaterThan(0);
    expect(dsr).toBeGreaterThan(0.95);
  });
  it("DSR ∈ [0,1]", () => {
    const rng = lcg(99);
    const ret = Array.from({ length: 120 }, () => (rng() - 0.5) * 0.02);
    const { dsr } = deflatedSharpe(ret, [0.1, -0.2, 0.05, 0.3]);
    expect(dsr).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(1);
  });
});

describe("stats — Probability of Backtest Overfit", () => {
  it("a single dominant config (best IS and OOS everywhere) → PBO 0", () => {
    const T = 64;
    const M = Array.from({ length: T }, () => [0.01, 0, -0.005]); // col 0 always best
    expect(pbo(M, 8)).toBe(0);
  });
  it("a block-winner matrix (each config only wins in its own block) → PBO ≈ 1 (pure overfit)", () => {
    const T = 64, N = 8;
    const M = Array.from({ length: T }, (_, t) => Array.from({ length: N }, (_, c) => (Math.floor(t / 8) === c ? 1 : 0)));
    expect(pbo(M, 8)).toBeGreaterThan(0.9);
  });
  it("PBO ∈ [0,1] and degenerate inputs return 1", () => {
    expect(pbo([[1, 2]], 8)).toBe(1);                 // too few rows
    expect(pbo(Array.from({ length: 64 }, () => [0.1]), 8)).toBe(1); // <2 configs
    const rng = lcg(3);
    const noise = Array.from({ length: 64 }, () => Array.from({ length: 6 }, () => rng() - 0.5));
    const p = pbo(noise, 8);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
  it("the robust config is far less overfit than the block-winner set", () => {
    const robust = Array.from({ length: 64 }, () => [0.01, 0, -0.005]);
    const overfit = Array.from({ length: 64 }, (_, t) => Array.from({ length: 8 }, (_, c) => (Math.floor(t / 8) === c ? 1 : 0)));
    expect(pbo(robust, 8)).toBeLessThan(pbo(overfit, 8));
  });
});

describe("stats — variantReturns", () => {
  it("long through a steady uptrend earns the per-bar return; flat earns 0", () => {
    const cs = candles([100, 110, 121]); // +10%/bar
    const long = variantReturns(cs, [1, 1, 1], 0);
    expect(long[0]).toBeCloseTo(0.1, 9);
    expect(long[1]).toBeCloseTo(0.1, 9);
    expect(variantReturns(cs, [0, 0, 0], 0).every((x) => x === 0)).toBe(true);
  });
  it("charges fee on |Δposition| (turnover), including the opening trade", () => {
    const cs = candles([100, 100, 100]);
    const r = variantReturns(cs, [1, 1, 0], 100); // open at bar0 (Δ1), close at bar2 (Δ1)
    expect(r[0]).toBeCloseTo(-100 / 1e4, 9);       // opening turnover fee, flat market
    expect(r[1]).toBeCloseTo(0, 9);                // held → no turnover, flat market
  });
  it("a short position profits in a downtrend", () => {
    const cs = candles([100, 90, 81]);
    expect(variantReturns(cs, [-1, -1, -1], 0)[0]).toBeCloseTo(0.1, 9);
  });
});

describe("stats — multiFoldWalkForward", () => {
  it("picks the right side of the trend and holds OOS: a long variant beats short in an uptrend", () => {
    const up = candles(Array.from({ length: 100 }, (_, i) => 100 * 1.01 ** i));
    const variants = [
      { label: "long", positions: Array(100).fill(1) },
      { label: "short", positions: Array(100).fill(-1) },
    ];
    const folds = multiFoldWalkForward(up, variants, { folds: 4, feeBps: 0 });
    expect(folds).toHaveLength(4);
    expect(folds.every((f) => f.label === "long")).toBe(true);   // IS always picks long
    expect(folds.every((f) => f.oosSharpe > 0)).toBe(true);      // and it holds out-of-sample
  });
  it("reports the OOS bar count per fold and covers the back 60%", () => {
    const cs = candles(Array.from({ length: 100 }, (_, i) => 100 + i));
    const folds = multiFoldWalkForward(cs, [{ label: "long", positions: Array(100).fill(1) }], { folds: 3 });
    const totalOos = folds.reduce((s, f) => s + f.bars, 0);
    expect(totalOos).toBe(100 - Math.floor(100 * 0.4)); // the back 60%
  });
});
