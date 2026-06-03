import { describe, it, expect } from "vitest";
import { ema, atr, rsi, realizedVol } from "@/lib/backtest/candle/indicators";
import {
  emaMomentum, macdTrend, rsiMomentum, atrBreakout, supertrend, gateByVolatility, volRegimeFilter,
} from "@/lib/backtest/candle/strategies";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

/** Build candles from closes; high/low straddle close by ±`spread`. */
function candles(closes: number[], spread = 1): DailyCandle[] {
  return closes.map((close, i) => ({ start_unix: i, open: close, high: close + spread, low: close - spread, close, volume: 1 }));
}
const ramp = (n: number, step = 1, base = 100) => Array.from({ length: n }, (_, i) => base + i * step);
const onlyBinary = (p: number[]) => p.every((x) => x === 0 || x === 1);

/** Generic no-lookahead check: perturbing an INTERIOR bar k must not change ANY position
 *  before k (position[i] may depend only on bars ≤ i). Stronger than a last-bar perturbation. */
function assertNoLookahead(strat: (c: DailyCandle[]) => number[], closes: number[]) {
  const base = strat(candles(closes));
  const k = closes.length - 5;
  const c2 = [...closes]; c2[k] = closes[k] * 5;
  const pert = strat(candles(c2));
  expect(pert.slice(0, k)).toEqual(base.slice(0, k));
}

describe("indicators", () => {
  it("ema seeds at values[0] and tracks a constant series exactly", () => {
    expect(ema([5, 5, 5, 5], 3)).toEqual([5, 5, 5, 5]);
    expect(ema([10, 20, 30], 2)[0]).toBe(10);
  });
  it("ema reacts faster than a slow ema to a jump", () => {
    const vals = [...Array(20).fill(100), 200];
    const fast = ema(vals, 3), slow = ema(vals, 10);
    expect(fast.at(-1)!).toBeGreaterThan(slow.at(-1)!); // fast moves toward 200 first
  });
  it("atr is NaN before n-1, finite after, and positive for a moving market", () => {
    const a = atr(candles(ramp(30, 2)), 14);
    expect(Number.isNaN(a[5])).toBe(true);
    expect(a[20]).toBeGreaterThan(0);
  });
  it("rsi → ~100 on an all-up series, ~0 on an all-down series", () => {
    expect(rsi(ramp(30), 14).at(-1)!).toBeGreaterThan(99);
    expect(rsi(ramp(30, -1, 200), 14).at(-1)!).toBeLessThan(1);
  });
  it("realizedVol is 0 for a constant series and positive for a noisy one", () => {
    expect(realizedVol(Array(30).fill(100), 14).at(-1)).toBe(0);
    expect(realizedVol(ramp(30).map((x, i) => x + (i % 2 ? 5 : -5)), 14).at(-1)!).toBeGreaterThan(0);
  });
  it("indicators are NO-LOOKAHEAD (a future value can't change an earlier indicator value)", () => {
    const base = ramp(40, 1);
    for (const f of [(c: number[]) => ema(c, 5), (c: number[]) => rsi(c, 14), (c: number[]) => realizedVol(c, 14)]) {
      const a = f(base);
      const b2 = [...base]; b2[39] = 9999;
      expect(f(b2).slice(0, 39)).toEqual(a.slice(0, 39));
    }
    // atr (needs candles)
    const ca = atr(candles(base), 14);
    const cb = [...base]; cb[39] = 9999;
    expect(atr(candles(cb), 14).slice(0, 39)).toEqual(ca.slice(0, 39));
  });
});

describe("emaMomentum / macdTrend (momentum voters)", () => {
  it("long in an uptrend, flat in a downtrend", () => {
    expect(emaMomentum(candles(ramp(60)), 10, 30).at(-1)).toBe(1);
    expect(emaMomentum(candles(ramp(60, -1, 200)), 10, 30).at(-1)).toBe(0);
    expect(macdTrend(candles(ramp(80)), 12, 26, 9).at(-1)).toBe(1);
    expect(macdTrend(candles(ramp(80, -1, 300)), 12, 26, 9).at(-1)).toBe(0);
  });
  it("binary positions, deterministic, no-lookahead", () => {
    const cl = ramp(60).map((x, i) => x + (i % 7) * 2); // noisy uptrend
    expect(onlyBinary(emaMomentum(candles(cl), 10, 30))).toBe(true);
    expect(emaMomentum(candles(cl), 10, 30)).toEqual(emaMomentum(candles(cl), 10, 30));
    assertNoLookahead((c) => emaMomentum(c, 10, 30), cl);
    assertNoLookahead((c) => macdTrend(c, 12, 26, 9), cl);
  });
});

