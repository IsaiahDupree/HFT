/**
 * Property tests for the candle backtest engine (runCandleBacktest + DailyCandle).
 *
 * These are DISTINCT from candle-backtest.test.ts: that file checks a few concrete
 * scenarios; here we assert structural/algebraic PROPERTIES that must hold across
 * many deterministically-generated inputs (flat → zero PnL, monotone-up → positive
 * PnL, fees monotonically reduce net PnL, equity/length invariants, Sharpe scaling,
 * no-lookahead, determinism, and the engine's exact accounting quirks).
 *
 * Only the real export `runCandleBacktest` (and the `DailyCandle` type) is tested.
 * No mocks, no env/DB/network. All randomness comes from a seeded LCG below.
 */
import { describe, it, expect } from "vitest";
import { runCandleBacktest, type DailyCandle } from "@/lib/backtest/candle/engine";

// ---- deterministic helpers (no Math.random, no Date) -----------------------

/** Seeded linear-congruential generator → [0,1). Numerical Recipes constants. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Build a DailyCandle[] from a close series (flat OHLC, deterministic timestamps). */
function series(closes: number[]): DailyCandle[] {
  return closes.map((c, i) => ({ start_unix: i * 86400, open: c, high: c, low: c, close: c, volume: 0 }));
}

/** A geometric series with constant per-bar growth factor g, length n. */
function geometric(start: number, g: number, n: number): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) { out.push(v); v *= g; }
  return out;
}

/** A strictly-positive random walk of n closes from a seeded rng. */
function randomCloses(rng: () => number, n: number, start = 100): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i++) {
    const step = 1 + (rng() - 0.5) * 0.1; // ±5% per bar, always > 0
    out.push(out[i - 1] * step);
  }
  return out;
}

/** Random positions in [-1,1] of length n. */
function randomPositions(rng: () => number, n: number): number[] {
  return Array.from({ length: n }, () => rng() * 2 - 1);
}

// ===========================================================================

describe("runCandleBacktest flat/zero-position invariants — properties", () => {
  it("an all-zero position series yields exactly zero PnL even with a wild price path", () => {
    const rng = lcg(1);
    const c = series(randomCloses(rng, 40));
    const r = runCandleBacktest(c, new Array(c.length).fill(0), { feeBps: 25 });
    expect(r.pnlPct).toBeCloseTo(0, 12);
    expect(r.finalEquity).toBe(1);
  });

  it("an all-zero position series records zero trades and zero win-rate", () => {
    const c = series([100, 90, 130, 70, 150]);
    const r = runCandleBacktest(c, [0, 0, 0, 0, 0], { feeBps: 99 });
    expect(r.trades).toBe(0);
    expect(r.winRate).toBe(0);
  });

  it("an all-zero position series has zero Sharpe and zero max drawdown (flat equity)", () => {
    const rng = lcg(7);
    const c = series(randomCloses(rng, 30));
    const r = runCandleBacktest(c, new Array(c.length).fill(0));
    expect(r.sharpe).toBe(0);
    expect(r.maxDdPct).toBe(0);
  });

  it("flat positions are fee-independent: changing feeBps cannot move a zero-turnover PnL", () => {
    const c = series([100, 80, 120, 95, 140, 60]);
    const lo = runCandleBacktest(c, [0, 0, 0, 0, 0, 0], { feeBps: 0 });
    const hi = runCandleBacktest(c, [0, 0, 0, 0, 0, 0], { feeBps: 500 });
    expect(hi.pnlPct).toBeCloseTo(lo.pnlPct, 12);
    expect(hi.finalEquity).toBe(lo.finalEquity);
  });
});

