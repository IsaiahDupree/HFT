import { describe, it, expect } from "vitest";
import { equalWeightTrendReturns } from "@/lib/backtest/candle/cross-asset";
import type { PriceSeries } from "@/lib/backtest/candle/xsection";

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random, no Date) — small seeded LCG.
// Property-based coverage for equalWeightTrendReturns ONLY (the long-flat
// equal-weight trend portfolio). relativeStrengthReturns /
// equalWeightBuyHoldReturns / btcRegimeFilter / alignClosesByTimestamp are
// already covered by cross-asset.test.ts and cross-asset.props.test.ts.
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

/** Deterministic positive-price random walk for `coins` of length `n`. */
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

/** A strictly-increasing price series of length `n` (always above its own SMA). */
function rising(n: number, base = 100, stepFrac = 0.03): number[] {
  const out: number[] = [base];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + stepFrac));
  return out;
}

/** A strictly-decreasing price series of length `n` (always below its own SMA). */
function falling(n: number, base = 100, stepFrac = 0.03): number[] {
  const out: number[] = [base];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 - stepFrac));
  return out;
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const finiteAll = (a: number[]) => a.every((x) => Number.isFinite(x));
const cloneSeries = (data: PriceSeries): PriceSeries => {
  const out: PriceSeries = {};
  for (const c of Object.keys(data)) out[c] = new Map(data[c]);
  return out;
};

