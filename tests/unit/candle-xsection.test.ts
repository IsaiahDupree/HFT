import { describe, it, expect } from "vitest";
import {
  xsectionWeights, efficiencyTrending, xsectionReturns, buildPriceSeries,
  defaultXSectionVariants, type PriceSeries, type XSectionVariant,
} from "@/lib/backtest/candle/xsection";

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const gross = (a: number[]) => a.reduce((s, x) => s + Math.abs(x), 0);

// Build a PriceSeries from coin → [closes], days = 0,1,2,...
function series(prices: Record<string, number[]>): { coins: string[]; data: PriceSeries; days: number[] } {
  const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
  for (const c of Object.keys(prices)) rows[c] = prices[c].map((close, i) => ({ start_unix: i, close }));
  return buildPriceSeries(rows);
}

describe("xsection — xsectionWeights (market-neutral invariants)", () => {
  it("is dollar-neutral (Σw ≈ 0) and gross-normalized (Σ|w| ≈ 1)", () => {
    for (const lr of [[0.1, -0.1, 0.05, -0.05], [0.2, 0.1, -0.3, 0.4, -0.1], [1, 2, 3, 4]]) {
      const w = xsectionWeights(lr, -1);
      expect(sum(w)).toBeCloseTo(0, 10);
      expect(gross(w)).toBeCloseTo(1, 10);
    }
  });

  it("momentum (sign −1) longs the highest look-back return; reversal (sign +1) shorts it", () => {
    const lr = [0.3, 0.1, -0.1, -0.3];
    const mom = xsectionWeights(lr, -1);
    const rev = xsectionWeights(lr, 1);
    expect(mom[0]).toBeGreaterThan(0);          // best performer → long under momentum
    expect(mom[3]).toBeLessThan(0);             // worst → short
    expect(rev[0]).toBeLessThan(0);             // exact opposite under reversal
    expect(rev).toEqual(mom.map((x) => -x));    // sign just flips the sign of every weight
  });

  it("zero cross-sectional dispersion → all-zero weights (no position)", () => {
    expect(xsectionWeights([0.05, 0.05, 0.05], -1)).toEqual([0, 0, 0]);
  });

  it("two-coin cross-section → ±0.5 (long the winner, short the loser)", () => {
    const w = xsectionWeights([0.2, -0.2], -1);
    expect(w[0]).toBeCloseTo(0.5, 10);
    expect(w[1]).toBeCloseTo(-0.5, 10);
  });

  it("is deterministic", () => {
    const lr = [0.11, -0.07, 0.03, -0.02, 0.15];
    expect(xsectionWeights(lr, -1)).toEqual(xsectionWeights(lr, -1));
  });
});

describe("xsection — efficiencyTrending (Mandelbrot efficiency ratio)", () => {
  const ramp = Array.from({ length: 30 }, (_, i) => 100 + i);          // straight line → efficiency 1
  const zig = Array.from({ length: 30 }, (_, i) => (i % 2 ? 105 : 100)); // zigzag → efficiency ~0

  it("a straight ramp is trending (efficiency 1.0 ≥ threshold)", () => {
    expect(efficiencyTrending(ramp, 25, 20, 0.3)).toBe(true);
  });
  it("a pure zigzag is NOT trending (efficiency ~0)", () => {
    expect(efficiencyTrending(zig, 25, 20, 0.3)).toBe(false);
  });
  it("returns false at the left edge (i < window)", () => {
    expect(efficiencyTrending(ramp, 5, 20, 0.3)).toBe(false);
  });
  it("returns false on any missing value inside the window (never looks ahead)", () => {
    const withGap = [...ramp]; withGap[20] = undefined as unknown as number;
    expect(efficiencyTrending(withGap as Array<number | undefined>, 25, 20, 0.3)).toBe(false);
  });
  it("threshold gates: +2/−1 sawtooth has efficiency ≈ 0.333 → trending at 0.3, not at 0.99", () => {
    const saw: number[] = [100];                       // net +1 per 2 steps, path 3 per 2 steps → eff 1/3
    for (let j = 1; j < 30; j++) saw.push(saw[j - 1] + (j % 2 === 1 ? 2 : -1));
    expect(efficiencyTrending(saw, 25, 20, 0.3)).toBe(true);
    expect(efficiencyTrending(saw, 25, 20, 0.99)).toBe(false);
  });
});