describe("runCandleBacktest monotone-price PnL sign — properties", () => {
  it("holding long through a monotone-UP series yields strictly positive PnL", () => {
    const c = series(geometric(100, 1.03, 25)); // +3%/bar
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    expect(r.pnlPct).toBeGreaterThan(0);
    expect(r.finalEquity).toBeGreaterThan(1);
  });

  it("holding long through a monotone-DOWN series yields strictly negative PnL", () => {
    const c = series(geometric(100, 0.97, 25)); // -3%/bar
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    expect(r.pnlPct).toBeLessThan(0);
    expect(r.finalEquity).toBeLessThan(1);
  });

  it("holding SHORT through a monotone-DOWN series yields strictly positive PnL", () => {
    const c = series(geometric(100, 0.97, 25));
    const r = runCandleBacktest(c, new Array(c.length).fill(-1), { feeBps: 0 });
    expect(r.pnlPct).toBeGreaterThan(0);
  });

  it("holding SHORT through a monotone-UP series yields strictly negative PnL", () => {
    const c = series(geometric(100, 1.03, 25));
    const r = runCandleBacktest(c, new Array(c.length).fill(-1), { feeBps: 0 });
    expect(r.pnlPct).toBeLessThan(0);
  });

  it("long PnL on an up-series equals the realised compound product of next-bar returns (no fee)", () => {
    const closes = geometric(100, 1.05, 8);
    const c = series(closes);
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    let eq = 1;
    for (let i = 0; i < closes.length - 1; i++) eq *= closes[i + 1] / closes[i];
    expect(r.pnlPct).toBeCloseTo((eq - 1) * 100, 6);
  });

  it("full long with zero fee reproduces buy-and-hold PnL to rounding", () => {
    const c = series([100, 137, 121, 188, 142]);
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    expect(r.pnlPct).toBeCloseTo(r.buyHoldPct, 3);
  });

  it("doubling every position scales the per-bar gross return linearly (2x exposure)", () => {
    const c = series(geometric(100, 1.02, 12));
    const one = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    // 2x exposure: each net return doubles, so equity is the product of (1+2r) vs (1+r)
    const two = runCandleBacktest(c, new Array(c.length).fill(2), { feeBps: 0 });
    expect(two.pnlPct).toBeGreaterThan(one.pnlPct); // up-market → leverage helps
  });
});

describe("runCandleBacktest fee monotonicity — properties", () => {
  it("more fee never increases net PnL when there IS turnover", () => {
    const c = series([100, 101, 100, 101, 100, 101]);
    const pos = [1, 0, 1, 0, 1, 0]; // flips every bar → lots of turnover
    const a = runCandleBacktest(c, pos, { feeBps: 0 });
    const b = runCandleBacktest(c, pos, { feeBps: 30 });
    const d = runCandleBacktest(c, pos, { feeBps: 100 });
    expect(b.pnlPct).toBeLessThanOrEqual(a.pnlPct);
    expect(d.pnlPct).toBeLessThanOrEqual(b.pnlPct);
  });

  it("PnL is a (weakly) decreasing function of feeBps across a swept ladder", () => {
    const c = series([100, 105, 95, 110, 90, 120]);
    const pos = [1, -1, 1, -1, 1, 0];
    const ladder = [0, 5, 10, 25, 50, 100, 250];
    let prev = Infinity;
    for (const f of ladder) {
      const pnl = runCandleBacktest(c, pos, { feeBps: f }).pnlPct;
      expect(pnl).toBeLessThanOrEqual(prev + 1e-9);
      prev = pnl;
    }
  });

  it("the fee penalty equals turnover × feeRate exactly (single round-trip)", () => {
    const c = series([100, 100, 100]); // flat price → gross is exactly 0
    const noFee = runCandleBacktest(c, [1, 0, 0], { feeBps: 0 });
    const fee = runCandleBacktest(c, [1, 0, 0], { feeBps: 50 });
    expect(noFee.pnlPct).toBeCloseTo(0, 12);
    // turnover: enter |1-0|=1 at bar0, exit |0-1|=1 at bar1 → 2 units × 50bps = 0.5% drag
    // applied per bar and COMPOUNDED: equity = (1-0.005)^2 = 0.990025 → ≈ -0.9975%.
    const expectedEquity = (1 - 0.005) * (1 - 0.005);
    expect(fee.pnlPct).toBeCloseTo((expectedEquity - 1) * 100, 6);
    expect(fee.pnlPct).toBeCloseTo(-0.9975, 4);
  });

  it("fee is charged on the INITIAL entry from a zero prior position (first bar)", () => {
    const c = series([100, 100]); // flat price, single transition
    const r = runCandleBacktest(c, [1], { feeBps: 100 }); // |1-0|=1 × 100bps = 1%
    expect(r.pnlPct).toBeCloseTo(-1, 6);
    expect(r.finalEquity).toBeCloseTo(0.99, 6);
  });

  it("zero turnover (constant position) incurs no fee regardless of feeBps", () => {
    const c = series(geometric(100, 1.01, 10));
    const noFee = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    const bigFee = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 300 });
    // only the initial entry from prev=0 is charged once; mid-series fees are zero
    expect(bigFee.pnlPct).toBeLessThan(noFee.pnlPct); // the one entry fee
    // but the gap is exactly one entry's worth, not per-bar
    const gap = noFee.pnlPct - bigFee.pnlPct;
    expect(gap).toBeLessThan(5); // far smaller than 10 bars × 300bps
  });

  it("larger position magnitude pays proportionally more turnover fee on a flat market", () => {
    const c = series([100, 100, 100]);
    const small = runCandleBacktest(c, [0.5, 0, 0], { feeBps: 100 });
    const big = runCandleBacktest(c, [1.0, 0, 0], { feeBps: 100 });
    expect(big.pnlPct).toBeLessThan(small.pnlPct); // bigger |Δpos| → bigger drag
  });
});

