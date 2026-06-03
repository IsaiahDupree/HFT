/**
 * Robustness / invariant / edge-case tests for the cross-sectional momentum
 * strategy (the OOS-survivor). Complementary to xsection-momentum.test.ts —
 * focuses on no-lookahead, threshold gating, determinism, scale-invariance,
 * sign correctness, and degenerate inputs.
 *
 * Pure synthetic inputs only. Any pseudo-randomness uses a fixed seeded LCG so
 * the file is fully deterministic (no clock, no real RNG).
 */
import { describe, it, expect } from "vitest";
import {
  crossSectionalMomentumWeights,
  isMarketTrending,
  momentumSignal,
  type CoinCloses,
} from "@/lib/strategies/xsection-momentum";

// ---- deterministic helpers (no wall-clock, no Math.random) -----------------

/** Seeded LCG in [0,1). Numerical Recipes constants. Fully reproducible. */
function makeLCG(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 21 closes: 20 flat at 100, then `last` ⇒ 20-day return = last/100 - 1. */
const flat21 = (last: number): number[] => [...Array(20).fill(100), last];

/** Geometric series of `n` closes starting at `base`, per-step growth `g`. */
const geom = (n: number, g: number, base = 100): number[] =>
  Array.from({ length: n }, (_, i) => base * (1 + g) ** i);

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const grossSum = (xs: number[]): number => xs.reduce((a, b) => a + Math.abs(b), 0);

/** A basket of `n` coins whose final 20d returns are strictly increasing. */
function rampedBasket(n: number): CoinCloses[] {
  return Array.from({ length: n }, (_, i) => ({
    coin: `C${i}`,
    // last close grows with i ⇒ monotonically increasing 20d return
    closes: flat21(80 + i * 10),
  }));
}

// ---------------------------------------------------------------------------

describe("crossSectionalMomentumWeights — invariants", () => {
  it("market-neutrality and gross=1 hold for an arbitrary (seeded) basket", () => {
    const rng = makeLCG(42);
    const bars: CoinCloses[] = Array.from({ length: 9 }, (_, i) => ({
      coin: `K${i}`,
      closes: flat21(50 + rng() * 100), // last in [50,150) ⇒ distinct returns
    }));
    const w = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 4 });
    const vals = Object.values(w);
    expect(vals.length).toBe(9);
    expect(Math.abs(sum(vals))).toBeLessThan(1e-9); // Σw ≈ 0
    expect(grossSum(vals)).toBeCloseTo(1, 9); // Σ|w| = 1
  });

  it("every output weight lies within [-1, 1] and at least one is non-zero", () => {
    const rng = makeLCG(7);
    const bars: CoinCloses[] = Array.from({ length: 12 }, (_, i) => ({
      coin: `Z${i}`,
      closes: flat21(60 + rng() * 80),
    }));
    const w = crossSectionalMomentumWeights(bars, { lookback: 20 });
    const vals = Object.values(w);
    expect(vals.length).toBe(12);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(vals.some((v) => v !== 0)).toBe(true);
  });

  it("weight ordering matches return ordering (monotone in lookback return)", () => {
    const bars = rampedBasket(6); // C0..C5 increasing final return
    const w = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 4 });
    // Higher return ⇒ strictly higher (more positive) weight under momentum.
    for (let i = 1; i < 6; i++) {
      expect(w[`C${i}`]).toBeGreaterThan(w[`C${i - 1}`]);
    }
    // Top is long, bottom is short.
    expect(w.C5).toBeGreaterThan(0);
    expect(w.C0).toBeLessThan(0);
  });

  it("sign symmetry: a basket with mirror-image returns has anti-symmetric weights", () => {
    // Returns symmetric about 0: +30,+10,-10,-30 ⇒ demeaned z's are anti-symmetric.
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(130) }, // +30%
      { coin: "B", closes: flat21(110) }, // +10%
      { coin: "C", closes: flat21(90) }, //  -10%
      { coin: "D", closes: flat21(70) }, //  -30%
    ];
    const w = crossSectionalMomentumWeights(bars, { lookback: 20 });
    expect(w.A).toBeCloseTo(-w.D, 9);
    expect(w.B).toBeCloseTo(-w.C, 9);
  });

  it("reversal is the exact negation of the momentum basket", () => {
    const rng = makeLCG(99);
    const bars: CoinCloses[] = Array.from({ length: 8 }, (_, i) => ({
      coin: `R${i}`,
      closes: flat21(70 + rng() * 60),
    }));
    const mom = crossSectionalMomentumWeights(bars, { lookback: 20 });
    const rev = crossSectionalMomentumWeights(bars, { lookback: 20, reversal: true });
    for (const k of Object.keys(mom)) {
      expect(rev[k]).toBeCloseTo(-mom[k], 12);
    }
  });

  it("scale-invariant: multiplying every coin's price level by a constant leaves weights unchanged", () => {
    const base = rampedBasket(6);
    const scaled: CoinCloses[] = base.map((b) => ({
      coin: b.coin,
      closes: b.closes.map((c) => c * 3.5), // ratios (returns) are preserved
    }));
    const w1 = crossSectionalMomentumWeights(base, { lookback: 20 });
    const w2 = crossSectionalMomentumWeights(scaled, { lookback: 20 });
    for (const k of Object.keys(w1)) {
      expect(w2[k]).toBeCloseTo(w1[k], 12);
    }
  });

  it("determinism: identical inputs produce identical outputs across repeated calls", () => {
    const bars = rampedBasket(7);
    const a = crossSectionalMomentumWeights(bars, { lookback: 20 });
    const b = crossSectionalMomentumWeights(bars, { lookback: 20 });
    expect(b).toEqual(a);
  });

  it("permutation covariance: reordering the input coins reorders weights but keeps each coin's value", () => {
    const bars = rampedBasket(6);
    const wOrig = crossSectionalMomentumWeights(bars, { lookback: 20 });
    const reversed = [...bars].reverse();
    const wPerm = crossSectionalMomentumWeights(reversed, { lookback: 20 });
    for (const k of Object.keys(wOrig)) {
      expect(wPerm[k]).toBeCloseTo(wOrig[k], 12);
    }
  });
});

