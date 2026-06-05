import { describe, it, expect } from "vitest";
import { equalWeights, inverseVolWeights, applyAllocation, normalizeWeights, correlationMatrix } from "@/lib/backtest/edge-allocator";

describe("equalWeights", () => {
  it("gives every sleeve 1/n each day", () => {
    const w = equalWeights(2, 3);
    expect(w).toEqual([[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
  });
});

describe("inverseVolWeights — risk parity, no-lookahead", () => {
  it("weights the calmer sleeve more once both vols are known", () => {
    // sleeve A is low-vol (small wiggle), sleeve B is whippy → A should get more weight
    const A = [0.011, 0.009, 0.011, 0.009, 0.011, 0.009];
    const B = [0.05, -0.05, 0.05, -0.05, 0.05, -0.05];
    const w = inverseVolWeights([A, B], 3);
    expect(w[0][5]).toBeGreaterThan(w[1][5]); // A (calm) > B (whippy)
    expect(w[0][5] + w[1][5]).toBeCloseTo(1, 9);
  });
  it("falls back to equal weight during warmup", () => {
    const w = inverseVolWeights([[0.01, 0.02], [0.03, 0.01]], 3);
    expect(w[0][0]).toBeCloseTo(0.5, 9);
    expect(w[1][0]).toBeCloseTo(0.5, 9);
  });
  it("is no-lookahead: a far-future sleeve return can't change earlier weights", () => {
    const A = [0.01, 0.02, 0.01, 0.03, 0.01], B = [0.02, 0.01, 0.02, 0.01, 0.02];
    const base = inverseVolWeights([A, B], 2);
    const A2 = [...A]; A2[4] = 9;
    expect(inverseVolWeights([A2, B], 2)[0].slice(0, 4)).toEqual(base[0].slice(0, 4));
  });
});

describe("applyAllocation", () => {
  it("is the weighted sum of sleeve returns per day", () => {
    const r = [[0.10, -0.20], [0.00, 0.40]];
    const w = [[0.5, 0.25], [0.5, 0.75]];
    const out = applyAllocation(r, w); // [.5*.1+.5*0, .25*-.2+.75*.4]
    expect(out[0]).toBeCloseTo(0.05, 9);
    expect(out[1]).toBeCloseTo(0.25, 9);
  });
});

describe("normalizeWeights", () => {
  it("renormalizes scaled columns to sum 1 and floors negatives", () => {
    const out = normalizeWeights([[0.6, -0.1], [0.6, 0.3]]);
    expect(out[0][0]).toBeCloseTo(0.5, 9);
    expect(out[1][0]).toBeCloseTo(0.5, 9);
    expect(out[0][1]).toBeCloseTo(0, 9);   // negative floored to 0
    expect(out[1][1]).toBeCloseTo(1, 9);
  });
  it("an all-zero column → equal weight", () => {
    expect(normalizeWeights([[0], [0]]).map((c) => c[0])).toEqual([0.5, 0.5]);
  });
});

describe("correlationMatrix", () => {
  it("has 1 on the diagonal and detects anti-correlation", () => {
    const A = [1, 2, 3, 4], B = [4, 3, 2, 1];
    const m = correlationMatrix([A, B]);
    expect(m[0][0]).toBeCloseTo(1, 9);
    expect(m[0][1]).toBeCloseTo(-1, 9);
  });
});

describe("diversification — a risk-parity book of uncorrelated sleeves beats the average single sleeve", () => {
  it("raises Sharpe when two positive, uncorrelated sleeves are combined", () => {
    function lcg(s: number) { let x = s >>> 0; return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 0xffffffff; }; }
    const r1 = lcg(1), r2 = lcg(99);
    const A = Array.from({ length: 400 }, () => 0.001 + (r1() - 0.5) * 0.01);
    const B = Array.from({ length: 400 }, () => 0.001 + (r2() - 0.5) * 0.01); // independent
    const sharpe = (x: number[]) => { const m = x.reduce((a, y) => a + y, 0) / x.length; const sd = Math.sqrt(x.reduce((a, y) => a + (y - m) ** 2, 0) / x.length); return sd > 0 ? m / sd : 0; };
    const port = applyAllocation([A, B], inverseVolWeights([A, B], 20));
    expect(sharpe(port)).toBeGreaterThan(Math.max(sharpe(A), sharpe(B))); // diversification lifts Sharpe
  });
});
