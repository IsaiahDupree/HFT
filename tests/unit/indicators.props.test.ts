import { describe, it, expect } from "vitest";
import { ema, atr, rsi, realizedVol } from "@/lib/backtest/candle/indicators";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

// ---------------------------------------------------------------------------
// Deterministic helpers — no Math.random, no wall-clock. A tiny seeded LCG so
// every randomized property is fully reproducible run-to-run.
// ---------------------------------------------------------------------------
function lcg(seed: number): () => number {
  // Numerical Recipes LCG, returns a float in [0, 1).
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** Build a deterministic positive price series in [lo, hi). */
function randPrices(seed: number, len: number, lo = 50, hi = 150): number[] {
  const r = lcg(seed);
  return Array.from({ length: len }, () => lo + r() * (hi - lo));
}
/** Build deterministic OHLC candles where high≥max(o,c), low≤min(o,c). */
function randCandles(seed: number, len: number): DailyCandle[] {
  const r = lcg(seed);
  const out: DailyCandle[] = [];
  let px = 100;
  for (let i = 0; i < len; i++) {
    const open = px;
    const close = px * (0.97 + r() * 0.06); // ±3%
    const hi = Math.max(open, close) * (1 + r() * 0.02);
    const lo = Math.min(open, close) * (1 - r() * 0.02);
    out.push({ start_unix: i * 86_400, open, high: hi, low: lo, close, volume: 1000 + r() * 500 });
    px = close;
  }
  return out;
}
/** A candle with explicit OHLC; start_unix/volume filled in. */
function cdl(open: number, high: number, low: number, close: number, i = 0): DailyCandle {
  return { start_unix: i * 86_400, open, high, low, close, volume: 1 };
}
const isFiniteNum = (x: number) => Number.isFinite(x);
const finiteVals = (a: number[]) => a.filter(isFiniteNum);

// ===========================================================================
describe("ema — properties", () => {
  it("EMA of a constant series equals that constant at every index", () => {
    const c = new Array(40).fill(7.5);
    expect(ema(c, 10).every((v) => Math.abs(v - 7.5) < 1e-9)).toBe(true);
  });

  it("EMA of a constant series equals the constant for many seeds/spans", () => {
    for (const [val, n, len] of [[3, 5, 20], [100, 12, 30], [0.25, 26, 50]] as const) {
      const out = ema(new Array(len).fill(val), n);
      expect(out.every((v) => Math.abs(v - val) < 1e-9)).toBe(true);
    }
  });

  it("ema[0] is always seeded with values[0] exactly", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const v = randPrices(seed, 25);
      expect(ema(v, 9)[0]).toBe(v[0]);
    }
  });

  it("every EMA value lies within [min, max] of the inputs (random seeds)", () => {
    for (let seed = 10; seed <= 18; seed++) {
      const v = randPrices(seed, 60, 20, 200);
      const lo = Math.min(...v), hi = Math.max(...v);
      const out = ema(v, 14);
      for (const x of out) {
        expect(x).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(x).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it("output length equals input length", () => {
    expect(ema(randPrices(2, 33), 7)).toHaveLength(33);
    expect(ema([], 5)).toHaveLength(0);
  });

  it("a single-element series returns that element unchanged", () => {
    expect(ema([42], 10)).toEqual([42]);
  });

  it("matches the explicit recurrence ema[i]=a*v[i]+(1-a)*ema[i-1]", () => {
    const v = randPrices(7, 30);
    const n = 8, a = 2 / (n + 1);
    const out = ema(v, n);
    let prev = v[0];
    for (let i = 1; i < v.length; i++) {
      prev = a * v[i] + (1 - a) * prev;
      expect(out[i]).toBeCloseTo(prev, 9);
    }
  });

  it("a larger span produces a smoother (lower-variance) series on the same input", () => {
    const v = randPrices(99, 80, 50, 250);
    const variance = (arr: number[]) => {
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      return arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
    };
    expect(variance(ema(v, 30))).toBeLessThan(variance(ema(v, 3)));
  });

  it("on a strictly rising series the EMA never decreases", () => {
    const v = Array.from({ length: 50 }, (_, i) => 10 + i);
    const out = ema(v, 12);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] - 1e-9);
  });

  it("on a strictly falling series the EMA never increases", () => {
    const v = Array.from({ length: 50 }, (_, i) => 100 - i);
    const out = ema(v, 12);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1] + 1e-9);
  });

  it("EMA lags a rising series — sits at or below the latest price", () => {
    const v = Array.from({ length: 40 }, (_, i) => 10 + i);
    const out = ema(v, 10);
    for (let i = 1; i < v.length; i++) expect(out[i]).toBeLessThanOrEqual(v[i] + 1e-9);
  });

  it("all outputs are finite for finite inputs", () => {
    const out = ema(randPrices(123, 70), 15);
    expect(out.every(isFiniteNum)).toBe(true);
  });

  it("NO LOOKAHEAD — perturbing a far-future bar leaves earlier EMA values unchanged", () => {
    const v = randPrices(55, 40);
    const base = ema(v, 10);
    const v2 = [...v]; v2[39] = 9999;
    const pert = ema(v2, 10);
    expect(pert.slice(0, 39)).toEqual(base.slice(0, 39));
  });

  it("NO LOOKAHEAD — bumping the last bar only ever changes the last EMA value", () => {
    const v = randPrices(56, 30);
    const base = ema(v, 6);
    const v2 = [...v]; v2[29] += 500;
    const pert = ema(v2, 6);
    expect(pert.slice(0, 29)).toEqual(base.slice(0, 29));
    expect(pert[29]).not.toBe(base[29]);
  });
});

