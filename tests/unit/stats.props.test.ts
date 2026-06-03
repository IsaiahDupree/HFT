/**
 * Property tests for the overfit-detection statistics module
 * (src/lib/backtest/candle/stats.ts). These assert algebraic invariants of the
 * REAL exports — scale/shift invariance, sign tracking, monotonicity, bounds,
 * permutation invariance, and determinism — and deliberately AVOID the concrete
 * worked-example cases already covered by candle-stats.test.ts and
 * candle-stats-robustness.test.ts. Every describe title ends with " — properties"
 * so it cannot collide with the sibling files. Fully deterministic: any randomness
 * comes from a seeded LCG defined below, never Math.random or the wall clock.
 */
import { describe, it, expect } from "vitest";
import {
  sharpe, median, normalCdf, normalInv, skewness, excessKurtosis,
  deflatedSharpe, pbo, variantReturns, multiFoldWalkForward,
} from "@/lib/backtest/candle/stats";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

// --- deterministic seeded LCG (Numerical Recipes constants) ----------------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000; // in [0,1)
  };
}
// uniform in [lo,hi) from a stream
const uni = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
// a reproducible vector of n draws in [lo,hi)
const vec = (r: () => number, n: number, lo: number, hi: number) =>
  Array.from({ length: n }, () => uni(r, lo, hi));

const candles = (closes: number[]): DailyCandle[] =>
  closes.map((c, i) => ({ start_unix: i, open: c, high: c, low: c, close: c, volume: 1 }));

