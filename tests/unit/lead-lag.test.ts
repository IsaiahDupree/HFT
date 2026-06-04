import { describe, it, expect } from "vitest";
import { pearson, toReturns, crossCorrelation, leadLag } from "@/lib/data/lead-lag";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}

describe("pearson", () => {
  it("is 1 for a positive linear relation, -1 for negative", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
  });
  it("is 0 for a constant series or <2 points", () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
  });
});

describe("toReturns", () => {
  it("computes per-step simple returns (length n-1)", () => {
    const r = toReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 9);
    expect(r[1]).toBeCloseTo(-0.1, 9);
  });
  it("guards non-positive prior prices", () => {
    expect(toReturns([0, 100])).toEqual([0]);
  });
});

describe("crossCorrelation + leadLag", () => {
  it("detects A leads B when B is A shifted forward (positive lag)", () => {
    const rng = lcg(42);
    const a = Array.from({ length: 400 }, () => rng() - 0.5);
    // B copies A but delayed by 2 samples (B[t] = A[t-2]) → A LEADS B by 2.
    const b = a.map((_, i) => (i >= 2 ? a[i - 2] : 0));
    const r = leadLag(a, b, 5);
    expect(r.bestLag).toBe(2);
    expect(r.leader).toBe("A");
    expect(r.bestCorr).toBeGreaterThan(0.9);
  });

  it("detects B leads A when A is the delayed copy (negative lag)", () => {
    const rng = lcg(7);
    const b = Array.from({ length: 400 }, () => rng() - 0.5);
    const a = b.map((_, i) => (i >= 3 ? b[i - 3] : 0)); // A[t]=B[t-3] → B leads A by 3
    const r = leadLag(a, b, 5);
    expect(r.bestLag).toBe(-3);
    expect(r.leader).toBe("B");
  });

  it("calls it 'sync' when the two move together (peak at lag 0)", () => {
    const rng = lcg(99);
    const a = Array.from({ length: 400 }, () => rng() - 0.5);
    const b = a.map((x) => x + (lcg(1)() - 0.5) * 0.001); // ~identical, tiny noise
    const r = leadLag(a, b, 5);
    expect(r.bestLag).toBe(0);
    expect(r.leader).toBe("sync");
    expect(r.zeroCorr).toBeGreaterThan(0.99);
  });

  it("crossCorrelation returns 2*maxLag+1 lags centered on 0", () => {
    const xc = crossCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 2);
    expect(xc.map((x) => x.lag)).toEqual([-2, -1, 0, 1, 2]);
    expect(xc.find((x) => x.lag === 0)!.corr).toBeCloseTo(1, 9);
  });

  it("margin keeps near-synchronous feeds labeled sync even with a tiny off-zero bump", () => {
    const rng = lcg(5);
    const a = Array.from({ length: 300 }, () => rng() - 0.5);
    const b = [...a];
    // perfect lag-0; any off-zero corr is lower → stays sync
    expect(leadLag(a, b, 5, 0.02).leader).toBe("sync");
  });

  it("is deterministic", () => {
    const rng = lcg(3);
    const a = Array.from({ length: 100 }, () => rng() - 0.5);
    const b = a.map((_, i) => (i >= 1 ? a[i - 1] : 0));
    expect(leadLag(a, b, 4)).toEqual(leadLag(a, b, 4));
  });
});