// ===========================================================================
describe("atr — properties", () => {
  it("is NaN before warmup (i < n-1) and finite from i = n-1 on", () => {
    const candles = randCandles(1, 30);
    const n = 14;
    const out = atr(candles, n);
    for (let i = 0; i < n - 1; i++) expect(Number.isNaN(out[i])).toBe(true);
    for (let i = n - 1; i < out.length; i++) expect(isFiniteNum(out[i])).toBe(true);
  });

  it("every finite ATR value is >= 0 across many seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = atr(randCandles(seed, 50), 14);
      for (const x of finiteVals(out)) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns all-NaN when there are fewer candles than n", () => {
    const out = atr(randCandles(3, 5), 14);
    expect(out).toHaveLength(5);
    expect(out.every((x) => Number.isNaN(x))).toBe(true);
  });

  it("returns all-NaN for n < 1", () => {
    const out = atr(randCandles(4, 20), 0);
    expect(out.every((x) => Number.isNaN(x))).toBe(true);
  });

  it("output length equals candle count", () => {
    expect(atr(randCandles(5, 27), 10)).toHaveLength(27);
  });

  it("ATR of a perfectly flat market (high=low=close every bar) is 0 after warmup", () => {
    const candles = Array.from({ length: 20 }, (_, i) => cdl(100, 100, 100, 100, i));
    const out = atr(candles, 5);
    for (let i = 4; i < out.length; i++) expect(out[i]).toBeCloseTo(0, 12);
  });

  it("ATR of a constant-range market equals that range exactly", () => {
    // every bar spans high-low = 10, no gaps (prevClose stays inside [low,high])
    const candles = Array.from({ length: 20 }, (_, i) => cdl(100, 105, 95, 100, i));
    const out = atr(candles, 5);
    for (let i = 4; i < out.length; i++) expect(out[i]).toBeCloseTo(10, 9);
  });

  it("seed value at index n-1 equals the SMA of the first n true ranges", () => {
    const candles = randCandles(2, 30);
    const n = 7;
    const out = atr(candles, n);
    // recompute true range inline (tr[0]=high-low; else max of the 3 spans)
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const pc = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    const sma = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
    expect(out[n - 1]).toBeCloseTo(sma, 9);
  });

  it("Wilder recurrence holds: atr[i] = (atr[i-1]*(n-1)+tr[i])/n", () => {
    const candles = randCandles(6, 40);
    const n = 9;
    const out = atr(candles, n);
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const pc = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    for (let i = n; i < candles.length; i++) {
      expect(out[i]).toBeCloseTo((out[i - 1] * (n - 1) + tr[i]) / n, 9);
    }
  });

  it("a volatile market yields a larger ATR than a calm one", () => {
    const calm = Array.from({ length: 30 }, (_, i) => cdl(100, 101, 99, 100, i));
    const wild = Array.from({ length: 30 }, (_, i) => cdl(100, 130, 70, 100, i));
    expect(atr(wild, 10)[29]).toBeGreaterThan(atr(calm, 10)[29]);
  });

  it("ATR with n=1 equals the per-bar true range from index 0 on", () => {
    const candles = randCandles(8, 15);
    const out = atr(candles, 1);
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const pc = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    for (let i = 0; i < candles.length; i++) expect(out[i]).toBeCloseTo(tr[i], 9);
  });

  it("a gap-up open inflates true range above the simple high-low span", () => {
    // prevClose=100, this bar trades 120..125 → |high-prevClose|=25 > high-low=5
    const candles = [cdl(100, 100, 100, 100, 0), cdl(120, 125, 120, 123, 1)];
    const out = atr(candles, 1);
    expect(out[1]).toBeCloseTo(25, 9);
  });

  it("NO LOOKAHEAD — perturbing a far-future candle leaves earlier ATR values unchanged", () => {
    const candles = randCandles(11, 40);
    const base = atr(candles, 14);
    const c2 = candles.map((c) => ({ ...c }));
    c2[39] = cdl(500, 9999, 1, 250, 39);
    const pert = atr(c2, 14);
    expect(pert.slice(0, 39)).toEqual(base.slice(0, 39));
  });

  it("NO LOOKAHEAD — bumping the last candle only changes the last ATR value", () => {
    const candles = randCandles(12, 30);
    const base = atr(candles, 10);
    const c2 = candles.map((c) => ({ ...c }));
    c2[29] = { ...c2[29], high: c2[29].high + 100 };
    const pert = atr(c2, 10);
    expect(pert.slice(0, 29)).toEqual(base.slice(0, 29));
    expect(pert[29]).not.toBe(base[29]);
  });
});

