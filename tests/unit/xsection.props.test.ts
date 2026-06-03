import { describe, it, expect } from "vitest";
import {
  xsectionWeights, efficiencyTrending, xsectionReturns, buildPriceSeries,
  defaultXSectionVariants, type PriceSeries, type XSectionVariant,
} from "@/lib/backtest/candle/xsection";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic seeded LCG (Numerical Recipes constants). No Math.random, no Date.
// ─────────────────────────────────────────────────────────────────────────────
function lcg(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {                     // uniform in [0,1)
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    },
  };
}
// signed uniform in [-1,1)
const rng = (gen: ReturnType<typeof lcg>) => gen.next() * 2 - 1;

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const gross = (a: number[]) => a.reduce((s, x) => s + Math.abs(x), 0);

// PriceSeries from coin → [closes], days = 0,1,2,... (via the real builder).
function series(prices: Record<string, number[]>): { coins: string[]; data: PriceSeries; days: number[] } {
  const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
  for (const c of Object.keys(prices)) rows[c] = prices[c].map((close, i) => ({ start_unix: i, close }));
  return buildPriceSeries(rows);
}
const V = (over: Partial<XSectionVariant> = {}): XSectionVariant => ({ label: "t", L: 1, sign: -1, ...over });

// ═════════════════════════════════════════════════════════════════════════════
describe("buildPriceSeries — properties", () => {
  it("coins are exactly Object.keys(rows), in insertion order", () => {
    const rows = {
      ZED: [{ start_unix: 5, close: 1 }],
      alpha: [{ start_unix: 2, close: 2 }],
      m: [{ start_unix: 9, close: 3 }],
    };
    expect(buildPriceSeries(rows).coins).toEqual(["ZED", "alpha", "m"]);
  });

  it("every coin's map returns exactly the close that was supplied for each day", () => {
    const gen = lcg(11);
    const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
    const expected: Record<string, Map<number, number>> = {};
    for (const c of ["A", "B", "C"]) {
      const arr: Array<{ start_unix: number; close: number }> = [];
      const exp = new Map<number, number>();
      for (let d = 0; d < 12; d++) {
        const close = 100 + rng(gen) * 50;
        arr.push({ start_unix: d, close });
        exp.set(d, close);
      }
      rows[c] = arr; expected[c] = exp;
    }
    const { coins, data } = buildPriceSeries(rows);
    for (const c of coins) for (const [d, v] of expected[c]) expect(data[c].get(d)).toBe(v);
  });

  it("days are sorted strictly ascending and unique over LCG-scrambled inputs", () => {
    const gen = lcg(7);
    // generate a random pool of unix stamps, shuffle into coins
    const stamps = Array.from(new Set(Array.from({ length: 40 }, () => Math.floor(gen.next() * 200))));
    const rows: Record<string, Array<{ start_unix: number; close: number }>> = { X: [], Y: [] };
    for (const u of stamps) rows[gen.next() < 0.5 ? "X" : "Y"].push({ start_unix: u, close: 1 });
    const { days } = buildPriceSeries(rows);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeGreaterThan(days[i - 1]); // ascending + unique
  });

  it("the day index is exactly the de-duplicated union of all coins' stamps", () => {
    const rows = {
      A: [{ start_unix: 3, close: 1 }, { start_unix: 1, close: 1 }],
      B: [{ start_unix: 1, close: 1 }, { start_unix: 4, close: 1 }],
      C: [{ start_unix: 4, close: 1 }, { start_unix: 9, close: 1 }],
    };
    const { days } = buildPriceSeries(rows);
    const unionSorted = [...new Set([3, 1, 1, 4, 4, 9])].sort((a, b) => a - b);
    expect(days).toEqual(unionSorted);
  });

  it("a bar that is simply absent for a coin is absent from that coin's map (has === false)", () => {
    // A has every day; B is missing day 2.
    const rows = {
      A: [0, 1, 2, 3].map((d) => ({ start_unix: d, close: 10 + d })),
      B: [0, 1, 3].map((d) => ({ start_unix: d, close: 20 + d })),
    };
    const { data, days } = buildPriceSeries(rows);
    expect(data.B.has(2)).toBe(false);                 // the missing bar
    expect(data.A.has(2)).toBe(true);
    expect(days).toContain(2);                          // still in the union (A supplied it)
  });

  it("each coin's map size equals its count of DISTINCT start_unix (duplicates collapse)", () => {
    const rows = {
      A: [{ start_unix: 1, close: 1 }, { start_unix: 1, close: 2 }, { start_unix: 2, close: 3 }],
      B: [{ start_unix: 5, close: 1 }],
    };
    const { data } = buildPriceSeries(rows);
    expect(data.A.size).toBe(2);                        // 1 and 2 (the two `1`s collapse)
    expect(data.B.size).toBe(1);
  });

  it("on a duplicate start_unix the LAST close wins (Map.set overwrite)", () => {
    const rows = { A: [{ start_unix: 7, close: 111 }, { start_unix: 7, close: 222 }] };
    expect(buildPriceSeries(rows).data.A.get(7)).toBe(222);
  });

  it("every key of every coin's map is a member of the returned day index", () => {
    const { data, days, coins } = series({ A: [1, 2, 3, 4], B: [9, 8, 7, 6] });
    const daySet = new Set(days);
    for (const c of coins) for (const k of data[c].keys()) expect(daySet.has(k)).toBe(true);
  });

  it("empty rows → empty coins, empty data, empty days", () => {
    const { coins, data, days } = buildPriceSeries({});
    expect(coins).toEqual([]);
    expect(days).toEqual([]);
    expect(Object.keys(data)).toEqual([]);
  });

  it("handles a coin with zero bars → empty map but still listed as a coin", () => {
    const { coins, data, days } = buildPriceSeries({ A: [{ start_unix: 0, close: 1 }], EMPTY: [] });
    expect(coins).toContain("EMPTY");
    expect(data.EMPTY.size).toBe(0);
    expect(days).toEqual([0]);                          // EMPTY contributes no days
  });

  it("preserves zero and negative unix stamps and still sorts them ascending", () => {
    const rows = { A: [{ start_unix: 0, close: 1 }, { start_unix: -10, close: 1 }, { start_unix: 5, close: 1 }] };
    expect(buildPriceSeries(rows).days).toEqual([-10, 0, 5]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("xsectionWeights — properties", () => {
  it("over many LCG vectors with dispersion: Σw ≈ 0 and Σ|w| ≈ 1", () => {
    const gen = lcg(2024);
    for (let t = 0; t < 30; t++) {
      const n = 3 + Math.floor(gen.next() * 8);
      const lr = Array.from({ length: n }, () => rng(gen));
      const w = xsectionWeights(lr, gen.next() < 0.5 ? 1 : -1);
      // dispersion is essentially guaranteed for random reals; if degenerate, skip the gross check
      if (gross(w) === 0) continue;
      expect(sum(w)).toBeCloseTo(0, 9);
      expect(gross(w)).toBeCloseTo(1, 9);
    }
  });

  it("reversal is the exact negation of momentum, for random vectors", () => {
    const gen = lcg(55);
    for (let t = 0; t < 20; t++) {
      const lr = Array.from({ length: 5 }, () => rng(gen));
      const mom = xsectionWeights(lr, -1);
      const rev = xsectionWeights(lr, 1);
      for (let i = 0; i < lr.length; i++) expect(rev[i]).toBeCloseTo(-mom[i], 12);
    }
  });

  it("z-scoring makes it invariant to an additive shift of every look-back return", () => {
    const gen = lcg(909);
    for (let t = 0; t < 15; t++) {
      const lr = Array.from({ length: 6 }, () => rng(gen));
      const shift = rng(gen) * 3;
      const a = xsectionWeights(lr, -1);
      const b = xsectionWeights(lr.map((x) => x + shift), -1);
      for (let i = 0; i < lr.length; i++) expect(b[i]).toBeCloseTo(a[i], 10);
    }
  });

  it("is invariant to a POSITIVE scaling of every look-back return (z-score absorbs scale)", () => {
    const gen = lcg(313);
    for (let t = 0; t < 15; t++) {
      const lr = Array.from({ length: 6 }, () => rng(gen) + 2); // shifted off zero
      const a = xsectionWeights(lr, -1);
      const b = xsectionWeights(lr.map((x) => x * 4.7), -1);
      for (let i = 0; i < lr.length; i++) expect(b[i]).toBeCloseTo(a[i], 10);
    }
  });

  it("only the SIGN of `sign` matters, not its magnitude (normalization absorbs |sign|)", () => {
    const gen = lcg(404);
    const lr = Array.from({ length: 7 }, () => rng(gen));
    const w1 = xsectionWeights(lr, -1);
    const w3 = xsectionWeights(lr, -3);
    for (let i = 0; i < lr.length; i++) expect(w3[i]).toBeCloseTo(w1[i], 12);
  });

  it("under momentum the weight order matches the return order (higher return → higher weight)", () => {
    const gen = lcg(77);
    const lr = Array.from({ length: 8 }, () => rng(gen));
    const w = xsectionWeights(lr, -1);
    const idx = lr.map((_, i) => i).sort((a, b) => lr[a] - lr[b]);
    for (let k = 1; k < idx.length; k++) expect(w[idx[k]]).toBeGreaterThanOrEqual(w[idx[k - 1]] - 1e-12);
  });

  it("momentum longs the argmax look-back return and shorts the argmin", () => {
    const gen = lcg(88);
    for (let t = 0; t < 10; t++) {
      const lr = Array.from({ length: 6 }, () => rng(gen));
      const w = xsectionWeights(lr, -1);
      let hi = 0, lo = 0;
      for (let i = 1; i < lr.length; i++) { if (lr[i] > lr[hi]) hi = i; if (lr[i] < lr[lo]) lo = i; }
      expect(w[hi]).toBeGreaterThan(0);
      expect(w[lo]).toBeLessThan(0);
    }
  });

  it("preserves input length and returns finite numbers", () => {
    const gen = lcg(1212);
    for (const n of [2, 3, 5, 9]) {
      const lr = Array.from({ length: n }, () => rng(gen));
      const w = xsectionWeights(lr, -1);
      expect(w).toHaveLength(n);
      for (const x of w) expect(Number.isFinite(x)).toBe(true);
    }
  });

  it("zero cross-sectional dispersion → all-zero weights for any constant vector", () => {
    const gen = lcg(33);
    for (let t = 0; t < 8; t++) {
      const c = rng(gen);
      expect(xsectionWeights([c, c, c, c], -1)).toEqual([0, 0, 0, 0]);
    }
  });

  it("negating every look-back return negates every momentum weight", () => {
    const gen = lcg(9090);
    const lr = Array.from({ length: 6 }, () => rng(gen));
    const a = xsectionWeights(lr, -1);
    const b = xsectionWeights(lr.map((x) => -x), -1);
    for (let i = 0; i < lr.length; i++) expect(b[i]).toBeCloseTo(-a[i], 10);
  });

  it("single-element vector has zero dispersion → zero weight (no position)", () => {
    expect(xsectionWeights([0.42], -1)).toEqual([0]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("efficiencyTrending — properties", () => {
  it("the efficiency ratio is bounded in [0,1] → trending at threshold 0, never at >1", () => {
    const gen = lcg(606);
    const s = Array.from({ length: 40 }, () => 100 + rng(gen) * 10);
    for (let i = 20; i < s.length; i++) {
      expect(efficiencyTrending(s, i, 20, 0)).toBe(true);   // ratio ≥ 0 always (path>0 here)
      expect(efficiencyTrending(s, i, 20, 1.0001)).toBe(false); // ratio ≤ 1 always
    }
  });

  it("a strictly monotonic series has efficiency 1 → trending at every threshold ≤ 1", () => {
    const gen = lcg(71);
    const up = [100];
    for (let i = 1; i < 40; i++) up.push(up[i - 1] + 0.1 + gen.next()); // strictly increasing
    for (const th of [0.3, 0.5, 0.9, 1.0]) expect(efficiencyTrending(up, 30, 20, th)).toBe(true);
  });

  it("higher threshold can never flip a non-trending window into trending (monotone in threshold)", () => {
    const gen = lcg(4242);
    const s = Array.from({ length: 50 }, () => 100 + rng(gen) * 8);
    for (let i = 20; i < s.length; i += 3) {
      const ths = [0.1, 0.3, 0.5, 0.7, 0.9, 1.1];
      const flags = ths.map((th) => efficiencyTrending(s, i, 20, th));
      for (let k = 1; k < flags.length; k++) if (flags[k]) expect(flags[k - 1]).toBe(true);
    }
  });

  it("returns false at every left-edge index i < window", () => {
    const gen = lcg(15);
    const s = Array.from({ length: 30 }, (_, i) => 100 + i + rng(gen));
    for (let i = 0; i < 20; i++) expect(efficiencyTrending(s, i, 20, 0.3)).toBe(false);
  });

  it("false when the window's right endpoint (series[i]) is missing", () => {
    const s: Array<number | undefined> = Array.from({ length: 30 }, (_, i) => 100 + i);
    s[25] = undefined;
    expect(efficiencyTrending(s, 25, 20, 0.3)).toBe(false);
  });

  it("false when the window's left endpoint (series[i-window]) is missing", () => {
    const s: Array<number | undefined> = Array.from({ length: 30 }, (_, i) => 100 + i);
    s[5] = undefined;
    expect(efficiencyTrending(s, 25, 20, 0.3)).toBe(false);
  });

  it("false on any interior gap inside the path (never looks past `i`, never NaNs)", () => {
    const gen = lcg(202);
    for (const gapAt of [10, 15, 20]) {
      const s: Array<number | undefined> = Array.from({ length: 30 }, (_, i) => 100 + i + rng(gen));
      s[gapAt] = undefined;
      expect(efficiencyTrending(s, 25, 20, 0.3)).toBe(false);
    }
  });

  it("a perfectly flat window has zero path → not trending at any positive threshold", () => {
    const flat = new Array(30).fill(100);
    expect(efficiencyTrending(flat, 25, 20, 0.3)).toBe(false);
    expect(efficiencyTrending(flat, 25, 20, 0.0001)).toBe(false); // path>0 is required
  });

  it("matches a hand-computed efficiency ratio for a known +2/−1 sawtooth", () => {
    // step pattern alternating +2,−1 → over 20 steps net = 10*2 + 10*(−1)=10, path=10*2+10*1=30 → 1/3
    const saw: number[] = [100];
    for (let j = 1; j < 30; j++) saw.push(saw[j - 1] + (j % 2 === 1 ? 2 : -1));
    expect(efficiencyTrending(saw, 21, 20, 0.33)).toBe(true);
    expect(efficiencyTrending(saw, 21, 20, 0.34)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("xsectionReturns — properties", () => {
  it("with no trend gate every interior day yields a return → length = days−1−startIndex", () => {
    const gen = lcg(500);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) prices[c] = Array.from({ length: 15 }, () => 100 + rng(gen) * 30 + 30);
    const { coins, data, days } = series(prices);
    for (const start of [1, 3, 5]) {
      const r = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: start });
      expect(r).toHaveLength(days.length - 1 - start);
    }
  });

  it("NO-LOOKAHEAD over a randomized panel: perturbing ONLY the final bar changes only the last return", () => {
    const gen = lcg(13579);
    const base: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D", "E"]) base[c] = Array.from({ length: 14 }, () => 100 + rng(gen) * 40 + 40);
    const b = series(base);
    const r0 = xsectionReturns(V({ L: 2 }), b.coins, b.data, b.days, { feeBps: 7, minCoins: 4, startIndex: 2 });

    const pert = { ...base, A: [...base.A] };
    pert.A[pert.A.length - 1] = 9999;                    // mutate only the last day for coin A
    const p = series(pert);
    const r1 = xsectionReturns(V({ L: 2 }), p.coins, p.data, p.days, { feeBps: 7, minCoins: 4, startIndex: 2 });

    expect(r1.slice(0, -1)).toEqual(r0.slice(0, -1));     // all earlier returns identical
    expect(r1.at(-1)).not.toBe(r0.at(-1));                // the last one DID consume the final bar
  });

  it("the realized return equals Σ w·nextReturn minus opening turnover (recomputed by hand) on bar 0", () => {
    // 4 coins, distinct look-back returns, fee on. Reproduce the internal math independently.
    const p = { A: [100, 110, 115], B: [100, 90, 99], C: [100, 105, 99.75], D: [100, 95, 104.5] };
    const { coins, data, days } = series(p);
    const feeBps = 30;
    const r = xsectionReturns(V({ L: 1, sign: -1 }), coins, data, days, { feeBps, minCoins: 4, startIndex: 1 });
    const lret = coins.map((c) => data[c].get(1)! / data[c].get(0)! - 1);
    const w = xsectionWeights(lret, -1);
    const nret = coins.map((c) => data[c].get(2)! / data[c].get(1)! - 1);
    const pr = w.reduce((s, wi, i) => s + wi * nret[i], 0);
    const turn = gross(w);                                // opening from flat → turnover = Σ|w|
    expect(r[0]).toBeCloseTo(pr - turn * feeBps / 1e4, 9);
  });

  it("a common multiplicative next-day shock nets ≈ 0 (dollar-neutral kills the market factor), fee-free", () => {
    const gen = lcg(246);
    // day0→day1 dispersed; day1→day2 a single common factor for everyone
    const shock = 1.037;
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D", "E"]) {
      const p1 = 100 * (1 + rng(gen) * 0.3);
      prices[c] = [100, p1, p1 * shock];
    }
    const { coins, data, days } = series(prices);
    const r = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    expect(r[0]).toBeCloseTo(0, 8);
  });

  it("zero look-back dispersion on a bar → that bar earns exactly 0 (no position taken)", () => {
    // every coin has the SAME day0→day1 return (so weights are all-zero), then dispersed day1→day2
    const p = { A: [100, 110, 130], B: [100, 110, 95], C: [100, 110, 120], D: [100, 110, 105] };
    const { coins, data, days } = series(p);
    const r = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 50, minCoins: 4, startIndex: 1 });
    expect(r[0]).toBe(0);                                 // no dispersion → flat → not even a fee
  });

  it("returns 0 on any bar with fewer than minCoins eligible", () => {
    const { coins, data, days } = series({ A: [100, 110, 121], B: [100, 90, 81] });
    const r = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    expect(r.every((x) => x === 0)).toBe(true);
  });

  it("a coin missing the look-back, current, or next bar is excluded from eligibility that day", () => {
    // D is missing its day0 close → ineligible at bar 1; with minCoins 4 the bar goes flat (return 0)
    const rows = {
      A: [0, 1, 2].map((d) => ({ start_unix: d, close: 100 + d * 5 })),
      B: [0, 1, 2].map((d) => ({ start_unix: d, close: 100 - d * 3 })),
      C: [0, 1, 2].map((d) => ({ start_unix: d, close: 100 + d * 2 })),
      D: [1, 2].map((d) => ({ start_unix: d, close: 100 + d })), // no day 0
    };
    const { coins, data, days } = buildPriceSeries(rows);
    const r = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    expect(r[0]).toBe(0);                                 // only 3 eligible (A,B,C) < minCoins
  });

  it("fee monotonicity: total return is non-increasing in feeBps whenever there is turnover", () => {
    const gen = lcg(31415);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) prices[c] = Array.from({ length: 10 }, () => 100 + rng(gen) * 60 + 40);
    const { coins, data, days } = series(prices);
    let prev = Infinity;
    for (const fee of [0, 20, 50, 100, 200]) {
      const tot = sum(xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: fee, minCoins: 4, startIndex: 1 }));
      expect(tot).toBeLessThanOrEqual(prev + 1e-12);
      prev = tot;
    }
  });

  it("is deterministic: identical inputs produce an identical return series", () => {
    const gen = lcg(2718);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) prices[c] = Array.from({ length: 12 }, () => 100 + rng(gen) * 50 + 25);
    const { coins, data, days } = series(prices);
    const a = xsectionReturns(V({ L: 2 }), coins, data, days, { feeBps: 12, minCoins: 4, startIndex: 2 });
    const b = xsectionReturns(V({ L: 2 }), coins, data, days, { feeBps: 12, minCoins: 4, startIndex: 2 });
    expect(a).toEqual(b);
  });

  it("every produced return is a finite number (no NaN/Infinity leakage)", () => {
    const gen = lcg(8675309);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D", "E"]) prices[c] = Array.from({ length: 20 }, () => 100 + rng(gen) * 80 + 40);
    const { coins, data, days } = series(prices);
    const r = xsectionReturns(V({ L: 3 }), coins, data, days, { feeBps: 15, minCoins: 4, startIndex: 3 });
    for (const x of r) expect(Number.isFinite(x)).toBe(true);
  });

  it("momentum and reversal are exact mirror images bar-for-bar, fee-free", () => {
    const gen = lcg(1001);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) prices[c] = Array.from({ length: 10 }, () => 100 + rng(gen) * 40 + 30);
    const { coins, data, days } = series(prices);
    const mom = xsectionReturns(V({ sign: -1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    const rev = xsectionReturns(V({ sign: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    expect(mom).toHaveLength(rev.length);
    for (let i = 0; i < mom.length; i++) expect(rev[i]).toBeCloseTo(-mom[i], 10);
  });

  it("a larger startIndex yields a shorter (suffix-aligned) series", () => {
    const gen = lcg(424242);
    const prices: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) prices[c] = Array.from({ length: 16 }, () => 100 + rng(gen) * 50 + 30);
    const { coins, data, days } = series(prices);
    const a = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 2 });
    const b = xsectionReturns(V({ L: 1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 5 });
    expect(b.length).toBe(a.length - 3);
  });

  it("the trend-gated variant in pure chop only ever charges turnover-on-close, never opens a fresh position", () => {
    // benchmark is a tight zigzag → efficiencyTrending false everywhere → every bar goes flat
    const p: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) p[c] = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 4 : 0) + (c === "A" ? i * 0.01 : 0));
    const { coins, data, days } = series(p);
    const bench = days.map((d) => data.A.get(d));
    const r = xsectionReturns({ label: "momT", L: 5, sign: -1, trendOnly: true }, coins, data, days,
      { feeBps: 10, minCoins: 4, startIndex: 5, benchmark: bench, trendWindow: 10, trendThreshold: 0.5 });
    // never trending → starts flat → no open position to close → all returns exactly 0
    expect(r.every((x) => x === 0)).toBe(true);
    expect(r.every((x) => x <= 0)).toBe(true); // any non-zero could only be a (negative) close fee
  });

  it("with feeBps=0 the first bar's return is exactly Σ w·nextReturn (turnover is free)", () => {
    const p = { A: [100, 130, 143], B: [100, 110, 99], C: [100, 90, 99], D: [100, 70, 84] };
    const { coins, data, days } = series(p);
    const r = xsectionReturns(V({ L: 1, sign: -1 }), coins, data, days, { feeBps: 0, minCoins: 4, startIndex: 1 });
    const lret = coins.map((c) => data[c].get(1)! / data[c].get(0)! - 1);
    const w = xsectionWeights(lret, -1);
    const nret = coins.map((c) => data[c].get(2)! / data[c].get(1)! - 1);
    expect(r[0]).toBeCloseTo(w.reduce((s, wi, i) => s + wi * nret[i], 0), 10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("defaultXSectionVariants — properties", () => {
  it("count = 2×|lookbacks| + |trendLookbacks| for arbitrary grids", () => {
    const gen = lcg(99);
    for (let t = 0; t < 6; t++) {
      const nL = 1 + Math.floor(gen.next() * 5);
      const nT = Math.floor(gen.next() * 4);
      const lbs = Array.from({ length: nL }, (_, i) => i + 1);
      const tbs = Array.from({ length: nT }, (_, i) => (i + 1) * 5);
      expect(defaultXSectionVariants(lbs, tbs)).toHaveLength(2 * nL + nT);
    }
  });

  it("every plain lookback emits a rev (sign +1) and a mom (sign −1) with that L", () => {
    const vs = defaultXSectionVariants([2, 7], []);
    expect(vs.find((v) => v.label === "rev-2d")).toMatchObject({ L: 2, sign: 1 });
    expect(vs.find((v) => v.label === "mom-2d")).toMatchObject({ L: 2, sign: -1 });
    expect(vs.find((v) => v.label === "rev-7d")).toMatchObject({ L: 7, sign: 1 });
    expect(vs.find((v) => v.label === "mom-7d")).toMatchObject({ L: 7, sign: -1 });
  });

  it("every trend-gated variant is momentum (sign −1) with trendOnly true and label momT-{L}d", () => {
    const vs = defaultXSectionVariants([1], [3, 8]);
    const t = vs.filter((v) => v.trendOnly);
    expect(t.map((v) => v.label)).toEqual(["momT-3d", "momT-8d"]);
    for (const v of t) { expect(v.sign).toBe(-1); expect(v.trendOnly).toBe(true); }
  });

  it("non-trend variants never set trendOnly", () => {
    for (const v of defaultXSectionVariants([1, 5], [5])) {
      if (!v.label.startsWith("momT")) expect(v.trendOnly).toBeUndefined();
    }
  });

  it("all emitted labels are unique", () => {
    const labels = defaultXSectionVariants([1, 2, 3, 5, 10, 20], [5, 10, 20]).map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the default-arg grid has the documented shape (6 lookbacks ×2 + 3 trend = 15)", () => {
    expect(defaultXSectionVariants()).toHaveLength(15);
  });
});