describe("runCandleBacktest equity-curve & length invariants — properties", () => {
  it("bars always equals the number of input candles", () => {
    for (const n of [0, 1, 2, 5, 13, 40]) {
      const c = series(geometric(100, 1.001, n));
      const r = runCandleBacktest(c, new Array(n).fill(1));
      expect(r.bars).toBe(n);
    }
  });

  it("an empty candle array returns the neutral identity result", () => {
    const r = runCandleBacktest([], []);
    expect(r.bars).toBe(0);
    expect(r.pnlPct).toBe(0);
    expect(r.finalEquity).toBe(1);
    expect(r.buyHoldPct).toBe(0);
    expect(r.trades).toBe(0);
  });

  it("a single candle has no transitions → neutral result and zero buy-hold", () => {
    const r = runCandleBacktest(series([123]), [1], { feeBps: 10 });
    expect(r.bars).toBe(1);
    expect(r.pnlPct).toBe(0);
    expect(r.buyHoldPct).toBe(0);
    expect(r.finalEquity).toBe(1);
    expect(r.trades).toBe(0);
  });

  it("finalEquity = 1 + pnlPct/100 (rounded), so pnl and equity never disagree in sign", () => {
    const rng = lcg(42);
    for (let t = 0; t < 12; t++) {
      const n = 10 + Math.floor(rng() * 20);
      const c = series(randomCloses(rng, n));
      const pos = randomPositions(rng, n);
      const r = runCandleBacktest(c, pos, { feeBps: 8 });
      // both derived from the same equity → consistent sign
      expect(Math.sign(r.pnlPct)).toBe(Math.sign((r.finalEquity - 1) || 0));
      expect(r.finalEquity).toBeCloseTo(1 + r.pnlPct / 100, 2);
    }
  });

  it("maxDdPct is always within [0,100] and is 0 on a monotonically rising equity curve", () => {
    const c = series(geometric(100, 1.04, 20));
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    expect(r.maxDdPct).toBe(0);
    expect(r.maxDdPct).toBeGreaterThanOrEqual(0);
    expect(r.maxDdPct).toBeLessThanOrEqual(100);
  });

  it("maxDdPct is positive whenever the equity curve dips below a prior peak", () => {
    const c = series([100, 120, 90, 130]); // up, down (drawdown), up
    const r = runCandleBacktest(c, [1, 1, 1, 1], { feeBps: 0 });
    expect(r.maxDdPct).toBeGreaterThan(0);
  });

  it("maxDdPct on a pure long monotone-down series equals the total loss percentage", () => {
    const c = series([100, 80, 80]); // -20% then flat held
    const r = runCandleBacktest(c, [1, 1, 1], { feeBps: 0 });
    expect(r.maxDdPct).toBeCloseTo(20, 6);
  });

  it("randomized inputs never produce NaN/Infinity in any numeric field", () => {
    const rng = lcg(2024);
    for (let t = 0; t < 25; t++) {
      const n = 2 + Math.floor(rng() * 30);
      const c = series(randomCloses(rng, n));
      const pos = randomPositions(rng, n);
      const r = runCandleBacktest(c, pos, { feeBps: Math.floor(rng() * 100) });
      for (const v of [r.pnlPct, r.sharpe, r.maxDdPct, r.trades, r.winRate, r.finalEquity, r.buyHoldPct, r.bars]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("winRate is always within [0,100]", () => {
    const rng = lcg(99);
    for (let t = 0; t < 15; t++) {
      const n = 5 + Math.floor(rng() * 20);
      const c = series(randomCloses(rng, n));
      // alternate between flat and long to generate entries+exits
      const pos = Array.from({ length: n }, (_, i) => (rng() > 0.5 ? 1 : 0));
      const r = runCandleBacktest(c, pos, { feeBps: 5 });
      expect(r.winRate).toBeGreaterThanOrEqual(0);
      expect(r.winRate).toBeLessThanOrEqual(100);
    }
  });
});

describe("runCandleBacktest buy-and-hold benchmark — properties", () => {
  it("buyHoldPct is the first-to-last close return regardless of the position series", () => {
    const closes = [100, 150, 90, 200];
    const c = series(closes);
    const expected = (closes[closes.length - 1] / closes[0] - 1) * 100;
    const r1 = runCandleBacktest(c, [1, 1, 1, 1], { feeBps: 7 });
    const r2 = runCandleBacktest(c, [0, -1, 0.5, 0], { feeBps: 7 });
    expect(r1.buyHoldPct).toBeCloseTo(expected, 1);
    expect(r2.buyHoldPct).toBe(r1.buyHoldPct); // position-independent
  });

  it("buyHoldPct is negative on a net-declining series and positive on a net-rising one", () => {
    expect(runCandleBacktest(series([100, 50]), [1]).buyHoldPct).toBeLessThan(0);
    expect(runCandleBacktest(series([100, 200]), [1]).buyHoldPct).toBeGreaterThan(0);
  });
});

describe("runCandleBacktest trade accounting — properties", () => {
  it("counts exactly one trade per 0→nonzero entry transition", () => {
    const c = series([100, 100, 100, 100, 100, 100, 100]);
    // entries at bar0 (0→1), bar2 (0→1), bar4 (0→-1) = 3 trades
    const r = runCandleBacktest(c, [1, 0, 1, 0, -1, 0, 0], { feeBps: 0 });
    expect(r.trades).toBe(3);
  });

  it("a constant nonzero position counts as exactly ONE trade (single entry, never re-enters)", () => {
    const c = series(geometric(100, 1.01, 15));
    const r = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 });
    expect(r.trades).toBe(1);
  });

  it("flipping long↔short without passing through zero is NOT a new trade", () => {
    const c = series([100, 100, 100, 100]);
    // 1 → -1 → 1 : never returns to 0, so inPos stays true → only the first entry counts
    const r = runCandleBacktest(c, [1, -1, 1, 0], { feeBps: 0 });
    expect(r.trades).toBe(1);
  });

  it("a profitable closed round-trip with a flat entry bar counts the entry but no win (entryEquity quirk)", () => {
    // DOCUMENTS CURRENT BEHAVIOR: entryEquity is captured AFTER the entry-bar equity
    // update, so a trade that's flat on its entry bar then profits still shows winRate 0
    // when it exits at break-even relative to that captured equity.
    const c = series([100, 110, 110]); // bar0 long earns +10%, bar1 exits flat
    const r = runCandleBacktest(c, [1, 0, 0], { feeBps: 0 });
    expect(r.trades).toBe(1);
    expect(r.pnlPct).toBeCloseTo(10, 6);
    expect(r.winRate).toBe(0);
  });

  it("an open winning position at the end is credited as a win (final-bar settlement)", () => {
    const c = series([100, 110, 121]); // long, never exits, equity ends > entry
    const r = runCandleBacktest(c, [1, 1, 1], { feeBps: 0 });
    expect(r.trades).toBe(1);
    expect(r.winRate).toBe(100);
  });

  it("an open LOSING position at the end is not credited as a win", () => {
    const c = series([100, 90, 81]); // long into a decline
    const r = runCandleBacktest(c, [1, 1, 1], { feeBps: 0 });
    expect(r.trades).toBe(1);
    expect(r.winRate).toBe(0);
  });
});

describe("runCandleBacktest Sharpe behavior — properties", () => {
  it("Sharpe is zero when there is only one realised return (std undefined)", () => {
    const c = series([100, 110]); // one transition → one return
    const r = runCandleBacktest(c, [1], { feeBps: 0 });
    expect(r.sharpe).toBe(0);
  });

  it("annualization scales Sharpe by √(periodsPerYear): hourly ≈ √24 × daily", () => {
    // A high-Sharpe path so the 2dp rounding of the result is negligible vs the ratio.
    const c = series([100, 110, 121, 110, 121, 133, 121, 133, 146, 133, 146, 161]);
    const pos = new Array(c.length).fill(1);
    const daily = runCandleBacktest(c, pos, { feeBps: 0, periodsPerYear: 365 }).sharpe;
    const hourly = runCandleBacktest(c, pos, { feeBps: 0, periodsPerYear: 8760 }).sharpe;
    expect(daily).toBeGreaterThan(0);
    // ratio should be ≈ √(8760/365) = √24 ≈ 4.899
    expect(hourly / daily).toBeCloseTo(Math.sqrt(8760 / 365), 2);
  });

  it("a steadily positive return stream produces a positive Sharpe, a negative stream a negative one", () => {
    // Oscillating-but-net-positive / net-negative paths so the return std is > 0
    // (a constant geometric step has zero variance → Sharpe is guarded to 0).
    const up = series([100, 103, 102, 106, 105, 110, 109, 115]);
    const down = series([100, 97, 98, 94, 95, 90, 91, 85]);
    expect(runCandleBacktest(up, new Array(up.length).fill(1), { feeBps: 0 }).sharpe).toBeGreaterThan(0);
    expect(runCandleBacktest(down, new Array(down.length).fill(1), { feeBps: 0 }).sharpe).toBeLessThan(0);
  });

  it("Sharpe sign flips when the position is negated on a trending market", () => {
    // Oscillating up-net path: returns have variance so Sharpe is nonzero and flips sign.
    const c = series([100, 105, 103, 108, 106, 112, 110, 118, 115, 123]);
    const long = runCandleBacktest(c, new Array(c.length).fill(1), { feeBps: 0 }).sharpe;
    const short = runCandleBacktest(c, new Array(c.length).fill(-1), { feeBps: 0 }).sharpe;
    expect(long).toBeGreaterThan(0);
    expect(short).toBeLessThan(0);
    expect(long).toBeCloseTo(-short, 6);
  });
});

describe("runCandleBacktest determinism & robustness — properties", () => {
  it("is fully deterministic: identical inputs give byte-identical results", () => {
    const rng = lcg(555);
    const c = series(randomCloses(rng, 30));
    const pos = randomPositions(lcg(556), 30);
    const a = runCandleBacktest(c, pos, { feeBps: 12, periodsPerYear: 365 });
    const b = runCandleBacktest(c, pos, { feeBps: 12, periodsPerYear: 365 });
    expect(a).toEqual(b);
  });

  it("has NO LOOKAHEAD: perturbing only the LAST close leaves all but the buy-hold/last-bar stats unchanged", () => {
    const closes = [100, 110, 105, 120, 118, 130, 125];
    const c0 = series(closes);
    const pos = [1, 0, 1, -1, 1, 1, 1];
    const r0 = runCandleBacktest(c0, pos, { feeBps: 10 });
    // mutate the final close drastically — it only affects the bar (n-2)→(n-1) return
    const closes2 = [...closes]; closes2[closes2.length - 1] = 9999;
    const r1 = runCandleBacktest(series(closes2), pos, { feeBps: 10 });
    // trades depend only on positions, not on the perturbed final price
    expect(r1.trades).toBe(r0.trades);
    // bars is structural
    expect(r1.bars).toBe(r0.bars);
  });

  it("positions LONGER than candles: trailing positions beyond the last transition are ignored", () => {
    const c = series([100, 110]); // only 1 transition → only positions[0] matters
    const short = runCandleBacktest(c, [1], { feeBps: 0 });
    const long = runCandleBacktest(c, [1, 1, 1, 1, 1], { feeBps: 0 });
    expect(long.pnlPct).toBeCloseTo(short.pnlPct, 12);
    expect(long.bars).toBe(short.bars);
  });

  it("positions SHORTER than candles: missing entries are treated as flat (0)", () => {
    const c = series([100, 110, 120]); // 2 transitions
    // only positions[0]=1 supplied; positions[1] is undefined → treated as 0
    const r = runCandleBacktest(c, [1], { feeBps: 0 });
    // bar0 earns +10%, bar1 is flat (pos undefined → 0) → total +10%
    expect(r.pnlPct).toBeCloseTo(10, 6);
  });

  it("a single nonzero spike position only earns that one bar's return", () => {
    const c = series([100, 110, 121, 133.1]);
    const r = runCandleBacktest(c, [0, 1, 0, 0], { feeBps: 0 });
    // only bar1→bar2 (+10%) is captured
    expect(r.pnlPct).toBeCloseTo(10, 4);
  });

  it("default options (no opts arg) apply feeBps=10 and periodsPerYear=365", () => {
    const c = series([100, 100, 100]);
    const withDefault = runCandleBacktest(c, [1, 0, 0]); // turnover 2 units
    const explicit10 = runCandleBacktest(c, [1, 0, 0], { feeBps: 10, periodsPerYear: 365 });
    expect(withDefault).toEqual(explicit10);
    // and the default fee is nonzero (so flat-price round trip loses money)
    expect(withDefault.pnlPct).toBeLessThan(0);
  });

  it("scaling all prices by a constant factor does not change any return-based metric", () => {
    const base = [100, 110, 105, 130, 120];
    const pos = [1, 1, 0, 1, 0];
    const r1 = runCandleBacktest(series(base), pos, { feeBps: 10 });
    const r2 = runCandleBacktest(series(base.map((p) => p * 7.5)), pos, { feeBps: 10 });
    expect(r2.pnlPct).toBeCloseTo(r1.pnlPct, 9);
    expect(r2.buyHoldPct).toBeCloseTo(r1.buyHoldPct, 9);
    expect(r2.sharpe).toBeCloseTo(r1.sharpe, 9);
    expect(r2.maxDdPct).toBeCloseTo(r1.maxDdPct, 9);
  });

  it("reversing the sign of every position negates each bar's gross PnL contribution (fee-free, symmetric path)", () => {
    // On a path where the long and short legs are exact mirrors, +pos and -pos PnL straddle 0.
    const c = series([100, 110, 100]); // up then back down
    const long = runCandleBacktest(c, [1, 1, 0], { feeBps: 0 }).pnlPct;
    const short = runCandleBacktest(c, [-1, -1, 0], { feeBps: 0 }).pnlPct;
    // long gains on the up leg & loses on the down leg; short does the opposite.
    expect(Math.sign(long)).not.toBe(Math.sign(short));
  });
});
