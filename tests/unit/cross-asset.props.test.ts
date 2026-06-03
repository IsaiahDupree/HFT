import { describe, it, expect } from "vitest";
import {
  relativeStrengthReturns,
  defaultRelStrengthVariants,
  btcRegimeFilter,
  alignClosesByTimestamp,
  equalWeightBuyHoldReturns,
} from "@/lib/backtest/candle/cross-asset";
import type { PriceSeries } from "@/lib/backtest/candle/xsection";

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random, no Date) — small seeded LCG.
// ---------------------------------------------------------------------------
function lcg(seed: number): () => number {
  // Numerical Recipes LCG; returns a float in [0,1).
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Build a PriceSeries from per-coin close arrays indexed by day 0..n-1. */
function mk(prices: Record<string, number[]>): { coins: string[]; data: PriceSeries; days: number[] } {
  const coins = Object.keys(prices);
  const data: PriceSeries = {};
  const allDays = new Set<number>();
  for (const c of coins) {
    const m = new Map<number, number>();
    prices[c].forEach((p, i) => {
      m.set(i, p);
      allDays.add(i);
    });
    data[c] = m;
  }
  return { coins, data, days: [...allDays].sort((a, b) => a - b) };
}

/** Build a deterministic random positive-price walk for `coins` of length `n`. */
function randomPrices(seed: number, coins: string[], n: number, drift = 0): Record<string, number[]> {
  const rnd = lcg(seed);
  const out: Record<string, number[]> = {};
  for (const c of coins) {
    const arr: number[] = [100];
    for (let i = 1; i < n; i++) {
      // multiplicative step in (0.9 + drift, 1.1 + drift) — always positive
      const step = 0.9 + drift + 0.2 * rnd();
      arr.push(arr[i - 1] * step);
    }
    out[c] = arr;
  }
  return out;
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const V = (L: number, topK: number) => ({ label: `rs${L}/top${topK}`, L, topK });

// ===========================================================================
describe("relativeStrengthReturns — properties", () => {
  it("output length is always (days.length - 1 - startIndex) for in-range startIndex", () => {
    const { coins, data, days } = mk(randomPrices(11, ["A", "B", "C"], 12));
    for (const start of [1, 2, 3, 5]) {
      const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 5, startIndex: start });
      expect(r).toHaveLength(days.length - 1 - start);
    }
  });

  it("startIndex defaults to v.L when omitted", () => {
    const { coins, data, days } = mk(randomPrices(12, ["A", "B", "C"], 14));
    const explicit = relativeStrengthReturns(V(3, 1), coins, data, days, { feeBps: 0, startIndex: 3 });
    const implicit = relativeStrengthReturns(V(3, 1), coins, data, days, { feeBps: 0 });
    expect(implicit).toEqual(explicit);
  });

  it("more fee never increases total return (random universe, multiple seeds)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { coins, data, days } = mk(randomPrices(seed, ["A", "B", "C", "D"], 16));
      const lo = sum(relativeStrengthReturns(V(2, 2), coins, data, days, { feeBps: 0, startIndex: 2 }));
      const hi = sum(relativeStrengthReturns(V(2, 2), coins, data, days, { feeBps: 50, startIndex: 2 }));
      expect(hi).toBeLessThanOrEqual(lo + 1e-12);
    }
  });

  it("fee impact is monotone non-increasing across an ascending fee ladder", () => {
    const { coins, data, days } = mk(randomPrices(7, ["A", "B", "C", "D"], 18));
    let prev = Infinity;
    for (const fee of [0, 10, 25, 50, 100, 250]) {
      const tot = sum(relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: fee, startIndex: 1 }));
      expect(tot).toBeLessThanOrEqual(prev + 1e-12);
      prev = tot;
    }
  });

  it("equals the single strongest coin's next return when topK=1, feeBps=0 (matches manual)", () => {
    // L-return at day1: A +30%, B -10%, C 0% → top1 = A; A then +30% day1→day2
    const { coins, data, days } = mk({ A: [100, 130, 169], B: [100, 90, 81], C: [100, 100, 100] });
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 });
    expect(r[0]).toBeCloseTo(169 / 130 - 1, 9);
  });

  it("with zero fee the bar return equals the equal-weight avg of the held coins' next returns", () => {
    // Make A and B the two strongest at day1; C the weakest.
    const { coins, data, days } = mk({ A: [100, 140, 154], B: [100, 130, 143], C: [100, 90, 81] });
    const r = relativeStrengthReturns(V(1, 2), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    const expected = 0.5 * (154 / 140 - 1) + 0.5 * (143 / 130 - 1);
    expect(r[0]).toBeCloseTo(expected, 9);
  });

  it("emits exactly 0 on every bar that has fewer than minCoins eligible coins", () => {
    const { coins, data, days } = mk({ A: [100, 120, 132, 140], B: [100, 110, 115, 120] });
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    expect(r.every((x) => x === 0)).toBe(true);
  });

  it("effective k is capped by the eligible count (topK larger than universe still well-defined)", () => {
    // topK=5 but only 2 coins exist; with minCoins=2 it holds both equal-weight.
    const { coins, data, days } = mk({ A: [100, 130, 143], B: [100, 120, 132] });
    const r = relativeStrengthReturns(V(1, 5), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    const expected = 0.5 * (143 / 130 - 1) + 0.5 * (132 / 120 - 1);
    expect(r[0]).toBeCloseTo(expected, 9);
  });

  it("holding the ENTIRE eligible universe (topK >= N) equals equalWeightBuyHold on the held coins", () => {
    // 3 coins, all eligible every bar, topK=3 → identical to equal-weight buy & hold, fee 0.
    const p = randomPrices(21, ["A", "B", "C"], 12);
    const { coins, data, days } = mk(p);
    const rs = relativeStrengthReturns(V(1, 3), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    const bh = equalWeightBuyHoldReturns(coins, data, days, 1);
    expect(rs).toHaveLength(bh.length);
    for (let i = 0; i < rs.length; i++) expect(rs[i]).toBeCloseTo(bh[i], 9);
  });

  it("is invariant to a uniform price scaling of all coins (returns are ratio-based)", () => {
    const base = randomPrices(31, ["A", "B", "C"], 14);
    const scaled: Record<string, number[]> = {};
    for (const c of Object.keys(base)) scaled[c] = base[c].map((x) => x * 7.3);
    const a = relativeStrengthReturns(V(2, 2), mk(base).coins, mk(base).data, mk(base).days, { feeBps: 10, startIndex: 2 });
    const sb = mk(scaled);
    const b = relativeStrengthReturns(V(2, 2), sb.coins, sb.data, sb.days, { feeBps: 10, startIndex: 2 });
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it("NO LOOKAHEAD — perturbing the LAST close leaves all but the final bar unchanged", () => {
    const p = randomPrices(41, ["A", "B", "C"], 12);
    const r0 = (() => { const m = mk(p); return relativeStrengthReturns(V(2, 1), m.coins, m.data, m.days, { feeBps: 7, startIndex: 2 }); })();
    const p2 = { ...p, A: [...p.A] };
    p2.A[p2.A.length - 1] = 1e7;
    const r1 = (() => { const m = mk(p2); return relativeStrengthReturns(V(2, 1), m.coins, m.data, m.days, { feeBps: 7, startIndex: 2 }); })();
    expect(r1.slice(0, -1)).toEqual(r0.slice(0, -1));
  });

  it("NO LOOKAHEAD — perturbing ANY single future bar leaves all strictly-earlier bars unchanged", () => {
    const p = randomPrices(42, ["A", "B", "C"], 11);
    const m0 = mk(p);
    const r0 = relativeStrengthReturns(V(1, 1), m0.coins, m0.data, m0.days, { feeBps: 3, startIndex: 1 });
    for (let j = 4; j < p.A.length; j++) {
      const p2 = { ...p, B: [...p.B] };
      p2.B[j] = p2.B[j] * 3 + 5;
      const m = mk(p2);
      const r1 = relativeStrengthReturns(V(1, 1), m.coins, m.data, m.days, { feeBps: 3, startIndex: 1 });
      // r1[i] depends on closes at days[i] and days[i+1]; perturbing day j affects bars i=j-1 and i=j.
      // Everything with output index < (j-1)-1 must be untouched. Use a safe earlier slice.
      const safe = Math.max(0, j - 1 - 1 - 1);
      expect(r1.slice(0, safe)).toEqual(r0.slice(0, safe));
    }
  });

  it("a coin missing the tNext bar is excluded from eligibility that rebalance", () => {
    // A is strongest but has no close at the realized-return day → must be dropped.
    const { coins, data, days } = mk({ A: [100, 150, 200], B: [100, 130, 143], C: [100, 120, 132] });
    data.A.delete(2); // remove A's tNext for bar i=1
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    // A dropped → strongest eligible is B; realized = B's 130→143.
    expect(r[0]).toBeCloseTo(143 / 130 - 1, 9);
  });

  it("a coin missing the tPrev bar (lookback anchor) is excluded that rebalance", () => {
    const { coins, data, days } = mk({ A: [100, 150, 165], B: [100, 130, 143], C: [100, 120, 132] });
    data.A.delete(0); // A has no close at tPrev for bar i=1 (L=1 → tPrev=day0)
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, minCoins: 2, startIndex: 1 });
    expect(r[0]).toBeCloseTo(143 / 130 - 1, 9); // B wins among {B,C}
  });

  it("a tie in trailing return still produces a deterministic finite return (no NaN)", () => {
    // A and B have identical trailing returns and identical next returns.
    const { coins, data, days } = mk({ A: [100, 120, 132], B: [100, 120, 132], C: [100, 90, 81] });
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    expect(Number.isFinite(r[0])).toBe(true);
    expect(r[0]).toBeCloseTo(132 / 120 - 1, 9); // either tie winner gives the same 10%
  });

  it("a flat (zero-return) universe yields exactly-zero gross returns at feeBps=0", () => {
    const flat = Array.from({ length: 10 }, () => 100);
    const { coins, data, days } = mk({ A: [...flat], B: [...flat], C: [...flat] });
    const r = relativeStrengthReturns(V(2, 2), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 2 });
    expect(r.every((x) => Math.abs(x) < 1e-12)).toBe(true);
  });

  it("a flat universe with a fee only charges turnover on the OPENING bar, then 0 (stable holding)", () => {
    // Prices never move → all price returns are 0. The first bar opens a full position
    // from empty prevW → turnover 1.0 → fee charged once; later bars hold the same names → 0.
    const flat = Array.from({ length: 10 }, () => 100);
    const { coins, data, days } = mk({ A: [...flat], B: [...flat], C: [...flat] });
    const r = relativeStrengthReturns(V(2, 2), coins, data, days, { feeBps: 100, minCoins: 3, startIndex: 2 });
    expect(r[0]).toBeCloseTo(-1.0 * 100 / 1e4, 9); // opening turnover 1.0 at 100bps
    for (let i = 1; i < r.length; i++) expect(Math.abs(r[i])).toBeLessThan(1e-12);
  });

  it("every bar return is finite for a random eligible universe (no NaN/Infinity)", () => {
    for (const seed of [101, 202, 303]) {
      const { coins, data, days } = mk(randomPrices(seed, ["A", "B", "C", "D"], 20));
      const r = relativeStrengthReturns(V(3, 2), coins, data, days, { feeBps: 15, startIndex: 3 });
      expect(r.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it("fee never flips a winning all-cash (no-rotation, single coin held twice) bar negative on the first bar", () => {
    // On bar 0 prevW is empty so turnover = full notional; the first-bar fee is unavoidable.
    // But a sufficiently small fee keeps a strong winner positive. Property: net = gross - fee.
    const { coins, data, days } = mk({ A: [100, 130, 200], B: [100, 90, 81], C: [100, 95, 90] });
    const gross = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 })[0];
    const net = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 40, startIndex: 1 })[0];
    // First bar opens a full 100% position → turnover 1.0 → fee = 40bps = 0.004.
    expect(net).toBeCloseTo(gross - 0.004, 9);
  });

  it("zero turnover after the first bar means later bars carry no fee when the holding is unchanged", () => {
    // Same coin (A) stays strictly strongest every rebalance → after bar0 turnover is 0.
    const { coins, data, days } = mk({ A: [100, 130, 170, 230, 300], B: [100, 80, 70, 60, 55], C: [100, 90, 85, 80, 78] });
    const gross = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 });
    const net = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 99, startIndex: 1 });
    // Only bar0 differs (full open); bars 1.. identical because A is held throughout.
    for (let i = 1; i < gross.length; i++) expect(net[i]).toBeCloseTo(gross[i], 9);
    expect(net[0]).toBeLessThan(gross[0]);
  });
});