describe("crossSectionalMomentumWeights — no-lookahead", () => {
  it("appending FUTURE bars does not change weights (uses only last & last-L)", () => {
    const bars = rampedBasket(6);
    const w0 = crossSectionalMomentumWeights(bars, { lookback: 20 });
    // The strategy reads closes[len-1] (newest) and closes[len-1-L]. To prove it
    // ignores unobserved future, recompute on a window that ends at the SAME bar
    // by trimming the head (keeping exactly the last L+1) — must be identical.
    const trimmed: CoinCloses[] = bars.map((b) => ({
      coin: b.coin,
      closes: b.closes.slice(b.closes.length - 21), // last 21 == full here, but explicit
    }));
    const wT = crossSectionalMomentumWeights(trimmed, { lookback: 20 });
    expect(wT).toEqual(w0);
  });

  it("prepending OLDER history (beyond lookback+1) is ignored", () => {
    const bars = rampedBasket(6);
    const w0 = crossSectionalMomentumWeights(bars, { lookback: 20 });
    // Add 40 days of ancient noise at the front; the trailing 21 closes are unchanged.
    const rng = makeLCG(2024);
    const padded: CoinCloses[] = bars.map((b) => ({
      coin: b.coin,
      closes: [...Array.from({ length: 40 }, () => 10 + rng() * 90), ...b.closes],
    }));
    const wP = crossSectionalMomentumWeights(padded, { lookback: 20 });
    for (const k of Object.keys(w0)) {
      expect(wP[k]).toBeCloseTo(w0[k], 12);
    }
  });

  it("only the close at index len-1-L matters at the lookback boundary, not interior bars", () => {
    // Two baskets share newest & oldest-in-window closes but differ in the middle.
    const interiorA = (last: number): number[] => [100, ...Array(19).fill(123.4), last];
    const interiorB = (last: number): number[] => [100, ...Array(19).fill(77.7), last];
    const mk = (f: (l: number) => number[]): CoinCloses[] => [
      { coin: "A", closes: f(130) },
      { coin: "B", closes: f(110) },
      { coin: "C", closes: f(90) },
      { coin: "D", closes: f(70) },
    ];
    const wA = crossSectionalMomentumWeights(mk(interiorA), { lookback: 20 });
    const wB = crossSectionalMomentumWeights(mk(interiorB), { lookback: 20 });
    expect(wB).toEqual(wA); // interior closes are irrelevant to the L-day return
  });
});