// ===========================================================================
describe("rsi — properties", () => {
  it("is NaN through index n and finite from index n+? (>= n) on", () => {
    const closes = randPrices(1, 40);
    const n = 14;
    const out = rsi(closes, n);
    for (let i = 0; i < n; i++) expect(Number.isNaN(out[i])).toBe(true);
    for (let i = n; i < out.length; i++) expect(isFiniteNum(out[i])).toBe(true);
  });

  it("every finite RSI value is within [0, 100] across many seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = rsi(randPrices(seed, 60), 14);
      for (const x of finiteVals(out)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
      }
    }
  });

  it("a strictly rising series gives RSI = 100", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 10 + i);
    const out = rsi(closes, 14);
    for (const x of finiteVals(out)) expect(x).toBeCloseTo(100, 9);
  });

  it("a strictly falling series gives RSI = 0", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 - i);
    const out = rsi(closes, 14);
    for (const x of finiteVals(out)) expect(x).toBeCloseTo(0, 9);
  });

  it("a perfectly flat series (no gain, no loss) gives RSI = 50", () => {
    const closes = new Array(40).fill(100);
    const out = rsi(closes, 14);
    for (const x of finiteVals(out)) expect(x).toBeCloseTo(50, 9);
  });

  it("returns all-NaN when closes.length <= n", () => {
    const out = rsi(randPrices(2, 14), 14); // length 14 == n → all NaN
    expect(out).toHaveLength(14);
    expect(out.every((x) => Number.isNaN(x))).toBe(true);
  });

  it("returns all-NaN for n < 1", () => {
    const out = rsi(randPrices(3, 20), 0);
    expect(out.every((x) => Number.isNaN(x))).toBe(true);
  });

  it("output length equals input length", () => {
    expect(rsi(randPrices(4, 31), 10)).toHaveLength(31);
  });

  it("the first finite RSI lands exactly at index n", () => {
    const out = rsi(randPrices(5, 30), 9);
    expect(Number.isNaN(out[8])).toBe(true);
    expect(isFiniteNum(out[9])).toBe(true);
  });

  it("seed value at index n matches the average-gain/loss formula over the first n deltas", () => {
    const closes = randPrices(6, 30);
    const n = 10;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    const avgG = gain / n, avgL = loss / n;
    const expected = avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL);
    expect(rsi(closes, n)[n]).toBeCloseTo(expected, 9);
  });

  it("a stronger uptrend yields a higher RSI than a weaker one", () => {
    // weak = choppy rising (real down-bars keep avgLoss > 0 → RSI < 100);
    // strong = monotonic rising (avgLoss → 0 → RSI = 100).
    const weak = Array.from({ length: 40 }, (_, i) => 100 + i + (i % 2 ? -3 : 0));
    const strong = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    expect(rsi(weak, 14)[39]).toBeLessThan(100); // genuinely below the ceiling
    expect(rsi(strong, 14)[39]).toBeGreaterThan(rsi(weak, 14)[39]);
  });

  it("symmetry: an up-then-flat path reads bullish (RSI > 50) at the seed bar", () => {
    const closes = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120];
    expect(rsi(closes, 5)[5]).toBeGreaterThan(50);
  });

  it("RSI is invariant to a positive vertical shift of all closes (deltas unchanged)", () => {
    const base = randPrices(7, 35);
    const shifted = base.map((x) => x + 1000);
    const a = rsi(base, 12), b = rsi(shifted, 12);
    for (let i = 12; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it("NO LOOKAHEAD — perturbing a far-future close leaves earlier RSI values unchanged", () => {
    const closes = randPrices(13, 40);
    const base = rsi(closes, 14);
    const c2 = [...closes]; c2[39] = 9999;
    const pert = rsi(c2, 14);
    for (let i = 0; i < 39; i++) {
      if (Number.isNaN(base[i])) expect(Number.isNaN(pert[i])).toBe(true);
      else expect(pert[i]).toBe(base[i]);
    }
  });

  it("NO LOOKAHEAD — bumping the last close only changes the last RSI value", () => {
    const closes = randPrices(14, 30);
    const base = rsi(closes, 10);
    const c2 = [...closes]; c2[29] += 250;
    const pert = rsi(c2, 10);
    for (let i = 0; i < 29; i++) {
      if (Number.isNaN(base[i])) expect(Number.isNaN(pert[i])).toBe(true);
      else expect(pert[i]).toBe(base[i]);
    }
    expect(pert[29]).not.toBe(base[29]);
  });
});

// ===========================================================================
describe("realizedVol — properties", () => {
  it("is NaN before warmup (i < n) and finite from i = n on for positive prices", () => {
    const closes = randPrices(1, 40, 80, 120);
    const n = 10;
    const out = realizedVol(closes, n);
    for (let i = 0; i < n; i++) expect(Number.isNaN(out[i])).toBe(true);
    for (let i = n; i < out.length; i++) expect(isFiniteNum(out[i])).toBe(true);
  });

  it("every finite realizedVol value is >= 0 across many seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const out = realizedVol(randPrices(seed, 50, 80, 120), 12);
      for (const x of finiteVals(out)) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it("realizedVol of a flat series is exactly 0 after warmup", () => {
    const closes = new Array(40).fill(100);
    const out = realizedVol(closes, 10);
    for (let i = 10; i < out.length; i++) expect(out[i]).toBeCloseTo(0, 12);
  });

  it("a constant-growth series (equal log-returns) has 0 realized vol", () => {
    // each bar +5% → identical log-returns → sample std = 0
    const closes = Array.from({ length: 30 }, (_, i) => 100 * 1.05 ** i);
    const out = realizedVol(closes, 8);
    for (let i = 8; i < out.length; i++) expect(out[i]).toBeCloseTo(0, 10);
  });

  it("returns all-NaN for n < 2", () => {
    expect(realizedVol(randPrices(2, 20, 80, 120), 1).every((x) => Number.isNaN(x))).toBe(true);
    expect(realizedVol(randPrices(2, 20, 80, 120), 0).every((x) => Number.isNaN(x))).toBe(true);
  });

  it("output length equals input length", () => {
    expect(realizedVol(randPrices(3, 29, 80, 120), 7)).toHaveLength(29);
  });

  it("a non-positive price taints every window that includes its return → NaN", () => {
    const closes = [100, 101, 102, -5, 104, 105, 106, 107];
    const n = 3;
    const out = realizedVol(closes, n);
    // the bad return is at index 3 (log of -5/102) and at index 4 (log of 104/-5)
    // any window [i-n+1..i] covering index 3 or 4 must be NaN.
    for (let i = n; i < closes.length; i++) {
      const touchesBad = i - n + 1 <= 4 && i >= 3;
      if (touchesBad) expect(Number.isNaN(out[i])).toBe(true);
    }
  });

  it("a zero price taints affected windows → NaN (degenerate input rule)", () => {
    const closes = [100, 100, 100, 0, 100, 100, 100, 100];
    const out = realizedVol(closes, 2);
    // index 3 return (0/100) and index 4 return (100/0) are NaN
    expect(Number.isNaN(out[3])).toBe(true);
    expect(Number.isNaN(out[4])).toBe(true);
  });

  it("once the bad return scrolls out of the window, vol recovers to finite", () => {
    const closes = [100, 101, 0, 103, 104, 105, 106, 107, 108, 109];
    const n = 3;
    const out = realizedVol(closes, n);
    // last index 9 window is [7,8,9] — all positive, finite
    expect(isFiniteNum(out[9])).toBe(true);
  });

  it("matches the sample-std (n-1 divisor) of the window's log-returns", () => {
    const closes = randPrices(6, 30, 80, 120);
    const n = 6;
    const out = realizedVol(closes, n);
    const rets = closes.map((c, i) => (i === 0 ? NaN : Math.log(c / closes[i - 1])));
    for (let i = n; i < closes.length; i++) {
      const win = rets.slice(i - n + 1, i + 1);
      const m = win.reduce((s, x) => s + x, 0) / n;
      const varr = win.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
      expect(out[i]).toBeCloseTo(Math.sqrt(varr), 9);
    }
  });

  it("a high-amplitude oscillation has greater realized vol than a calm drift", () => {
    const calm = Array.from({ length: 40 }, (_, i) => 100 * 1.001 ** i);
    const choppy = Array.from({ length: 40 }, (_, i) => (i % 2 ? 80 : 120));
    expect(realizedVol(choppy, 10)[39]).toBeGreaterThan(realizedVol(calm, 10)[39]);
  });

  it("realizedVol is scale-invariant — multiplying all prices by a constant leaves vol unchanged", () => {
    const base = randPrices(7, 35, 80, 120);
    const scaled = base.map((x) => x * 1000);
    const a = realizedVol(base, 10), b = realizedVol(scaled, 10);
    for (let i = 10; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it("NO LOOKAHEAD — perturbing a far-future close leaves earlier vol values unchanged", () => {
    const closes = randPrices(13, 40, 80, 120);
    const base = realizedVol(closes, 12);
    const c2 = [...closes]; c2[39] = 9999;
    const pert = realizedVol(c2, 12);
    for (let i = 0; i < 39; i++) {
      if (Number.isNaN(base[i])) expect(Number.isNaN(pert[i])).toBe(true);
      else expect(pert[i]).toBeCloseTo(base[i], 12);
    }
  });

  it("NO LOOKAHEAD — bumping the last close only affects the last vol value's window", () => {
    const closes = randPrices(14, 30, 80, 120);
    const n = 6;
    const base = realizedVol(closes, n);
    const c2 = [...closes]; c2[29] *= 1.5;
    const pert = realizedVol(c2, n);
    // only windows that include the last return (index 29) — i.e. only out[29] — change.
    for (let i = 0; i < 29; i++) {
      if (Number.isNaN(base[i])) expect(Number.isNaN(pert[i])).toBe(true);
      else expect(pert[i]).toBeCloseTo(base[i], 12);
    }
    expect(pert[29]).not.toBeCloseTo(base[29], 9);
  });
});