// ===========================================================================
describe("equalWeightBuyHoldReturns — properties", () => {
  it("equals the SINGLE coin's next return when only one coin is eligible each bar", () => {
    const { coins, data, days } = mk({ ONLY: [100, 110, 121, 133.1] });
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    expect(r[0]).toBeCloseTo(110 / 100 - 1, 9);
    expect(r[1]).toBeCloseTo(121 / 110 - 1, 9);
    expect(r[2]).toBeCloseTo(133.1 / 121 - 1, 9);
  });

  it("equals the single-coin return on bars where all but one coin lack the needed bars", () => {
    const { coins, data, days } = mk({ A: [100, 110, 121], B: [100, 105, 110] });
    data.B.delete(1);
    data.B.delete(2); // B never eligible → reduces to A alone
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    expect(r[0]).toBeCloseTo(110 / 100 - 1, 9);
    expect(r[1]).toBeCloseTo(121 / 110 - 1, 9);
  });

  it("output length equals days.length - 1 - startIndex for valid startIndex", () => {
    const { coins, data, days } = mk(randomPrices(51, ["A", "B"], 13));
    for (const start of [0, 1, 2, 4]) {
      expect(equalWeightBuyHoldReturns(coins, data, days, start)).toHaveLength(days.length - 1 - start);
    }
  });

  it("is the unweighted mean of per-coin next returns (matches an independent recompute)", () => {
    const p = randomPrices(61, ["A", "B", "C", "D"], 10);
    const { coins, data, days } = mk(p);
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    for (let i = 0; i < r.length; i++) {
      const expected =
        coins.reduce((s, c) => s + (p[c][i + 1] / p[c][i] - 1), 0) / coins.length;
      expect(r[i]).toBeCloseTo(expected, 9);
    }
  });

  it("is invariant to per-coin uniform price scaling (returns are ratios)", () => {
    const base = randomPrices(62, ["A", "B", "C"], 12);
    const scaled: Record<string, number[]> = {};
    const factors: Record<string, number> = { A: 3, B: 0.01, C: 555 };
    for (const c of Object.keys(base)) scaled[c] = base[c].map((x) => x * factors[c]);
    const a = (() => { const m = mk(base); return equalWeightBuyHoldReturns(m.coins, m.data, m.days, 0); })();
    const b = (() => { const m = mk(scaled); return equalWeightBuyHoldReturns(m.coins, m.data, m.days, 0); })();
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it("a coin priced strictly flat contributes exactly 0 to the average", () => {
    // C flat → average is just (A-ret + B-ret)/3 plus a 0 term.
    const { coins, data, days } = mk({ A: [100, 110, 121], B: [100, 120, 144], C: [100, 100, 100] });
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    expect(r[0]).toBeCloseTo((0.1 + 0.2 + 0) / 3, 9);
    expect(r[1]).toBeCloseTo((110 / 100 * 0 + (121 / 110 - 1) + (144 / 120 - 1) + 0) / 3, 9);
  });

  it("returns 0 on a bar where NO coin is eligible (all missing tNext)", () => {
    const { coins, data, days } = mk({ A: [100, 110, 121], B: [100, 120, 130] });
    data.A.delete(2);
    data.B.delete(2); // no coin has a close at day2 → bar i=1 yields 0
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    expect(r[1]).toBe(0);
  });

  it("is bounded between the min and max per-coin next return each bar (it's a mean)", () => {
    const p = randomPrices(63, ["A", "B", "C", "D"], 14);
    const { coins, data, days } = mk(p);
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    for (let i = 0; i < r.length; i++) {
      const rets = coins.map((c) => p[c][i + 1] / p[c][i] - 1);
      expect(r[i]).toBeGreaterThanOrEqual(Math.min(...rets) - 1e-12);
      expect(r[i]).toBeLessThanOrEqual(Math.max(...rets) + 1e-12);
    }
  });

  it("NO LOOKAHEAD — perturbing any future bar leaves strictly-earlier bars unchanged", () => {
    const p = randomPrices(64, ["A", "B"], 12);
    const r0 = (() => { const m = mk(p); return equalWeightBuyHoldReturns(m.coins, m.data, m.days, 0); })();
    for (let j = 5; j < p.A.length; j++) {
      const p2 = { ...p, A: [...p.A] };
      p2.A[j] = p2.A[j] * 4 + 1;
      const r1 = (() => { const m = mk(p2); return equalWeightBuyHoldReturns(m.coins, m.data, m.days, 0); })();
      const safe = Math.max(0, j - 1);
      expect(r1.slice(0, safe)).toEqual(r0.slice(0, safe));
    }
  });

  it("every bar return is finite for a random universe", () => {
    for (const seed of [71, 72, 73]) {
      const { coins, data, days } = mk(randomPrices(seed, ["A", "B", "C"], 18));
      const r = equalWeightBuyHoldReturns(coins, data, days, 0);
      expect(r.every((x) => Number.isFinite(x))).toBe(true);
    }
  });
});

// ===========================================================================
describe("btcRegimeFilter — properties", () => {
  const N = 30;
  const up = Array.from({ length: N }, (_, i) => 100 + i); // strict monotone uptrend
  const ones = new Array(N).fill(1);

  it("is idempotent under a monotone-uptrend BTC (applying twice == applying once)", () => {
    const once = btcRegimeFilter(ones, up, 5);
    const twice = btcRegimeFilter(once, up, 5);
    expect(twice).toEqual(once);
  });

  it("under a monotone uptrend, every post-warmup bar passes the position through unchanged", () => {
    const g = btcRegimeFilter(ones, up, 5);
    for (let i = 0; i < g.length; i++) {
      if (i + 1 < 5) expect(g[i]).toBe(0);
      else expect(g[i]).toBe(1);
    }
  });

  it("output length always equals positions length, regardless of n", () => {
    for (const n of [1, 2, 5, 10, N + 5]) {
      expect(btcRegimeFilter(ones, up, n)).toHaveLength(ones.length);
    }
  });

  it("|gated[i]| <= |position[i]| for every bar (the gate only attenuates)", () => {
    const rnd = lcg(81);
    const pos = Array.from({ length: N }, () => rnd() * 4 - 2); // signed positions in [-2,2)
    const g = btcRegimeFilter(pos, up, 6);
    for (let i = 0; i < g.length; i++) expect(Math.abs(g[i])).toBeLessThanOrEqual(Math.abs(pos[i]) + 1e-12);
  });

  it("gated[i] is always either 0 or exactly the original position (binary gate)", () => {
    const rnd = lcg(82);
    const pos = Array.from({ length: N }, () => rnd() * 10 - 5);
    const mixed = up.map((_, i) => (i % 3 === 0 ? 0 : 100 - i)); // arbitrary BTC-ish but we use `up`
    void mixed;
    const g = btcRegimeFilter(pos, up, 7);
    for (let i = 0; i < g.length; i++) expect(g[i] === 0 || g[i] === pos[i]).toBe(true);
  });

  it("a strict downtrend zeroes every bar", () => {
    const down = Array.from({ length: N }, (_, i) => 200 - i);
    const g = btcRegimeFilter(ones, down, 5);
    expect(g.every((p) => p === 0)).toBe(true);
  });

  it("any non-finite BTC close inside the SMA window forces that bar flat", () => {
    for (const bad of [undefined, NaN, Infinity, -Infinity]) {
      const closes: Array<number | undefined> = [...up];
      closes[12] = bad as number | undefined;
      const g = btcRegimeFilter(ones, closes, 5);
      // Bars whose window [i-n+1, i] includes index 12 must be 0.
      for (let i = 12; i <= Math.min(12 + 4, g.length - 1); i++) expect(g[i]).toBe(0);
    }
  });

  it("the current bar's own non-finite close also forces flat even if the rest of the window is fine", () => {
    const closes: Array<number | undefined> = [...up];
    closes[20] = undefined;
    expect(btcRegimeFilter(ones, closes, 5)[20]).toBe(0);
  });

  it("warmup region (i+1 < n) is always flat for any n >= 1", () => {
    for (const n of [2, 3, 6, 9]) {
      const g = btcRegimeFilter(ones, up, n);
      for (let i = 0; i + 1 < n; i++) expect(g[i]).toBe(0);
    }
  });

  it("n=1 gates purely on close > close (always false → all flat) under SMA-of-self", () => {
    // With n=1 the SMA is the bar itself, so close > close is never strictly true → all 0.
    const g = btcRegimeFilter(ones, up, 1);
    expect(g.every((p) => p === 0)).toBe(true);
  });

  it("NO LOOKAHEAD — perturbing a future BTC close cannot change an earlier gated bar", () => {
    const base = btcRegimeFilter(ones, up, 5);
    for (let j = 10; j < N; j++) {
      const b2 = [...up];
      b2[j] = 1e9;
      const g = btcRegimeFilter(ones, b2, 5);
      expect(g.slice(0, j)).toEqual(base.slice(0, j));
    }
  });

  it("scaling all positions by a constant scales the gated output by the same constant", () => {
    const pos = up.map((_, i) => (i % 2 ? 1.5 : -0.7));
    const g1 = btcRegimeFilter(pos, up, 5);
    const g3 = btcRegimeFilter(pos.map((p) => p * 3), up, 5);
    for (let i = 0; i < g1.length; i++) expect(g3[i]).toBeCloseTo(g1[i] * 3, 9);
  });

  it("an all-zero position vector gates to all zeros (nothing to keep)", () => {
    const zeros = new Array(N).fill(0);
    expect(btcRegimeFilter(zeros, up, 5).every((p) => p === 0)).toBe(true);
  });

  it("a BTC close exactly equal to its SMA (perfectly flat) is treated as NOT bullish → flat", () => {
    const flat = new Array(N).fill(100); // SMA == close → strict > fails → 0
    expect(btcRegimeFilter(ones, flat, 5).every((p) => p === 0)).toBe(true);
  });

  it("idempotence holds for a randomized signed position vector too", () => {
    const rnd = lcg(83);
    const pos = Array.from({ length: N }, () => rnd() * 6 - 3);
    const once = btcRegimeFilter(pos, up, 8);
    const twice = btcRegimeFilter(once, up, 8);
    expect(twice).toEqual(once);
  });
});

// ===========================================================================
describe("alignClosesByTimestamp — properties", () => {
  it("output length always equals targetBars length (one slot per target bar)", () => {
    const target = [10, 20, 30, 40, 50].map((t) => ({ start_unix: t }));
    const bench = [{ start_unix: 20, close: 2 }, { start_unix: 40, close: 4 }];
    expect(alignClosesByTimestamp(target, bench)).toHaveLength(target.length);
  });

  it("every target timestamp present in the benchmark maps to that benchmark close", () => {
    const target = [100, 200, 300].map((t) => ({ start_unix: t }));
    const bench = [
      { start_unix: 100, close: 1.5 },
      { start_unix: 200, close: 2.5 },
      { start_unix: 300, close: 3.5 },
    ];
    expect(alignClosesByTimestamp(target, bench)).toEqual([1.5, 2.5, 3.5]);
  });

  it("target timestamps absent from the benchmark map to undefined", () => {
    const target = [1, 2, 3, 4].map((t) => ({ start_unix: t }));
    const bench = [{ start_unix: 2, close: 22 }]; // only ts=2 present
    expect(alignClosesByTimestamp(target, bench)).toEqual([undefined, 22, undefined, undefined]);
  });

  it("an empty benchmark yields all-undefined of target length", () => {
    const target = [5, 6, 7].map((t) => ({ start_unix: t }));
    expect(alignClosesByTimestamp(target, [])).toEqual([undefined, undefined, undefined]);
  });

  it("an empty target yields an empty result regardless of benchmark", () => {
    const bench = [{ start_unix: 1, close: 9 }];
    expect(alignClosesByTimestamp([], bench)).toEqual([]);
  });

  it("benchmark extras (timestamps not in target) are simply ignored", () => {
    const target = [10, 30].map((t) => ({ start_unix: t }));
    const bench = [
      { start_unix: 10, close: 1 },
      { start_unix: 20, close: 2 }, // extra
      { start_unix: 30, close: 3 },
      { start_unix: 99, close: 9 }, // extra
    ];
    expect(alignClosesByTimestamp(target, bench)).toEqual([1, 3]);
  });

  it("on duplicate benchmark timestamps the LAST occurrence wins (Map semantics)", () => {
    const target = [7].map((t) => ({ start_unix: t }));
    const bench = [
      { start_unix: 7, close: 1 },
      { start_unix: 7, close: 2 },
      { start_unix: 7, close: 3 },
    ];
    expect(alignClosesByTimestamp(target, bench)).toEqual([3]);
  });

  it("preserves target order even when the benchmark is given out of order", () => {
    const target = [10, 20, 30].map((t) => ({ start_unix: t }));
    const bench = [
      { start_unix: 30, close: 300 },
      { start_unix: 10, close: 100 },
      { start_unix: 20, close: 200 },
    ];
    expect(alignClosesByTimestamp(target, bench)).toEqual([100, 200, 300]);
  });

  it("a close of 0 is mapped through as 0 (not coerced to undefined)", () => {
    const target = [4, 5].map((t) => ({ start_unix: t }));
    const bench = [{ start_unix: 4, close: 0 }];
    const out = alignClosesByTimestamp(target, bench);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeUndefined();
  });

  it("repeated target timestamps each resolve to the same benchmark close", () => {
    const target = [8, 8, 9].map((t) => ({ start_unix: t }));
    const bench = [{ start_unix: 8, close: 88 }, { start_unix: 9, close: 99 }];
    expect(alignClosesByTimestamp(target, bench)).toEqual([88, 88, 99]);
  });

  it("randomized round-trip: alignment of a target onto itself returns its own closes", () => {
    const rnd = lcg(91);
    const bars = Array.from({ length: 12 }, (_, i) => ({ start_unix: i * 60, close: rnd() * 1000 }));
    const aligned = alignClosesByTimestamp(bars.map((b) => ({ start_unix: b.start_unix })), bars);
    expect(aligned).toEqual(bars.map((b) => b.close));
  });

  it("output feeds btcRegimeFilter: missing target timestamps become flat bars downstream", () => {
    const target = [0, 60, 120, 180, 240, 300, 360].map((t) => ({ start_unix: t }));
    // benchmark missing ts=120 → undefined there → btcRegimeFilter must flatten that window
    const bench = target
      .filter((b) => b.start_unix !== 120)
      .map((b, i) => ({ start_unix: b.start_unix, close: 100 + i }));
    const aligned = alignClosesByTimestamp(target, bench);
    expect(aligned[2]).toBeUndefined();
    const gated = btcRegimeFilter(new Array(target.length).fill(1), aligned, 3);
    expect(gated[2]).toBe(0); // the bar with a missing BTC close is flat
  });
});

// ===========================================================================
describe("defaultRelStrengthVariants — properties", () => {
  it("produces exactly lookbacks.length * tops.length variants", () => {
    const vs = defaultRelStrengthVariants([5, 10, 20], [1, 2, 3, 4]);
    expect(vs).toHaveLength(3 * 4);
  });

  it("each variant carries the correct L, topK, and rs{L}/top{K} label", () => {
    const vs = defaultRelStrengthVariants([7], [2, 5]);
    expect(vs).toEqual([
      { label: "rs7/top2", L: 7, topK: 2 },
      { label: "rs7/top5", L: 7, topK: 5 },
    ]);
  });

  it("iterates lookback-outer, topK-inner (grid order)", () => {
    const vs = defaultRelStrengthVariants([1, 2], [9, 8]);
    expect(vs.map((v) => v.label)).toEqual(["rs1/top9", "rs1/top8", "rs2/top9", "rs2/top8"]);
  });

  it("the default grid (no args) is the documented 4 lookbacks × 3 tops = 12 variants", () => {
    const vs = defaultRelStrengthVariants();
    expect(vs).toHaveLength(12);
    expect(vs[0]).toEqual({ label: "rs5/top1", L: 5, topK: 1 });
    expect(vs.at(-1)).toEqual({ label: "rs30/top3", L: 30, topK: 3 });
  });

  it("every generated variant is directly usable by relativeStrengthReturns", () => {
    const { coins, data, days } = mk(randomPrices(95, ["A", "B", "C", "D"], 36));
    for (const v of defaultRelStrengthVariants([5, 10], [1, 2])) {
      const r = relativeStrengthReturns(v, coins, data, days, { feeBps: 5 });
      expect(r.every((x) => Number.isFinite(x))).toBe(true);
    }
  });
});
