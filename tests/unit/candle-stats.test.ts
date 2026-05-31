/**
 * Unit tests for the overfit-detection statistics: normal CDF/inverse, skew/
 * kurtosis, Deflated Sharpe Ratio, Probability of Backtest Overfit, multi-fold WF.
 */
import { describe, it, expect } from "vitest";
import { normalCdf, normalInv, skewness, excessKurtosis, deflatedSharpe, pbo, multiFoldWalkForward, sharpe, variantReturns } from "@/lib/backtest/candle/stats";
import { smaTrend } from "@/lib/backtest/candle/strategies";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

const series = (closes: number[]): DailyCandle[] => closes.map((c, i) => ({ start_unix: i * 86400, open: c, high: c, low: c, close: c, volume: 0 }));
// deterministic PRNG so tests are reproducible
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe("normal CDF / inverse", () => {
  it("CDF anchors", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 3);
  });
  it("inverse is the CDF's inverse", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normalInv(0.5)).toBeCloseTo(0, 3);
    expect(normalCdf(normalInv(0.83))).toBeCloseTo(0.83, 3);
  });
});

describe("skew / kurtosis", () => {
  it("symmetric data → ~0 skew", () => { expect(Math.abs(skewness([-2, -1, 0, 1, 2]))).toBeLessThan(1e-6); });
  it("right-skewed data → positive skew", () => { expect(skewness([0, 0, 0, 0, 10])).toBeGreaterThan(0); });
  it("excess kurtosis of a flat spread is negative (platykurtic)", () => { expect(excessKurtosis([-1, -1, 1, 1])).toBeLessThan(0); });
});

describe("Deflated Sharpe Ratio", () => {
  const rets = Array.from({ length: 250 }, (_, i) => 0.003 + 0.01 * Math.sin(i)); // mild positive drift
  const bestSr = sharpe(rets);
  it("more trials (more configs at the same dispersion) → lower DSR", () => {
    const trials = (n: number) => Array.from({ length: n }, (_, i) => bestSr * (0.3 + 0.5 * ((i % 5) / 5)));
    const few = deflatedSharpe(rets, trials(3)).dsr;
    const many = deflatedSharpe(rets, trials(300)).dsr;
    expect(many).toBeLessThanOrEqual(few);
  });
  it("DSR ∈ [0,1]", () => { const d = deflatedSharpe(rets, [bestSr, bestSr * 0.5, bestSr * 0.2]).dsr; expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(1); });
  it("a best Sharpe far above the cross-trial dispersion → high DSR; ≈ the noise max → low DSR", () => {
    // strong: best (bestSr) dwarfs a tight cluster of near-zero trial Sharpes
    const strong = deflatedSharpe(rets, [bestSr, 0.001, -0.001, 0.0, 0.002]).dsr;
    // weak: best is just the top of widely-dispersed trials (it's plausibly luck)
    const weak = deflatedSharpe(rets, [bestSr, bestSr * 0.95, bestSr * 0.9, bestSr * 0.85, -bestSr]).dsr;
    expect(strong).toBeGreaterThan(weak);
  });
});

describe("Probability of Backtest Overfit", () => {
  it("pure-noise configs → high PBO (~overfit); a genuinely-better config → low PBO", () => {
    const T = 400, N = 12;
    const r = rng(7);
    // noise matrix: every config is iid noise → IS-best is luck → high PBO
    const noise: number[][] = Array.from({ length: T }, () => Array.from({ length: N }, () => r() - 0.5));
    const pboNoise = pbo(noise, 8);
    // signal matrix: config 0 has a real positive drift in EVERY block → low PBO
    const signal: number[][] = noise.map((row) => row.map((x, c) => (c === 0 ? x * 0.1 + 0.05 : x)));
    const pboSignal = pbo(signal, 8);
    expect(pboNoise).toBeGreaterThan(pboSignal);
    expect(pboSignal).toBeLessThan(0.3);
  });
});

describe("multi-fold walk-forward", () => {
  it("a persistent uptrend keeps trend OOS Sharpe positive across folds", () => {
    const c = series(Array.from({ length: 300 }, (_, i) => 100 * 1.005 ** i));
    const variants = [10, 20, 50].map((n) => ({ label: `sma${n}`, positions: smaTrend(c, n) }));
    const folds = multiFoldWalkForward(c, variants, { folds: 4, feeBps: 0 });
    expect(folds.length).toBe(4);
    expect(folds.every((f) => f.oosSharpe >= 0)).toBe(true);
  });
});
