/**
 * Robustness / invariant tests for the Polymarket-V2 fee + rebate curves in the
 * Avellaneda-Stoikov market-making library. Complements as-market-maker.test.ts:
 * here we stress the takerFee / makerRebate / effectiveHalfSpread fee curves
 * across the full FeeCategory set and over a deterministic grid of synthetic
 * prices and sizes — checking symmetry, monotonicity in size, sign, the
 * fee-free categories, and the boundary prices {0, 0.5, 1}.
 *
 * Fully deterministic: all inputs are fixed constants or drawn from a small
 * seeded LCG. No I/O, no clock, no nondeterministic RNG.
 */
import { describe, it, expect } from "vitest";
import {
  takerFee, makerRebate, effectiveHalfSpread, FEE_CATEGORIES,
  type FeeCategory,
} from "@/lib/strategies/as-market-maker";

// ── deterministic helpers ──────────────────────────────────────────────────
/** Small seeded LCG (Numerical Recipes constants) → fully reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000; // → [0,1)
  };
}

const CATEGORIES = Object.keys(FEE_CATEGORIES) as FeeCategory[];
const FEE_FREE: FeeCategory[] = CATEGORIES.filter((c) => FEE_CATEGORIES[c][0] === 0);
const FEE_BEARING: FeeCategory[] = CATEGORIES.filter((c) => FEE_CATEGORIES[c][0] > 0);

// Interior prices in (0,1), avoiding the exact boundaries.
const INTERIOR_PRICES = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];

describe("takerFee — fee curve shape", () => {
  it("is exactly symmetric about p=0.5 for every category (price ↔ 1-price)", () => {
    for (const cat of CATEGORIES) {
      for (const price of [0.01, 0.1, 0.27, 0.4, 0.49]) {
        expect(takerFee(price, 100, cat)).toBeCloseTo(takerFee(1 - price, 100, cat), 12);
      }
    }
  });

  it("peaks at p=0.5 and decreases monotonically toward each boundary", () => {
    for (const cat of FEE_BEARING) {
      const peak = takerFee(0.5, 100, cat);
      const ascending = [0.02, 0.15, 0.3, 0.45, 0.5];
      for (let i = 1; i < ascending.length; i++) {
        expect(takerFee(ascending[i], 100, cat)).toBeGreaterThanOrEqual(
          takerFee(ascending[i - 1], 100, cat),
        );
      }
      // anything off-peak is strictly below the peak
      expect(takerFee(0.2, 100, cat)).toBeLessThan(peak);
      expect(takerFee(0.8, 100, cat)).toBeLessThan(peak);
    }
  });

  it("matches the closed form peak·size·p·(1-p)·4 across an LCG price grid", () => {
    const rnd = lcg(0xC0FFEE);
    for (const cat of CATEGORIES) {
      const peak = FEE_CATEGORIES[cat][0];
      for (let i = 0; i < 12; i++) {
        const price = rnd(); // in [0,1)
        const size = 1 + Math.floor(rnd() * 500);
        const expected = peak === 0 ? 0 : peak * size * price * (1 - price) * 4;
        expect(takerFee(price, size, cat)).toBeCloseTo(expected, 10);
      }
    }
  });

  it("is exactly 0 at the boundary prices p=0 and p=1 (every category)", () => {
    for (const cat of CATEGORIES) {
      expect(takerFee(0, 250, cat)).toBe(0);
      expect(takerFee(1, 250, cat)).toBe(0);
    }
  });

  it("at p=0.5 the fee equals peak·size exactly (the 4·0.25 collapses to 1)", () => {
    for (const cat of FEE_BEARING) {
      const peak = FEE_CATEGORIES[cat][0];
      expect(takerFee(0.5, 100, cat)).toBeCloseTo(peak * 100, 12);
    }
  });
});

describe("takerFee — scaling in size", () => {
  it("is strictly increasing in size at any interior price (fee-bearing cats)", () => {
    for (const cat of FEE_BEARING) {
      for (const price of INTERIOR_PRICES) {
        const sizes = [1, 10, 50, 200, 1000];
        for (let i = 1; i < sizes.length; i++) {
          expect(takerFee(price, sizes[i], cat)).toBeGreaterThan(
            takerFee(price, sizes[i - 1], cat),
          );
        }
      }
    }
  });

  it("is exactly linear (homogeneous degree 1) in size", () => {
    const rnd = lcg(0x1234);
    for (const cat of FEE_BEARING) {
      for (let i = 0; i < 8; i++) {
        const price = 0.05 + rnd() * 0.9;
        const base = 1 + Math.floor(rnd() * 100);
        const k = 2 + Math.floor(rnd() * 9);
        expect(takerFee(price, base * k, cat)).toBeCloseTo(takerFee(price, base, cat) * k, 9);
      }
    }
  });

  it("size 0 → fee 0; negative size flips the sign (and only the sign)", () => {
    for (const cat of FEE_BEARING) {
      for (const price of [0.25, 0.5, 0.75]) {
        expect(takerFee(price, 0, cat)).toBe(0);
        const pos = takerFee(price, 100, cat);
        const neg = takerFee(price, -100, cat);
        expect(neg).toBeCloseTo(-pos, 12);
      }
    }
  });

  it("is non-negative for non-negative size at every interior price", () => {
    for (const cat of CATEGORIES) {
      for (const price of INTERIOR_PRICES) {
        expect(takerFee(price, 0, cat)).toBeGreaterThanOrEqual(0);
        expect(takerFee(price, 100, cat)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is deterministic — identical inputs yield identical outputs", () => {
    for (const cat of CATEGORIES) {
      const a = takerFee(0.37, 123, cat);
      const b = takerFee(0.37, 123, cat);
      expect(a).toBe(b);
    }
  });
});

describe("fee-free categories", () => {
  it("geopolitics and other are the configured fee-free set", () => {
    expect(FEE_FREE.sort()).toEqual(["geopolitics", "other"]);
  });

  it("takerFee is identically 0 for fee-free cats across an LCG grid", () => {
    const rnd = lcg(0xABCDEF);
    for (const cat of FEE_FREE) {
      for (let i = 0; i < 20; i++) {
        const price = rnd();
        const size = Math.floor(rnd() * 1000) - 500; // ±, incl. negative & 0-ish
        expect(takerFee(price, size, cat)).toBe(0);
      }
    }
  });

  it("makerRebate is identically 0 for fee-free cats", () => {
    for (const cat of FEE_FREE) {
      for (const price of INTERIOR_PRICES) {
        expect(makerRebate(price, 500, cat)).toBe(0);
      }
    }
  });
});

describe("makerRebate — rebate curve", () => {
  it("equals takerFee·share for every category, and ≤ takerFee (share≤1)", () => {
    const rnd = lcg(0x55AA);
    for (const cat of CATEGORIES) {
      const share = FEE_CATEGORIES[cat][1];
      for (let i = 0; i < 10; i++) {
        const price = rnd();
        const size = 1 + Math.floor(rnd() * 400);
        const tf = takerFee(price, size, cat);
        expect(makerRebate(price, size, cat)).toBeCloseTo(tf * share, 12);
        // share is ≤ 0.5 everywhere → rebate never exceeds the taker fee
        expect(makerRebate(price, size, cat)).toBeLessThanOrEqual(tf + 1e-12);
      }
    }
  });

  it("inherits price symmetry about p=0.5 from takerFee", () => {
    for (const cat of CATEGORIES) {
      for (const price of [0.08, 0.3, 0.42]) {
        expect(makerRebate(price, 100, cat)).toBeCloseTo(makerRebate(1 - price, 100, cat), 12);
      }
    }
  });

  it("is 0 at the boundary prices p=0 and p=1 for every category", () => {
    for (const cat of CATEGORIES) {
      expect(makerRebate(0, 300, cat)).toBe(0);
      expect(makerRebate(1, 300, cat)).toBe(0);
    }
  });

  it("is monotonically non-decreasing in size for fee-bearing cats", () => {
    for (const cat of FEE_BEARING) {
      for (const price of INTERIOR_PRICES) {
        const sizes = [1, 25, 100, 500];
        for (let i = 1; i < sizes.length; i++) {
          expect(makerRebate(price, sizes[i], cat)).toBeGreaterThanOrEqual(
            makerRebate(price, sizes[i - 1], cat),
          );
        }
      }
    }
  });

  it("finance carries the strictly-richest rebate at equal price/size", () => {
    const price = 0.5, size = 100;
    const financeRebate = makerRebate(price, size, "finance");
    for (const cat of CATEGORIES) {
      if (cat === "finance") continue;
      // finance pairs a 0.5 share with a non-trivial peak; no other category
      // produces a larger rebate at this fixed price/size.
      expect(makerRebate(price, size, cat)).toBeLessThanOrEqual(financeRebate + 1e-12);
    }
    expect(financeRebate).toBeGreaterThan(0);
  });
});

describe("effectiveHalfSpread — fee-adjusted spread", () => {
  const DELTA = 0.004;

  it("widens beyond the raw half-spread for fee-bearing cats at interior prices", () => {
    for (const cat of FEE_BEARING) {
      for (const price of [0.2, 0.5, 0.8]) {
        expect(effectiveHalfSpread(DELTA, price, 100, cat)).toBeGreaterThan(DELTA);
      }
    }
  });

  it("equals raw delta exactly when there is no rebate (fee-free cats)", () => {
    for (const cat of FEE_FREE) {
      for (const price of INTERIOR_PRICES) {
        expect(effectiveHalfSpread(DELTA, price, 100, cat)).toBe(DELTA);
      }
    }
  });

  it("equals raw delta at the boundary prices (rebate per share → 0)", () => {
    for (const cat of CATEGORIES) {
      expect(effectiveHalfSpread(DELTA, 0, 100, cat)).toBeCloseTo(DELTA, 12);
      expect(effectiveHalfSpread(DELTA, 1, 100, cat)).toBeCloseTo(DELTA, 12);
    }
  });

  it("equals raw delta for size ≤ 0 (per-share guard returns delta)", () => {
    for (const cat of FEE_BEARING) {
      expect(effectiveHalfSpread(DELTA, 0.5, 0, cat)).toBe(DELTA);
      expect(effectiveHalfSpread(DELTA, 0.5, -50, cat)).toBe(DELTA);
    }
  });

  it("is independent of size for size>0 (rebate-per-share cancels the size factor)", () => {
    const rnd = lcg(0x9E3779B9);
    for (const cat of FEE_BEARING) {
      const price = 0.3 + rnd() * 0.4;
      const a = effectiveHalfSpread(DELTA, price, 10, cat);
      const b = effectiveHalfSpread(DELTA, price, 777, cat);
      expect(a).toBeCloseTo(b, 12);
    }
  });

  it("equals delta + share·peak·price·(1-price)·4 (closed form) for size>0", () => {
    const rnd = lcg(0x2468);
    for (const cat of FEE_BEARING) {
      const [peak, share] = FEE_CATEGORIES[cat];
      for (let i = 0; i < 6; i++) {
        const price = 0.05 + rnd() * 0.9;
        const size = 1 + Math.floor(rnd() * 300);
        const expected = DELTA + share * peak * price * (1 - price) * 4;
        expect(effectiveHalfSpread(DELTA, price, size, cat)).toBeCloseTo(expected, 10);
      }
    }
  });

  it("is monotonically non-decreasing in the raw delta input", () => {
    for (const cat of FEE_BEARING) {
      const deltas = [0, 0.001, 0.005, 0.02];
      for (let i = 1; i < deltas.length; i++) {
        expect(effectiveHalfSpread(deltas[i], 0.5, 100, "finance")).toBeGreaterThanOrEqual(
          effectiveHalfSpread(deltas[i - 1], 0.5, 100, cat) - 1e-12,
        );
        expect(effectiveHalfSpread(deltas[i], 0.5, 100, cat)).toBeGreaterThan(
          effectiveHalfSpread(deltas[i - 1], 0.5, 100, cat),
        );
      }
    }
  });
});

describe("cross-category invariants", () => {
  it("every category has a non-negative peak rate and a share in [0,1]", () => {
    for (const cat of CATEGORIES) {
      const [peak, share] = FEE_CATEGORIES[cat];
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
    }
  });

  it("higher peak rate ⇒ higher taker fee at fixed interior price/size", () => {
    // crypto has the highest peak (0.018); compare against a lower-peak cat.
    const price = 0.5, size = 100;
    expect(takerFee(price, size, "crypto")).toBeGreaterThan(takerFee(price, size, "sports"));
    expect(takerFee(price, size, "sports")).toBeGreaterThan(takerFee(price, size, "geopolitics"));
  });
});