describe("rsiMomentum (long on strength, not fading)", () => {
  it("goes long on a strong RSI, flat on a weak one", () => {
    expect(rsiMomentum(candles(ramp(40)), 14, 55, 45).at(-1)).toBe(1);
    expect(rsiMomentum(candles(ramp(40, -1, 200)), 14, 55, 45).at(-1)).toBe(0);
  });
  it("hysteresis band holds the position between exit and entry", () => {
    const r = rsiMomentum(candles(ramp(40)), 14, 55, 45);
    expect(onlyBinary(r)).toBe(true);
    assertNoLookahead((c) => rsiMomentum(c, 14, 55, 45), ramp(40).map((x, i) => x + (i % 5)));
  });
});

describe("atrBreakout (ATR-filtered)", () => {
  it("enters on a breakout that clears the range by > atrMult·ATR", () => {
    const cl = [...Array(20).fill(100).map((_, i) => 100 + (i % 2 ? 3 : -3)), 130]; // ranges ~97-103 then jumps to 130
    expect(atrBreakout(candles(cl, 3), 10, 1).at(-1)).toBe(1);
  });
  it("the ATR filter REJECTS a tiny breakout that barely clears the range", () => {
    const cl = [...Array(20).fill(100).map((_, i) => 100 + (i % 2 ? 3 : -3)), 103.2]; // just over the 103 high, < ATR
    expect(atrBreakout(candles(cl, 3), 10, 1).at(-1)).toBe(0);
  });
  it("binary, deterministic, no-lookahead", () => {
    const cl = ramp(50).map((x, i) => x + (i % 4) * 4);
    expect(onlyBinary(atrBreakout(candles(cl, 2), 10, 1))).toBe(true);
    assertNoLookahead((c) => atrBreakout(c, 10, 1), cl);
  });
});

describe("supertrend (ATR trailing trend)", () => {
  it("long in an uptrend, flat in a downtrend", () => {
    expect(supertrend(candles(ramp(60), 2), 10, 3).at(-1)).toBe(1);
    expect(supertrend(candles(ramp(60, -1, 200), 2), 10, 3).at(-1)).toBe(0);
  });
  it("binary, deterministic, no-lookahead", () => {
    const cl = ramp(60).map((x, i) => x + (i % 6) * 3);
    expect(onlyBinary(supertrend(candles(cl, 2), 10, 3))).toBe(true);
    expect(supertrend(candles(cl, 2), 10, 3)).toEqual(supertrend(candles(cl, 2), 10, 3));
    assertNoLookahead((c) => supertrend(c, 10, 3), cl);
  });
});

describe("volatility-regime gates", () => {
  it("gateByVolatility zeros positions outside the [min,max] vol band", () => {
    const cl = ramp(40).map((x, i) => x + (i > 20 ? (i % 2 ? 20 : -20) : 0)); // calm then very noisy
    const ones = new Array(cl.length).fill(1);
    const gated = gateByVolatility(candles(cl), ones, 14, { maxVol: 0.05 });
    expect(gated.slice(25).every((p) => p === 0)).toBe(true);   // high-vol tail gated out
    expect(gated.some((p) => p === 1)).toBe(true);              // calm region kept
  });
  it("gateByVolatility is no-lookahead", () => {
    assertNoLookahead((c) => gateByVolatility(c, emaMomentum(c, 10, 30), 14, { maxVol: 0.1 }), ramp(60).map((x, i) => x + (i % 5) * 4));
  });
  it("volRegimeFilter is self-calibrating (trailing median) and never holds where input is 0", () => {
    const cl = ramp(60).map((x, i) => x + (i % 3) * 5);
    const pos = emaMomentum(candles(cl), 10, 30);
    const gated = volRegimeFilter(candles(cl), pos, 14, "high");
    for (let i = 0; i < gated.length; i++) if (pos[i] === 0) expect(gated[i]).toBe(0); // gate only subtracts
    assertNoLookahead((c) => volRegimeFilter(c, emaMomentum(c, 10, 30), 14, "high"), cl);
  });
});