describe("xsection — xsectionReturns (portfolio invariants)", () => {
  const V = (over: Partial<XSectionVariant> = {}): XSectionVariant => ({ label: "t", L: 1, sign: -1, ...over });

  it("a COMMON next-day move nets ~0 (dollar-neutral cancels the market factor), fee-free", () => {
    // look-back returns differ across coins (non-zero weights) but day1→day2 is common +2%
    const { coins, data, days } = series({
      A: [100, 110, 112.2], B: [100, 90, 91.8], C: [100, 105, 107.1], D: [100, 95, 96.9],
    });
    const r = xsectionReturns(V(), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(0, 9);            // R·Σw = R·0 = 0
  });

  it("the SAME book pays exactly the turnover fee when fees are on (Σ|w| = 1 → feeBps/1e4)", () => {
    const p = { A: [100, 110, 112.2], B: [100, 90, 91.8], C: [100, 105, 107.1], D: [100, 95, 96.9] };
    const { coins, data, days } = series(p);
    const r = xsectionReturns(V(), coins, data, days, { feeBps: 100, minCoins: 2, startIndex: 1 });
    expect(r[0]).toBeCloseTo(-100 / 1e4, 9);   // gross 1 × 100bps, opening from flat
  });

  it("captures cross-sectional MOMENTUM: winners-keep-winning → momentum > reversal > and momentum > 0", () => {
    // day1 dispersion, day2 the same ranking continues (winner +10%, loser −10%)
    const p = { A: [100, 120, 132], B: [100, 110, 115.5], C: [100, 90, 85.5], D: [100, 80, 72] };
    const { coins, data, days } = series(p);
    const mom = xsectionReturns(V({ sign: -1 }), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    const rev = xsectionReturns(V({ sign: 1 }), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    expect(mom[0]).toBeGreaterThan(0);
    expect(rev[0]).toBeCloseTo(-mom[0], 9);
  });

  it("skips a day with fewer than minCoins eligible (return 0)", () => {
    const { coins, data, days } = series({ A: [100, 110, 121], B: [100, 90, 81] });
    const r = xsectionReturns(V({ sign: -1 }), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    expect(r.every((x) => x === 0)).toBe(true);
  });

  it("has NO LOOKAHEAD: perturbing a far-future price leaves earlier returns unchanged", () => {
    const p: Record<string, number[]> = {
      A: [100, 102, 101, 104, 106, 103, 108, 110],
      B: [100, 99, 101, 98, 100, 102, 99, 101],
      C: [100, 101, 103, 102, 104, 101, 105, 107],
      D: [100, 98, 97, 99, 96, 98, 95, 97],
    };
    const base = series(p);
    const r0 = xsectionReturns(V(), base.coins, base.data, base.days, { feeBps: 5, minCoins: 3, startIndex: 1 });
    const p2 = { ...p, A: [...p.A] }; p2.A[7] = 999;                 // mutate ONLY the last day
    const pert = series(p2);
    const r1 = xsectionReturns(V(), pert.coins, pert.data, pert.days, { feeBps: 5, minCoins: 3, startIndex: 1 });
    expect(r1.slice(0, r1.length - 1)).toEqual(r0.slice(0, r0.length - 1)); // all but the last unchanged
    expect(r1.at(-1)).not.toBe(r0.at(-1));                          // the last DID use day-7 (sanity)
  });

  it("fee monotonicity: more fee never increases total return when there is turnover", () => {
    const p = { A: [100, 120, 90, 130], B: [100, 90, 120, 95], C: [100, 110, 100, 115], D: [100, 95, 105, 92] };
    const { coins, data, days } = series(p);
    const lo = sum(xsectionReturns(V(), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 }));
    const hi = sum(xsectionReturns(V(), coins, data, days, { feeBps: 80, minCoins: 3, startIndex: 1 }));
    expect(hi).toBeLessThan(lo);
  });

  it("trend-gated variant never trades in pure chop (all returns 0)", () => {
    const p: Record<string, number[]> = {};
    for (const c of ["A", "B", "C", "D"]) p[c] = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 5 : 0) + (c === "A" ? i * 0.01 : 0));
    const { coins, data, days } = series(p);
    const bench = days.map((d) => data.A.get(d)); // choppy benchmark
    const r = xsectionReturns({ label: "momT", L: 5, sign: -1, trendOnly: true }, coins, data, days,
      { feeBps: 10, minCoins: 3, startIndex: 5, benchmark: bench, trendWindow: 10, trendThreshold: 0.5 });
    expect(r.every((x) => x === 0)).toBe(true); // chop → flat → never opens → no fees
  });
});

describe("xsection — helpers", () => {
  it("buildPriceSeries dedups+sorts the day index across coins", () => {
    const { coins, days } = buildPriceSeries({
      A: [{ start_unix: 3, close: 1 }, { start_unix: 1, close: 1 }],
      B: [{ start_unix: 2, close: 1 }, { start_unix: 1, close: 1 }],
    });
    expect(coins.sort()).toEqual(["A", "B"]);
    expect(days).toEqual([1, 2, 3]);
  });
  it("defaultXSectionVariants emits paired reversal+momentum per look-back + trend-gated momentum", () => {
    const vs = defaultXSectionVariants([1, 5], [5]);
    expect(vs.map((v) => v.label)).toEqual(["rev-1d", "mom-1d", "rev-5d", "mom-5d", "momT-5d"]);
    expect(vs.filter((v) => v.sign === -1)).toHaveLength(3); // 2 momentum + 1 trend-momentum
    expect(vs.find((v) => v.trendOnly)?.label).toBe("momT-5d");
  });
});