describe("sharpe — properties", () => {
  it("a constant series of an exactly-representable value (std rounds to exactly 0) has Sharpe exactly 0", () => {
    // NOTE on real source behavior: sharpe() guards on `sd > 0`, but std() computes
    // Σ(x−m)² in floating point. For values that are NOT exactly representable
    // (e.g. -3.2) the residual rounding leaves a TINY positive std for some lengths,
    // so mean/std blows up to a huge finite number — it is NOT exactly 0. We document
    // the guarded case here using exactly-representable constants (0, 7, 2^k).
    for (const v of [0, 7, 1e6, 1024, -8, 0.5]) {
      for (const n of [2, 3, 8, 50]) {
        expect(sharpe(new Array(n).fill(v))).toBe(0);
      }
    }
  });

  it("documents the float-residue case: a non-exactly-representable constant can yield a huge (still finite) Sharpe, not 0", () => {
    // -3.2 with length 3 leaves a ~5e-16 std → mean/std is a large finite number.
    const sh = sharpe([-3.2, -3.2, -3.2]);
    expect(Number.isFinite(sh)).toBe(true);
    expect(Math.abs(sh)).toBeGreaterThan(1e6); // not 0 — pure floating-point residue
  });

  it("single-element and empty inputs are 0 (std undefined ⇒ guarded)", () => {
    expect(sharpe([])).toBe(0);
    expect(sharpe([0.5])).toBe(0);
    expect(sharpe([-9])).toBe(0);
  });

  it("positive scaling by k>0 leaves Sharpe unchanged across many seeded vectors", () => {
    const r = lcg(101);
    for (let t = 0; t < 12; t++) {
      const v = vec(r, 20, -0.05, 0.05);
      const k = uni(r, 0.01, 50);
      expect(sharpe(v.map((x) => x * k))).toBeCloseTo(sharpe(v), 9);
    }
  });

  it("negative scaling by −k (k>0) flips the Sharpe sign but keeps the magnitude", () => {
    const r = lcg(202);
    for (let t = 0; t < 10; t++) {
      const v = vec(r, 16, -0.04, 0.06); // biased positive ⇒ nonzero mean
      const base = sharpe(v);
      const flipped = sharpe(v.map((x) => -x));
      expect(flipped).toBeCloseTo(-base, 9);
    }
  });

  it("sign of Sharpe equals the sign of the mean (nonconstant samples)", () => {
    const r = lcg(303);
    for (let t = 0; t < 15; t++) {
      const bias = uni(r, -0.03, 0.03);
      const v = vec(r, 24, -0.02, 0.02).map((x) => x + bias);
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sh = sharpe(v);
      if (m > 1e-9) expect(sh).toBeGreaterThan(0);
      else if (m < -1e-9) expect(sh).toBeLessThan(0);
    }
  });

  it("adding a constant drift c shifts the numerator mean by c (std unchanged) so Sharpe grows monotonically in c", () => {
    const r = lcg(404);
    const v = vec(r, 30, -0.05, 0.05);
    const at = (c: number) => sharpe(v.map((x) => x + c));
    expect(at(0.0)).toBeLessThan(at(0.02));
    expect(at(0.02)).toBeLessThan(at(0.1));
    expect(at(-0.1)).toBeLessThan(at(-0.02));
  });

  it("Sharpe is invariant to a permutation of the returns (mean/std are order-free)", () => {
    const r = lcg(505);
    const v = vec(r, 18, -0.03, 0.07);
    const shuffled = [...v];
    // Fisher–Yates with the seeded stream
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(uni(r, 0, i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(sharpe(shuffled)).toBeCloseTo(sharpe(v), 12);
  });

  it("a higher mean at the same dispersion gives a strictly higher Sharpe", () => {
    const r = lcg(606);
    const noise = vec(r, 40, -0.01, 0.01);
    const lowMean = noise.map((x) => x + 0.005);
    const highMean = noise.map((x) => x + 0.05);
    expect(sharpe(highMean)).toBeGreaterThan(sharpe(lowMean));
  });

  it("more dispersion at the same mean lowers the Sharpe magnitude", () => {
    const r = lcg(707);
    const base = vec(r, 40, -1, 1); // centered noise stream
    const m = base.reduce((s, x) => s + x, 0) / base.length;
    const centered = base.map((x) => x - m); // exactly zero mean
    const tight = centered.map((x) => x * 0.01 + 0.02); // mean 0.02
    const wide = centered.map((x) => x * 0.1 + 0.02); // same mean 0.02, 10× spread
    expect(Math.abs(sharpe(tight))).toBeGreaterThan(Math.abs(sharpe(wide)));
  });

  it("a returned Sharpe is always finite for finite, nonconstant inputs", () => {
    const r = lcg(808);
    for (let t = 0; t < 20; t++) {
      const v = vec(r, 12, -2, 2);
      expect(Number.isFinite(sharpe(v))).toBe(true);
    }
  });

  it("a near-constant series with one tiny perturbation has a defined, finite Sharpe (not NaN)", () => {
    const v = new Array(50).fill(1);
    v[0] = 1 + 1e-12;
    const sh = sharpe(v);
    expect(Number.isFinite(sh)).toBe(true);
    expect(sh).toBeGreaterThan(0); // mean slightly above the bulk
  });
});

describe("median — properties", () => {
  it("is invariant to a seeded permutation of the same multiset", () => {
    const r = lcg(111);
    const v = vec(r, 21, -10, 10);
    const m0 = median(v);
    const shuffled = [...v];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(uni(r, 0, i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(median(shuffled)).toBe(m0);
  });

  it("translation-equivariant: median(x+c) = median(x)+c", () => {
    const r = lcg(222);
    const v = vec(r, 17, -5, 5);
    for (const c of [-3.5, 0.25, 100]) {
      expect(median(v.map((x) => x + c))).toBeCloseTo(median(v) + c, 9);
    }
  });

  it("scale-equivariant under a positive multiplier: median(k·x) = k·median(x)", () => {
    const r = lcg(333);
    const v = vec(r, 13, -2, 8);
    for (const k of [2, 0.5, 10]) {
      expect(median(v.map((x) => x * k))).toBeCloseTo(k * median(v), 9);
    }
  });

  it("lies within [min, max] and equals an actual sample for odd lengths", () => {
    const r = lcg(444);
    const v = vec(r, 15, -1, 1);
    const m = median(v);
    expect(m).toBeGreaterThanOrEqual(Math.min(...v));
    expect(m).toBeLessThanOrEqual(Math.max(...v));
    expect(v).toContain(m); // odd count ⇒ the middle value is a real element
  });

  it("even length returns the mean of the two central order statistics", () => {
    expect(median([10, 0, 30, 20])).toBe(15); // sorted 0,10,20,30 → (10+20)/2
    expect(median([2, 8])).toBe(5);
  });

  it("a single element returns itself; empty returns 0", () => {
    expect(median([42])).toBe(42);
    expect(median([-7.5])).toBe(-7.5);
    expect(median([])).toBe(0);
  });

  it("does not mutate its input array", () => {
    const v = [3, 1, 2, 5, 4];
    const copy = [...v];
    median(v);
    expect(v).toEqual(copy);
  });
});

describe("normalCdf — properties", () => {
  it("is bounded in (0,1) across a wide grid", () => {
    for (let x = -6; x <= 6; x += 0.25) {
      const p = normalCdf(x);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("is monotonically nondecreasing in x", () => {
    let prev = -1;
    for (let x = -5; x <= 5; x += 0.1) {
      const p = normalCdf(x);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it("satisfies the reflection identity Φ(−x)+Φ(x)=1 on a seeded sample", () => {
    const r = lcg(123);
    for (let t = 0; t < 20; t++) {
      const x = uni(r, -4, 4);
      expect(normalCdf(-x) + normalCdf(x)).toBeCloseTo(1, 6);
    }
  });

  it("tail values approach 0 and 1 in the limits", () => {
    expect(normalCdf(-8)).toBeLessThan(1e-3);
    expect(normalCdf(8)).toBeGreaterThan(1 - 1e-3);
    // the Abramowitz-Stegun erf approximation carries ~1e-7 absolute error, so 6 places.
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });

  it("covers the empirical 68–95–99.7 spreads", () => {
    expect(normalCdf(1) - normalCdf(-1)).toBeCloseTo(0.6827, 2);
    expect(normalCdf(2) - normalCdf(-2)).toBeCloseTo(0.9545, 2);
    expect(normalCdf(3) - normalCdf(-3)).toBeCloseTo(0.9973, 2);
  });
});

describe("normalInv — properties", () => {
  it("is the inverse of normalCdf across the body for seeded probabilities", () => {
    const r = lcg(234);
    for (let t = 0; t < 25; t++) {
      const p = uni(r, 0.001, 0.999);
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 3);
    }
  });

  it("round-trips x → p → x for a grid of quantiles", () => {
    for (let x = -3; x <= 3; x += 0.3) {
      expect(normalInv(normalCdf(x))).toBeCloseTo(x, 3);
    }
  });

  it("is monotonically increasing in p", () => {
    let prev = -Infinity;
    for (let p = 0.01; p < 0.99; p += 0.01) {
      const q = normalInv(p);
      expect(q).toBeGreaterThan(prev);
      prev = q;
    }
  });

  it("is antisymmetric about p=0.5: Φ⁻¹(p) = −Φ⁻¹(1−p)", () => {
    const r = lcg(345);
    for (let t = 0; t < 15; t++) {
      const p = uni(r, 0.05, 0.95);
      expect(normalInv(p)).toBeCloseTo(-normalInv(1 - p), 4);
    }
  });

  it("returns ±Infinity at and beyond the open boundary", () => {
    expect(normalInv(0)).toBe(-Infinity);
    expect(normalInv(-0.3)).toBe(-Infinity);
    expect(normalInv(1)).toBe(Infinity);
    expect(normalInv(1.7)).toBe(Infinity);
  });

  it("hits the canonical two-sided 95% quantile", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 3);
    expect(normalInv(0.025)).toBeCloseTo(-1.959964, 3);
    expect(normalInv(0.5)).toBeCloseTo(0, 6);
  });
});

describe("skewness / excessKurtosis — properties", () => {
  it("skewness is invariant to a positive affine transform a·x+b (a>0)", () => {
    const r = lcg(135);
    const v = vec(r, 30, -1, 3); // asymmetric draw range ⇒ nonzero skew
    const sk = skewness(v);
    const trans = v.map((x) => 4 * x + 7);
    expect(skewness(trans)).toBeCloseTo(sk, 6);
  });

  it("negating the data flips the skewness sign", () => {
    const r = lcg(246);
    const v = vec(r, 40, 0, 5).map((x) => x * x); // strong right skew
    expect(skewness(v.map((x) => -x))).toBeCloseTo(-skewness(v), 6);
  });

  it("excess kurtosis is invariant to a positive affine transform (a>0)", () => {
    const r = lcg(357);
    const v = vec(r, 30, -2, 2);
    const k = excessKurtosis(v);
    expect(excessKurtosis(v.map((x) => 3 * x - 5))).toBeCloseTo(k, 6);
  });

  it("excess kurtosis is invariant to negation (an even-moment statistic)", () => {
    const r = lcg(468);
    const v = vec(r, 35, -1.5, 1.5);
    expect(excessKurtosis(v.map((x) => -x))).toBeCloseTo(excessKurtosis(v), 9);
  });

  it("a constant (zero-variance) sample returns 0 for both skew and excess kurtosis (guard)", () => {
    const c = new Array(10).fill(2.5);
    expect(skewness(c)).toBe(0);
    expect(excessKurtosis(c)).toBe(0);
  });

  it("a heavy outlier injects positive excess kurtosis vs the same bulk without it", () => {
    const r = lcg(579);
    const bulk = vec(r, 60, -0.5, 0.5);
    const withSpike = [...bulk, 50, -50];
    expect(excessKurtosis(withSpike)).toBeGreaterThan(excessKurtosis(bulk));
  });

  it("skewness and excess kurtosis are finite for finite nonconstant inputs", () => {
    const r = lcg(680);
    for (let t = 0; t < 10; t++) {
      const v = vec(r, 25, -3, 3);
      expect(Number.isFinite(skewness(v))).toBe(true);
      expect(Number.isFinite(excessKurtosis(v))).toBe(true);
    }
  });
});

describe("deflatedSharpe — properties", () => {
  it("DSR stays inside [0,1] over many seeded return/trial configurations", () => {
    const r = lcg(147);
    for (let t = 0; t < 15; t++) {
      const ret = vec(r, 80, -0.03, 0.04);
      const trials = vec(r, 1 + Math.floor(uni(r, 0, 8)), -0.4, 0.5);
      const { dsr } = deflatedSharpe(ret, trials);
      expect(dsr).toBeGreaterThanOrEqual(0);
      expect(dsr).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic — same inputs give identical {sr,dsr,sr0}", () => {
    const r = lcg(258);
    const ret = vec(r, 120, -0.02, 0.03);
    const trials = vec(r, 10, -0.2, 0.3);
    expect(deflatedSharpe(ret, trials)).toEqual(deflatedSharpe(ret, trials));
  });

  it("DSR is nonincreasing as the number of (similarly-dispersed) trials grows", () => {
    const r = lcg(369);
    const ret = vec(r, 300, 0, 1).map((x) => 0.0015 + (x - 0.5) * 0.04); // modest SR
    // a fixed dispersion of trial Sharpes, sampled at increasing counts
    const mk = (n: number) => Array.from({ length: n }, (_, i) => -0.1 + (i % 7) * 0.03);
    const d5 = deflatedSharpe(ret, mk(5)).dsr;
    const d40 = deflatedSharpe(ret, mk(40)).dsr;
    const d200 = deflatedSharpe(ret, mk(200)).dsr;
    expect(d40).toBeLessThanOrEqual(d5 + 1e-12);
    expect(d200).toBeLessThanOrEqual(d40 + 1e-12);
  });

  it("the expected-max threshold sr0 grows with trial-Sharpe dispersion at fixed count", () => {
    const r = lcg(471);
    const ret = vec(r, 100, -0.02, 0.03);
    const tight = [0.10, 0.11, 0.09, 0.10, 0.12];
    const wide = [-0.5, 0.0, 0.5, -0.3, 0.4];
    expect(deflatedSharpe(ret, wide).sr0).toBeGreaterThan(deflatedSharpe(ret, tight).sr0);
  });

  it("a larger best-Sharpe edge (same trials) yields a higher DSR", () => {
    const r = lcg(582);
    const noise = vec(r, 200, -1, 1);
    const m = noise.reduce((s, x) => s + x, 0) / noise.length;
    const centered = noise.map((x) => x - m);
    const trials = [0.05, 0.06, 0.04, 0.05];
    const weakRet = centered.map((x) => x * 0.01 + 0.001); // tiny edge
    const strongRet = centered.map((x) => x * 0.01 + 0.01); // bigger edge
    const weak = deflatedSharpe(weakRet, trials);
    const strong = deflatedSharpe(strongRet, trials);
    expect(strong.sr).toBeGreaterThan(weak.sr);
    expect(strong.dsr).toBeGreaterThan(weak.dsr);
  });

  it("returns the all-zero record when the return sample is shorter than 4 bars", () => {
    expect(deflatedSharpe([], [0.1, 0.2])).toEqual({ sr: 0, dsr: 0, sr0: 0 });
    expect(deflatedSharpe([0.1], [0.1, 0.2])).toEqual({ sr: 0, dsr: 0, sr0: 0 });
    expect(deflatedSharpe([0.1, 0.2, 0.3], [0.5])).toEqual({ sr: 0, dsr: 0, sr0: 0 });
  });

  it("a single trial gives zero cross-trial variance ⇒ sr0 = 0 and DSR = Φ(sr/√srVar)", () => {
    const r = lcg(693);
    const ret = vec(r, 60, -0.02, 0.05);
    const { sr0, dsr, sr } = deflatedSharpe(ret, [0.3]);
    expect(sr0).toBe(0);
    expect(dsr).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(1);
    // with sr0=0 and a positive sr the DSR exceeds 0.5
    if (sr > 0) expect(dsr).toBeGreaterThan(0.5);
  });

  it("reported sr equals the standalone sharpe() of the best-returns series", () => {
    const r = lcg(714);
    const ret = vec(r, 90, -0.04, 0.05);
    expect(deflatedSharpe(ret, [0.1, 0.2, 0.15]).sr).toBeCloseTo(sharpe(ret), 12);
  });

  it("all three outputs are finite for a well-formed sample", () => {
    const r = lcg(825);
    const ret = vec(r, 150, -0.03, 0.04);
    const out = deflatedSharpe(ret, vec(r, 12, -0.3, 0.4));
    expect(Number.isFinite(out.sr)).toBe(true);
    expect(Number.isFinite(out.dsr)).toBe(true);
    expect(Number.isFinite(out.sr0)).toBe(true);
  });

  it("a non-positive Sharpe edge keeps DSR at or below 0.5 when sr0 ≥ 0", () => {
    const r = lcg(936);
    const noise = vec(r, 120, -1, 1);
    const m = noise.reduce((s, x) => s + x, 0) / noise.length;
    const ret = noise.map((x) => (x - m) * 0.01 - 0.003); // negative drift ⇒ sr<0
    const { sr, dsr, sr0 } = deflatedSharpe(ret, [0.1, 0.2, 0.15]);
    expect(sr).toBeLessThan(0);
    expect(sr0).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(0.5);
  });
});

describe("pbo — properties", () => {
  it("always returns a value in [0,1] over many seeded matrices", () => {
    const r = lcg(151);
    for (let t = 0; t < 10; t++) {
      const T = 64;
      const N = 2 + Math.floor(uni(r, 0, 8));
      const M = Array.from({ length: T }, () => vec(r, N, -0.5, 0.5));
      const p = pbo(M, 8);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("identical columns (no config is distinguishable) → PBO is defined and ≥ 0", () => {
    const r = lcg(262);
    const col = vec(r, 64, -0.2, 0.2);
    const M = col.map((x) => [x, x, x, x]); // 4 identical configs
    const p = pbo(M, 8);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("is invariant to a permutation of the config columns (relabeling)", () => {
    const r = lcg(373);
    const T = 64, N = 6;
    const M = Array.from({ length: T }, () => vec(r, N, -0.3, 0.3));
    // a fixed column permutation
    const perm = [3, 0, 5, 1, 4, 2];
    const Mp = M.map((row) => perm.map((c) => row[c]));
    expect(pbo(Mp, 8)).toBeCloseTo(pbo(M, 8), 12);
  });

  it("is deterministic across repeated calls with the same matrix", () => {
    const r = lcg(484);
    const M = Array.from({ length: 80 }, () => vec(r, 5, -0.4, 0.4));
    expect(pbo(M, 8)).toBe(pbo(M, 8));
  });

  it("a dominant config (best in every block) gives a very low PBO; a per-block rotating winner gives a high PBO", () => {
    const T = 80, N = 8;
    const dominant = Array.from({ length: T }, () => [0.02, 0, -0.01, 0.001, -0.002, 0.0, -0.003, 0.0005]);
    const rotating = Array.from({ length: T }, (_, t) =>
      Array.from({ length: N }, (_, c) => (Math.floor((t * N) / T) === c ? 1 : 0)));
    expect(pbo(dominant, 8)).toBeLessThan(0.2);
    expect(pbo(rotating, 8)).toBeGreaterThan(pbo(dominant, 8));
  });

  it("degenerate shapes return the sentinel 1 (too few rows, or <2 configs)", () => {
    expect(pbo([], 8)).toBe(1);
    expect(pbo([[0.1, 0.2]], 8)).toBe(1); // 1 row, needs ≥ nBlocks*2
    expect(pbo(Array.from({ length: 64 }, () => [0.1]), 8)).toBe(1); // single column
  });

  it("respects the nBlocks argument: a smaller even block count still yields a valid probability", () => {
    const r = lcg(595);
    const M = Array.from({ length: 48 }, () => vec(r, 4, -0.3, 0.3));
    for (const nb of [4, 6, 8]) {
      const p = pbo(M, nb);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("scaling EVERY return by the same positive k leaves PBO unchanged — per-block Sharpe ranking is scale-invariant", () => {
    // Each block's per-config Sharpe is mean/std, invariant to a positive scalar,
    // so the IS-best pick and its OOS rank are identical ⇒ PBO must match exactly.
    const r = lcg(606);
    const M = Array.from({ length: 64 }, () => vec(r, 5, -0.2, 0.2));
    const scaled = M.map((row) => row.map((x) => x * 3.5));
    expect(pbo(scaled, 8)).toBe(pbo(M, 8));
  });
});

describe("variantReturns — properties", () => {
  it("output length is one fewer than the candle count (next-bar returns)", () => {
    const cs = candles([100, 101, 102, 103, 104]);
    expect(variantReturns(cs, [1, 1, 1, 1, 1], 0)).toHaveLength(cs.length - 1);
  });

  it("is linear in position size with zero fees: doubling the position doubles every bar's return", () => {
    const cs = candles([100, 110, 99, 120, 108]);
    const r1 = variantReturns(cs, [1, 1, 1, 1, 1], 0);
    const r2 = variantReturns(cs, [2, 2, 2, 2, 2], 0);
    for (let i = 0; i < r1.length; i++) expect(r2[i]).toBeCloseTo(2 * r1[i], 9);
  });

  it("a flat position (all zeros) earns exactly 0 every bar regardless of fee", () => {
    const cs = candles([100, 130, 90, 140]);
    expect(variantReturns(cs, [0, 0, 0, 0], 50).every((x) => x === 0)).toBe(true);
  });

  it("a short is the exact negative of a long with zero fees (no turnover difference per bar)", () => {
    const cs = candles([100, 105, 98, 110, 102]);
    const long = variantReturns(cs, [1, 1, 1, 1, 1], 0);
    const short = variantReturns(cs, [-1, -1, -1, -1, -1], 0);
    for (let i = 0; i < long.length; i++) expect(short[i]).toBeCloseTo(-long[i], 9);
  });

  it("higher fees never increase the total return of a position that turns over", () => {
    const cs = candles([100, 120, 95, 130, 110]);
    const pos = [1, -1, 1, -1, 1]; // flips every bar ⇒ heavy turnover
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    expect(sum(variantReturns(cs, pos, 100))).toBeLessThan(sum(variantReturns(cs, pos, 0)));
  });

  it("the very first bar charges an opening turnover fee equal to |pos0|·fee in a flat market", () => {
    const cs = candles([100, 100, 100]); // flat ⇒ price PnL is 0
    expect(variantReturns(cs, [1, 1, 0], 100)[0]).toBeCloseTo(-100 / 1e4, 9);
    expect(variantReturns(cs, [0.5, 0.5, 0], 100)[0]).toBeCloseTo(-0.5 * 100 / 1e4, 9);
  });

  it("treats a missing position as 0 (sparse arrays don't throw)", () => {
    const cs = candles([100, 110, 121, 133.1]);
    const r = variantReturns(cs, [1], 0); // positions[1..] undefined → 0
    expect(r).toHaveLength(3);
    expect(r[0]).toBeCloseTo(0.1, 9); // held pos0=1 over first step
    expect(r[1]).toBeCloseTo(0, 9); // pos1 undefined → 0 exposure
  });

  it("with zero fee, total return equals the product-free sum of per-bar long PnL on a monotone series", () => {
    const closes = [100, 110, 121, 133.1]; // +10%/bar
    const cs = candles(closes);
    const r = variantReturns(cs, [1, 1, 1, 1], 0);
    expect(r.every((x) => Math.abs(x - 0.1) < 1e-9)).toBe(true);
  });
});

describe("multiFoldWalkForward — properties", () => {
  const up = candles(Array.from({ length: 120 }, (_, i) => 100 * 1.008 ** i));

  it("returns exactly `folds` results and each result carries a finite oosSharpe", () => {
    const variants = [
      { label: "long", positions: new Array(120).fill(1) },
      { label: "short", positions: new Array(120).fill(-1) },
    ];
    const folds = multiFoldWalkForward(up, variants, { folds: 5, feeBps: 0 });
    expect(folds).toHaveLength(5);
    for (const f of folds) expect(Number.isFinite(f.oosSharpe)).toBe(true);
  });

  it("the OOS bar counts sum to the back 60% of the series", () => {
    const variants = [{ label: "long", positions: new Array(120).fill(1) }];
    const folds = multiFoldWalkForward(up, variants, { folds: 4 });
    const total = folds.reduce((s, f) => s + f.bars, 0);
    expect(total).toBe(120 - Math.floor(120 * 0.4));
  });

  it("is deterministic — identical inputs yield identical fold records", () => {
    const variants = [
      { label: "a", positions: new Array(120).fill(1) },
      { label: "b", positions: up.map((_, i) => (i % 2 ? 1 : -1)) },
    ];
    const a = multiFoldWalkForward(up, variants, { folds: 4, feeBps: 5 });
    const b = multiFoldWalkForward(up, variants, { folds: 4, feeBps: 5 });
    expect(a).toEqual(b);
  });

  it("every fold's chosen label is one of the supplied variant labels", () => {
    const variants = [
      { label: "long", positions: new Array(120).fill(1) },
      { label: "short", positions: new Array(120).fill(-1) },
      { label: "flat", positions: new Array(120).fill(0) },
    ];
    const labels = new Set(variants.map((v) => v.label));
    const folds = multiFoldWalkForward(up, variants, { folds: 4, feeBps: 0 });
    for (const f of folds) expect(labels.has(f.label)).toBe(true);
  });

  it("fold indices are 0..folds−1 in order", () => {
    const variants = [{ label: "long", positions: new Array(120).fill(1) }];
    const folds = multiFoldWalkForward(up, variants, { folds: 6 });
    expect(folds.map((f) => f.fold)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("in a clean uptrend the long variant is selected and stays profitable OOS", () => {
    const variants = [
      { label: "long", positions: new Array(120).fill(1) },
      { label: "short", positions: new Array(120).fill(-1) },
    ];
    const folds = multiFoldWalkForward(up, variants, { folds: 4, feeBps: 0 });
    expect(folds.every((f) => f.label === "long")).toBe(true);
    expect(folds.every((f) => f.oosSharpe > 0)).toBe(true);
  });

  it("defaults to 4 folds when none specified", () => {
    const variants = [{ label: "long", positions: new Array(120).fill(1) }];
    expect(multiFoldWalkForward(up, variants)).toHaveLength(4);
  });
});