// ===========================================================================
describe("equalWeightTrendReturns — shape & alignment properties", () => {
  it("output length is exactly days.length - 1 - startIndex", () => {
    const { coins, data, days } = mk(randomPrices(1, ["A", "B", "C"], 30));
    for (const start of [3, 5, 10]) {
      const r = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 5, startIndex: start });
      expect(r).toHaveLength(days.length - 1 - start);
    }
  });

  it("defaults startIndex to smaN when omitted", () => {
    const { coins, data, days } = mk(randomPrices(2, ["A", "B", "C"], 24));
    const smaN = 7;
    const def = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 5 });
    const explicit = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 5, startIndex: smaN });
    expect(def).toEqual(explicit);
    expect(def).toHaveLength(days.length - 1 - smaN);
  });

  it("defaults feeBps to 10 when omitted (omitting differs from feeBps:0 once it rotates)", () => {
    // mixed regime so the portfolio actually turns over and the fee bites
    const prices = randomPrices(3, ["A", "B", "C", "D"], 40);
    const { coins, data, days } = mk(prices);
    const def = equalWeightTrendReturns(coins, data, days, 5, { startIndex: 5 });
    const zero = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 0, startIndex: 5 });
    const ten = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 10, startIndex: 5 });
    expect(def).toEqual(ten);
    expect(sum(def)).toBeLessThan(sum(zero));
  });

  it("returns an empty array when there is no realizable bar (days.length-1 <= startIndex)", () => {
    const { coins, data, days } = mk(randomPrices(4, ["A", "B"], 6));
    const r = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 5, startIndex: 5 });
    expect(r).toEqual([]); // i runs [5, 5) → no bars
  });

  it("produces only finite numbers on a clean random universe", () => {
    const { coins, data, days } = mk(randomPrices(5, ["A", "B", "C", "D"], 50));
    const r = equalWeightTrendReturns(coins, data, days, 10, { feeBps: 8, startIndex: 10 });
    expect(r.length).toBeGreaterThan(0);
    expect(finiteAll(r)).toBe(true);
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — all-below-SMA flat properties", () => {
  it("a strictly falling universe is flat: every bar is exactly 0 (no longs, no turnover)", () => {
    const { coins, data, days } = mk({ A: falling(40), B: falling(40), C: falling(40) });
    const r = equalWeightTrendReturns(coins, data, days, 7, { feeBps: 25, startIndex: 7 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x === 0)).toBe(true);
  });

  it("never enters → fee level is irrelevant when the whole universe is below SMA", () => {
    const { coins, data, days } = mk({ A: falling(36), B: falling(36) });
    const lo = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 0, startIndex: 6 });
    const hi = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 500, startIndex: 6 });
    expect(lo).toEqual(hi);
    expect(sum(hi)).toBe(0);
  });

  it("a flat (constant) coin is never strictly above its own SMA → not held", () => {
    // constant price: close(t) == SMA, and the rule is strict ( > ), so it is excluded.
    const constants = new Array(30).fill(100);
    const { coins, data, days } = mk({ A: constants, B: constants });
    const r = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 13, startIndex: 5 });
    expect(r.every((x) => x === 0)).toBe(true);
  });

  it("startIndex deeper into a falling series is still all-zero", () => {
    const { coins, data, days } = mk({ A: falling(50), B: falling(50), C: falling(50) });
    const r = equalWeightTrendReturns(coins, data, days, 10, { feeBps: 30, startIndex: 25 });
    expect(r).toHaveLength(days.length - 1 - 25);
    expect(r.every((x) => x === 0)).toBe(true);
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — always-held rising-coin properties", () => {
  it("a single always-rising coin is held every bar and earns its own next return (feeBps:0)", () => {
    const px = rising(30);
    const { coins, data, days } = mk({ A: px });
    const smaN = 5;
    const start = smaN;
    const r = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 0, startIndex: start });
    for (let k = 0; k < r.length; k++) {
      const i = start + k;
      const expected = px[i + 1] / px[i] - 1; // realized t→t+1, weight 1
      expect(r[k]).toBeCloseTo(expected, 12);
    }
  });

  it("once a single rising coin is fully invested, turnover is 0 from bar 2 on → fee free", () => {
    const px = rising(30);
    const { coins, data, days } = mk({ A: px });
    const start = 5;
    const noFee = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 0, startIndex: start });
    const bigFee = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 1000, startIndex: start });
    // only the FIRST bar pays entry turnover (0 -> 1 = weight 1); the rest are identical.
    expect(bigFee.slice(1)).toEqual(noFee.slice(1));
    expect(bigFee[0]).toBeLessThan(noFee[0]); // entry fee on bar 0
  });

  it("entry-bar fee equals exactly 1 * feeBps/1e4 below the no-fee return (weight goes 0->1)", () => {
    const px = rising(24);
    const { coins, data, days } = mk({ A: px });
    const start = 5;
    const noFee = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 0, startIndex: start });
    const feeBps = 40;
    const withFee = equalWeightTrendReturns(coins, data, days, 5, { feeBps, startIndex: start });
    expect(noFee[0] - withFee[0]).toBeCloseTo((feeBps / 1e4) * 1, 12);
  });

  it("two always-rising coins are both held equal-weight every bar", () => {
    const a = rising(28, 100, 0.04);
    const b = rising(28, 50, 0.02);
    const { coins, data, days } = mk({ A: a, B: b });
    const start = 6;
    const r = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 0, startIndex: start });
    for (let k = 0; k < r.length; k++) {
      const i = start + k;
      const ra = a[i + 1] / a[i] - 1;
      const rb = b[i + 1] / b[i] - 1;
      expect(r[k]).toBeCloseTo(0.5 * ra + 0.5 * rb, 12);
    }
  });

  it("a rising coin held alongside a falling coin returns only the rising coin's contribution (feeBps:0, steady state)", () => {
    const up = rising(30, 100, 0.05);
    const down = falling(30, 100, 0.05);
    const { coins, data, days } = mk({ UP: up, DOWN: down });
    const start = 6;
    const r = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 0, startIndex: start });
    // DOWN is always below its SMA → never held; only UP is held (weight 1 each bar).
    for (let k = 0; k < r.length; k++) {
      const i = start + k;
      expect(r[k]).toBeCloseTo(up[i + 1] / up[i] - 1, 12);
    }
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — fee monotonicity properties", () => {
  it("higher feeBps never increases total return (random mixed universe)", () => {
    for (const seed of [11, 22, 33, 44]) {
      const { coins, data, days } = mk(randomPrices(seed, ["A", "B", "C", "D"], 45));
      const fees = [0, 5, 10, 25, 100];
      let prev = Infinity;
      for (const f of fees) {
        const total = sum(equalWeightTrendReturns(coins, data, days, 8, { feeBps: f, startIndex: 8 }));
        expect(total).toBeLessThanOrEqual(prev + 1e-12);
        prev = total;
      }
    }
  });

  it("each individual bar return is non-increasing as feeBps rises", () => {
    const { coins, data, days } = mk(randomPrices(7, ["A", "B", "C", "D", "E"], 40));
    const lo = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 0, startIndex: 6 });
    const hi = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 50, startIndex: 6 });
    expect(hi).toHaveLength(lo.length);
    for (let k = 0; k < lo.length; k++) expect(hi[k]).toBeLessThanOrEqual(lo[k] + 1e-12);
  });

  it("the fee delta on any bar equals turnover * (feeBps2 - feeBps1)/1e4 (linear in feeBps)", () => {
    const { coins, data, days } = mk(randomPrices(9, ["A", "B", "C", "D"], 40));
    const f0 = equalWeightTrendReturns(coins, data, days, 7, { feeBps: 0, startIndex: 7 });
    const f1 = equalWeightTrendReturns(coins, data, days, 7, { feeBps: 20, startIndex: 7 });
    const f2 = equalWeightTrendReturns(coins, data, days, 7, { feeBps: 40, startIndex: 7 });
    // delta(20bps) and delta(40bps) on the same bar must be exactly proportional (2x).
    for (let k = 0; k < f0.length; k++) {
      const d1 = f0[k] - f1[k];
      const d2 = f0[k] - f2[k];
      expect(d2).toBeCloseTo(2 * d1, 12);
    }
  });

  it("with feeBps:0 the total return is purely the realized long-portfolio P&L (fee never adds)", () => {
    const { coins, data, days } = mk(randomPrices(13, ["A", "B", "C"], 35));
    const zero = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 0, startIndex: 6 });
    const small = equalWeightTrendReturns(coins, data, days, 6, { feeBps: 1, startIndex: 6 });
    // a positive fee can only reduce or keep total
    expect(sum(small)).toBeLessThanOrEqual(sum(zero) + 1e-12);
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — no-lookahead properties", () => {
  it("perturbing the LAST close leaves every earlier return unchanged", () => {
    const prices = randomPrices(101, ["A", "B", "C"], 30);
    const base = mk(prices);
    const r0 = equalWeightTrendReturns(base.coins, base.data, base.days, 6, { feeBps: 7, startIndex: 6 });

    const p2: Record<string, number[]> = { ...prices, A: [...prices.A] };
    p2.A[p2.A.length - 1] = 99999;
    const pert = mk(p2);
    const r1 = equalWeightTrendReturns(pert.coins, pert.data, pert.days, 6, { feeBps: 7, startIndex: 6 });

    // the realized return for the final bar uses the final close, so only the last entry may differ
    expect(r1.slice(0, -1)).toEqual(r0.slice(0, -1));
  });

  it("perturbing a FAR-FUTURE close (index j) leaves all returns for bars i where i+1 < j unchanged", () => {
    const prices = randomPrices(202, ["A", "B", "C"], 40);
    const base = mk(prices);
    const start = 8;
    const r0 = equalWeightTrendReturns(base.coins, base.data, base.days, 8, { feeBps: 9, startIndex: start });

    const j = 30; // perturb close at day index 30
    const p2: Record<string, number[]> = { ...prices, B: [...prices.B] };
    p2.B[j] = prices.B[j] * 1000;
    const pert = mk(p2);
    const r1 = equalWeightTrendReturns(pert.coins, pert.data, pert.days, 8, { feeBps: 9, startIndex: start });

    // bar k corresponds to day i = start + k; it reads closes up to day i+1.
    // Returns for bars with i + 1 < j cannot have seen the perturbed close.
    const lastUnaffectedK = j - 1 - start - 1; // largest k with (start + k) + 1 < j
    expect(lastUnaffectedK).toBeGreaterThanOrEqual(0);
    expect(r1.slice(0, lastUnaffectedK + 1)).toEqual(r0.slice(0, lastUnaffectedK + 1));
  });

  it("appending NEW future days never changes the returns for the shared earlier bars", () => {
    const prices = randomPrices(303, ["A", "B", "C"], 25);
    const short = mk(prices);
    const start = 6;
    const rShort = equalWeightTrendReturns(short.coins, short.data, short.days, 6, { feeBps: 6, startIndex: start });

    // extend each coin with extra future days by appending to the EXISTING arrays, so the
    // shared prefix is byte-identical by construction (deterministic upward continuation).
    const longerPrices: Record<string, number[]> = {};
    for (const c of Object.keys(prices)) {
      const arr = [...prices[c]];
      for (let i = 0; i < 10; i++) arr.push(arr[arr.length - 1] * 1.01);
      longerPrices[c] = arr;
    }
    const long = mk(longerPrices);
    const rLong = equalWeightTrendReturns(long.coins, long.data, long.days, 6, { feeBps: 6, startIndex: start });

    // rShort's bars all consult only days 0..24, which are unchanged in the longer series →
    // the first rShort.length bars of rLong must equal rShort exactly.
    expect(rLong.slice(0, rShort.length)).toEqual(rShort);
  });

  it("a future SMA-window close cannot retroactively flip an earlier hold/skip decision", () => {
    // Build a coin that is clearly above SMA at an early bar; mutate a FAR-LATER close.
    const px = rising(30, 100, 0.04);
    const filler = randomPrices(404, ["B", "C"], 30);
    const base = mk({ A: [...px], B: filler.B, C: filler.C });
    const r0 = equalWeightTrendReturns(base.coins, base.data, base.days, 5, { feeBps: 4, startIndex: 5 });

    const pxMut = [...px];
    pxMut[28] = px[28] * 0.0001; // crash far in the future
    const pert = mk({ A: pxMut, B: filler.B, C: filler.C });
    const r1 = equalWeightTrendReturns(pert.coins, pert.data, pert.days, 5, { feeBps: 4, startIndex: 5 });

    // bars whose realized window ends before day 28 are untouched
    const start = 5;
    const lastUnaffectedK = 28 - 1 - start - 1;
    expect(r1.slice(0, lastUnaffectedK + 1)).toEqual(r0.slice(0, lastUnaffectedK + 1));
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — determinism & immutability properties", () => {
  it("is deterministic: repeated calls with identical inputs return identical arrays", () => {
    const { coins, data, days } = mk(randomPrices(55, ["A", "B", "C", "D"], 40));
    const r1 = equalWeightTrendReturns(coins, data, days, 8, { feeBps: 12, startIndex: 8 });
    const r2 = equalWeightTrendReturns(coins, data, days, 8, { feeBps: 12, startIndex: 8 });
    const r3 = equalWeightTrendReturns(coins, data, days, 8, { feeBps: 12, startIndex: 8 });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it("does not mutate the input PriceSeries maps", () => {
    const { coins, data, days } = mk(randomPrices(66, ["A", "B", "C"], 35));
    const before = cloneSeries(data);
    equalWeightTrendReturns(coins, data, days, 7, { feeBps: 11, startIndex: 7 });
    for (const c of coins) {
      expect(data[c].size).toBe(before[c].size);
      for (const [k, v] of before[c]) expect(data[c].get(k)).toBe(v);
    }
  });

  it("does not mutate the coins array nor the days array", () => {
    const built = mk(randomPrices(77, ["A", "B", "C"], 30));
    const coinsCopy = [...built.coins];
    const daysCopy = [...built.days];
    equalWeightTrendReturns(built.coins, built.data, built.days, 6, { feeBps: 9, startIndex: 6 });
    expect(built.coins).toEqual(coinsCopy);
    expect(built.days).toEqual(daysCopy);
  });

  it("coin ordering of the input does not change the (set-based) portfolio returns", () => {
    const prices = randomPrices(88, ["A", "B", "C", "D"], 40);
    const a = mk(prices);
    const rA = equalWeightTrendReturns(a.coins, a.data, a.days, 7, { feeBps: 0, startIndex: 7 });

    // rebuild with reversed coin insertion order
    const reordered: Record<string, number[]> = {};
    for (const c of [...Object.keys(prices)].reverse()) reordered[c] = prices[c];
    const b = mk(reordered);
    const rB = equalWeightTrendReturns(b.coins, b.data, b.days, 7, { feeBps: 0, startIndex: 7 });

    // equal-weight + summed P&L is order-independent (turnover uses a Set union)
    for (let k = 0; k < rA.length; k++) expect(rB[k]).toBeCloseTo(rA[k], 12);
  });

  it("passing the options object does not get mutated (feeBps/startIndex preserved)", () => {
    const { coins, data, days } = mk(randomPrices(99, ["A", "B", "C"], 30));
    const opts = { feeBps: 15, startIndex: 6 };
    equalWeightTrendReturns(coins, data, days, 6, opts);
    expect(opts).toEqual({ feeBps: 15, startIndex: 6 });
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — eligibility & coverage properties", () => {
  it("a coin missing its t+1 close is not held on that bar (eligibility requires t and t+1)", () => {
    // UP rises forever; create a gap at one t+1 → that bar should fall back to flat (only coin).
    const up = rising(20, 100, 0.05);
    const { coins, data, days } = mk({ UP: up });
    const start = 5;
    const gapBarK = 3; // bar k=3 → i = start + 3 = 8, realizes day 9
    const gapDay = start + gapBarK + 1; // day index of the missing t+1 close
    data.UP.delete(gapDay);
    const r = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 50, startIndex: start });
    // On the gap bar the only coin is ineligible → no longs → return reflects closing turnover only.
    // Prior bar held weight 1, so closing it costs feeBps/1e4 (negative, not the realized P&L).
    expect(r[gapBarK]).toBeCloseTo(-(50 / 1e4) * 1, 12);
  });

  it("a coin with too few SMA samples is excluded (needs >= max(2, floor(smaN/2)) closes)", () => {
    // Give A only a couple of recent closes (sparse) so its SMA-sample count is below the floor.
    const smaN = 10; // floor(10/2) = 5 required samples
    const days = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const data: PriceSeries = { A: new Map(), B: new Map() };
    // B: dense rising → always eligible & held
    days.forEach((d) => data.B.set(d, 100 * Math.pow(1.05, d)));
    // A: only closes at the two most recent days of any window before index 10 → < 5 samples
    data.A.set(10, 1000);
    data.A.set(11, 2000);
    const coins = ["A", "B"];
    const start = smaN; // 10 → bars i=10 only
    const r = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 0, startIndex: start });
    // bar i=10 realizes day 11. A is eligible by has(t)&has(t+1) (has 10 and 11) but only 2 SMA
    // samples (< 5) → excluded. So only B is held; return == B's t->t+1.
    const expected = data.B.get(11)! / data.B.get(10)! - 1;
    expect(r[0]).toBeCloseTo(expected, 12);
  });

  it("an entirely empty-eligibility bar (all coins missing t+1) returns flat plus closing turnover", () => {
    const up = rising(16, 100, 0.05);
    const { coins, data, days } = mk({ A: up, B: rising(16, 80, 0.05) });
    const start = 5;
    // delete the t+1 close for BOTH coins on the same realized day
    const deadDay = start + 2 + 1;
    data.A.delete(deadDay);
    data.B.delete(deadDay);
    const r = equalWeightTrendReturns(coins, data, days, 5, { feeBps: 30, startIndex: start });
    // bar k=2 has no eligible coins → longs empty → closes prior 2-coin book (turnover 1.0 total)
    expect(r[2]).toBeCloseTo(-(30 / 1e4) * 1, 12);
  });

  it("adding an always-flat (excluded) coin does not change the held portfolio's returns", () => {
    const up = rising(30, 100, 0.04);
    const withoutFlat = mk({ UP: up });
    const r0 = equalWeightTrendReturns(withoutFlat.coins, withoutFlat.data, withoutFlat.days, 6, { feeBps: 0, startIndex: 6 });

    const withFlat = mk({ UP: up, FLAT: new Array(30).fill(500) });
    const r1 = equalWeightTrendReturns(withFlat.coins, withFlat.data, withFlat.days, 6, { feeBps: 0, startIndex: 6 });
    // FLAT is never strictly above its SMA → excluded; UP-only returns identical.
    for (let k = 0; k < r0.length; k++) expect(r1[k]).toBeCloseTo(r0[k], 12);
  });
});