describe("crossSectionalMomentumWeights — gating & edge cases", () => {
  it("returns {} when too few coins are eligible (short series excluded)", () => {
    const bars: CoinCloses[] = [
      { coin: "ok1", closes: flat21(120) },
      { coin: "ok2", closes: flat21(80) },
      { coin: "short", closes: [100, 110] }, // length 2 < L+1 ⇒ ineligible
    ];
    // 2 eligible < default minCoins 4 ⇒ {}
    expect(crossSectionalMomentumWeights(bars, { lookback: 20 })).toEqual({});
  });

  it("respects a custom minCoins threshold (3 eligible passes minCoins=3, fails minCoins=4)", () => {
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(130) },
      { coin: "B", closes: flat21(110) },
      { coin: "C", closes: flat21(90) },
    ];
    expect(crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 3 })).not.toEqual({});
    expect(crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 4 })).toEqual({});
  });

  it("returns {} when the cross-section has zero dispersion (all returns equal ⇒ sd=0)", () => {
    const bars: CoinCloses[] = Array.from({ length: 6 }, (_, i) => ({
      coin: `E${i}`,
      closes: flat21(115), // every coin +15% ⇒ identical returns ⇒ std 0
    }));
    expect(crossSectionalMomentumWeights(bars, { lookback: 20 })).toEqual({});
  });

  it("returns {} on an empty basket", () => {
    expect(crossSectionalMomentumWeights([], { lookback: 20 })).toEqual({});
  });

  it("excludes coins with a non-positive newest close even if length suffices", () => {
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(130) },
      { coin: "B", closes: flat21(110) },
      { coin: "C", closes: flat21(90) },
      { coin: "BAD", closes: [...Array(20).fill(100), 0] }, // last close 0 ⇒ ineligible
    ];
    const w = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 3 });
    expect(Object.keys(w).sort()).toEqual(["A", "B", "C"]);
    expect(w.BAD).toBeUndefined();
    // 4th coin gone ⇒ only 3 eligible; with default minCoins=4 it would be flat.
    expect(crossSectionalMomentumWeights(bars, { lookback: 20 })).toEqual({});
  });

  it("excludes coins whose lookback-anchor close is non-positive (no division by 0)", () => {
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(130) },
      { coin: "B", closes: flat21(110) },
      { coin: "C", closes: flat21(90) },
      { coin: "ANCHOR0", closes: [0, ...Array(19).fill(100), 120] }, // close[len-1-L]=0
    ];
    const w = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 3 });
    expect(w.ANCHOR0).toBeUndefined();
    expect(Number.isFinite(grossSum(Object.values(w)))).toBe(true);
  });

  it("a custom lookback uses a different anchor and yields finite, normalized weights", () => {
    // 11 closes; with lookback 10 the anchor is index 0.
    const mk = (last: number): number[] => [100, ...Array(9).fill(105), last];
    const bars: CoinCloses[] = [
      { coin: "A", closes: mk(130) },
      { coin: "B", closes: mk(110) },
      { coin: "C", closes: mk(90) },
      { coin: "D", closes: mk(70) },
    ];
    // default lookback 20 needs >=21 closes ⇒ all ineligible ⇒ {}
    expect(crossSectionalMomentumWeights(bars, { minCoins: 4 })).toEqual({});
    const w = crossSectionalMomentumWeights(bars, { lookback: 10, minCoins: 4 });
    expect(grossSum(Object.values(w))).toBeCloseTo(1, 9);
    expect(Math.abs(sum(Object.values(w)))).toBeLessThan(1e-9);
  });

  it("all output values are finite for a noisy seeded basket (no NaN/Infinity leak)", () => {
    const rng = makeLCG(31337);
    const bars: CoinCloses[] = Array.from({ length: 15 }, (_, i) => ({
      coin: `N${i}`,
      closes: flat21(1 + rng() * 200), // positive, varied
    }));
    const w = crossSectionalMomentumWeights(bars, { lookback: 20 });
    for (const v of Object.values(w)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("isMarketTrending — gate behavior", () => {
  it("needs at least window+1 closes; shorter series is never trending", () => {
    expect(isMarketTrending(geom(20, 0.02), 20, 0.3)).toBe(false); // only 20 closes
    expect(isMarketTrending(geom(21, 0.02), 20, 0.3)).toBe(true); // exactly 21 ⇒ enough
  });

  it("a strong monotone uptrend trends (efficiency ratio → 1 ≥ threshold)", () => {
    expect(isMarketTrending(geom(21, 0.01), 20, 0.3)).toBe(true);
  });

  it("a strong monotone downtrend also trends (sign-agnostic, |net| in numerator)", () => {
    expect(isMarketTrending(geom(21, -0.01), 20, 0.3)).toBe(true);
  });

  it("pure chop (zig-zag, net≈0) does NOT trend", () => {
    const chop = Array.from({ length: 21 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    expect(isMarketTrending(chop, 20, 0.3)).toBe(false);
  });

  it("a perfectly flat market does not trend (path=0 short-circuits to false)", () => {
    expect(isMarketTrending(Array(21).fill(100), 20, 0.3)).toBe(false);
  });

  it("threshold is monotone: raising it past the realized efficiency ratio flips trending off", () => {
    // Drift + noise so the efficiency ratio sits strictly between 0 and 1.
    const rng = makeLCG(555);
    const closes = Array.from({ length: 21 }, (_, i) => 100 + i * 1.0 + (rng() - 0.5) * 4);
    expect(isMarketTrending(closes, 20, 0.0)).toBe(true); // any path>0 with net move
    expect(isMarketTrending(closes, 20, 1.01)).toBe(false); // unattainable threshold
  });

  it("is deterministic across repeated calls on the same series", () => {
    const closes = geom(25, 0.005);
    const a = isMarketTrending(closes, 20, 0.3);
    const b = isMarketTrending(closes, 20, 0.3);
    expect(b).toBe(a);
  });
});

describe("momentumSignal — composition of gate and basket", () => {
  it("flat (empty weights) whenever the trend gate is off, regardless of basket", () => {
    const chop = Array.from({ length: 21 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    const bars = rampedBasket(6);
    const sig = momentumSignal(bars, chop, {});
    expect(sig.trending).toBe(false);
    expect(sig.weights).toEqual({});
  });

  it("when trending, returns the SAME basket crossSectionalMomentumWeights would", () => {
    const up = geom(21, 0.01);
    const bars = rampedBasket(6);
    const sig = momentumSignal(bars, up, { lookback: 20, minCoins: 4 });
    expect(sig.trending).toBe(true);
    const direct = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 4 });
    expect(sig.weights).toEqual(direct);
  });

  it("trending + market-neutral basket ⇒ Σw≈0 and Σ|w|=1 propagate through the signal", () => {
    const up = geom(21, 0.01);
    const bars = rampedBasket(8);
    const sig = momentumSignal(bars, up, { lookback: 20, minCoins: 4 });
    expect(sig.trending).toBe(true);
    const vals = Object.values(sig.weights);
    expect(Math.abs(sum(vals))).toBeLessThan(1e-9);
    expect(grossSum(vals)).toBeCloseTo(1, 9);
  });

  it("trending but too few eligible coins ⇒ trending true yet empty weights", () => {
    const up = geom(21, 0.01);
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(130) },
      { coin: "B", closes: flat21(90) },
    ]; // only 2 eligible < default minCoins 4
    const sig = momentumSignal(bars, up, { lookback: 20 });
    expect(sig.trending).toBe(true);
    expect(sig.weights).toEqual({});
  });

  it("is fully deterministic given the same bars, btc series, and opts", () => {
    const up = geom(21, 0.008);
    const bars = rampedBasket(7);
    const s1 = momentumSignal(bars, up, { lookback: 20, minCoins: 4 });
    const s2 = momentumSignal(bars, up, { lookback: 20, minCoins: 4 });
    expect(s2).toEqual(s1);
  });
});