// ===========================================================================
describe("equalWeightTrendReturns — bound & sanity properties", () => {
  it("each bar's realized P&L (before fees) is a convex combination of held coins' returns → within their range", () => {
    const { coins, data, days } = mk(randomPrices(121, ["A", "B", "C", "D"], 40));
    const smaN = 7;
    const start = smaN;
    const zero = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 0, startIndex: start });
    for (let k = 0; k < zero.length; k++) {
      const i = start + k;
      const t = days[i], tNext = days[i + 1];
      // recompute the set of next-bar returns for ALL coins eligible by has(t)&has(t+1)
      const nexts: number[] = [];
      for (const c of coins) {
        if (data[c].has(t) && data[c].has(tNext)) nexts.push(data[c].get(tNext)! / data[c].get(t)! - 1);
      }
      if (!nexts.length) { expect(zero[k]).toBe(0); continue; }
      // The held subset is an equal-weight average of SOME candidates, OR the book is flat (0
      // when no candidate is above its SMA). So the bar return must lie within
      // [min(0, candidateMin), max(0, candidateMax)] — outside that range is a real regression.
      const lo = Math.min(0, ...nexts), hi = Math.max(0, ...nexts);
      expect(zero[k]).toBeGreaterThanOrEqual(lo - 1e-12);
      expect(zero[k]).toBeLessThanOrEqual(hi + 1e-12);
    }
  });

  it("a smaller smaN (faster trend filter) and larger smaN both produce finite, length-correct series", () => {
    const { coins, data, days } = mk(randomPrices(131, ["A", "B", "C"], 60));
    for (const smaN of [3, 5, 10, 20, 30]) {
      const r = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 7, startIndex: smaN });
      expect(r).toHaveLength(days.length - 1 - smaN);
      expect(finiteAll(r)).toBe(true);
    }
  });

  it("total return of an all-rising universe (feeBps:0) strictly exceeds the same with a big fee", () => {
    const { coins, data, days } = mk({ A: rising(40, 100, 0.03), B: rising(40, 50, 0.02), C: rising(40, 200, 0.025) });
    const noFee = sum(equalWeightTrendReturns(coins, data, days, 7, { feeBps: 0, startIndex: 7 }));
    const bigFee = sum(equalWeightTrendReturns(coins, data, days, 7, { feeBps: 200, startIndex: 7 }));
    expect(noFee).toBeGreaterThan(0); // trending universe makes money
    expect(bigFee).toBeLessThanOrEqual(noFee);
  });

  it("identical inputs with different startIndex agree on their overlapping bars", () => {
    const { coins, data, days } = mk(randomPrices(141, ["A", "B", "C", "D"], 40));
    const smaN = 6;
    const early = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 0, startIndex: smaN });
    const late = equalWeightTrendReturns(coins, data, days, smaN, { feeBps: 0, startIndex: smaN + 4 });
    // the late series starts 4 bars later but otherwise re-derives weights from scratch.
    // The first bar of `late` pays entry turnover (prevW empty), so compare from its 2nd bar,
    // which is in identical (fully-invested-or-not) steady state to early's offset bar+1.
    expect(late.length).toBe(early.length - 4);
    // sanity: both are finite and the tail realized P&L (feeBps:0) excluding entry equals.
    // Recompute the pure P&L for `late` bars >=1 and compare to early[offset] pure P&L.
    // Since feeBps:0, the ONLY difference vs early at the same realized bar is prevW-driven
    // turnover, which is 0 at feeBps:0 → returns must match exactly on aligned bars.
    for (let k = 0; k < late.length; k++) {
      expect(late[k]).toBeCloseTo(early[k + 4], 12);
    }
  });
});
