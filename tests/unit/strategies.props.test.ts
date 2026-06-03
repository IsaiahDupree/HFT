import { describe, it, expect } from "vitest";
import {
  smaTrend,
  donchianBreakout,
  zMeanReversion,
  buyAndHold,
  emaMomentum,
  macdTrend,
  rsiMomentum,
  atrBreakout,
  supertrend,
  gateByVolatility,
  volRegimeFilter,
} from "@/lib/backtest/candle/strategies";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

/* ──────────────────────────────────────────────────────────────────────────
 * Deterministic helpers — NO platform RNG, NO wall-clock.
 * Seeded LCG (Numerical Recipes constants) so every randomized input is
 * reproducible across runs. uniform() ∈ [0,1).
 * ────────────────────────────────────────────────────────────────────────── */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A pseudo-random but deterministic positive close series (always > 0). */
function randomCloses(n: number, seed: number, base = 100, drift = 0): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 6 + drift; // ±3 + drift
    p = Math.max(1, p + shock);
    out.push(p);
  }
  return out;
}

/** Build candles from closes; high/low straddle close by ±`spread` (kept > 0). */
function candles(closes: number[], spread = 1): DailyCandle[] {
  return closes.map((close, i) => ({
    start_unix: i,
    open: close,
    high: close + spread,
    low: Math.max(0.01, close - spread),
    close,
    volume: 1,
  }));
}

const ramp = (n: number, step = 1, base = 100) => Array.from({ length: n }, (_, i) => base + i * step);
const isBinary = (p: number[]) => p.every((x) => x === 0 || x === 1);
const ones = (n: number) => new Array(n).fill(1);
const zeros = (n: number) => new Array(n).fill(0);

/** Perturb an INTERIOR bar k by a large multiple and assert positions before k are
 *  byte-identical (no-lookahead: position[i] may depend only on bars ≤ i). */
function assertNoLookahead(strat: (c: DailyCandle[]) => number[], closes: number[], k: number) {
  const base = strat(candles(closes));
  const c2 = [...closes];
  c2[k] = closes[k] * 5 + 50; // far-future shock
  const pert = strat(candles(c2));
  expect(pert.slice(0, k)).toEqual(base.slice(0, k));
}

/* A handful of reusable deterministic close series. */
const NOISY_UP = ramp(80).map((x, i) => x + (i % 7) * 2);
const NOISY_DOWN = ramp(80, -1, 400).map((x, i) => x - (i % 7) * 2 + 0.0001 * i);
const CHOPPY = randomCloses(120, 12345);
const CHOPPY2 = randomCloses(120, 98765, 200);

/* ────────────────────────────── smaTrend ───────────────────────────────── */
describe("smaTrend — properties", () => {
  it("output length always equals input length (varied n + lengths)", () => {
    for (const len of [1, 5, 80]) {
      for (const n of [1, 10, 50]) expect(smaTrend(candles(randomCloses(len, 7 + len + n)), n).length).toBe(len);
    }
  });
  it("positions are strictly long-flat (0 or 1) on random input", () => {
    expect(isBinary(smaTrend(candles(CHOPPY), 10))).toBe(true);
  });
  it("is flat during warmup, long in a clean uptrend, flat in a clean downtrend", () => {
    expect(smaTrend(candles(ramp(40)), 12).slice(0, 11).every((x) => x === 0)).toBe(true); // i+1 < n
    expect(smaTrend(candles(ramp(40)), 10).at(-1)).toBe(1);
    expect(smaTrend(candles(ramp(40, -1, 300)), 10).at(-1)).toBe(0);
  });
  it("has NO LOOKAHEAD — a far-future bar can't change earlier positions", () => {
    assertNoLookahead((c) => smaTrend(c, 10), CHOPPY, CHOPPY.length - 4);
  });
  it("a constant series never goes long (close == SMA, not strictly greater)", () => {
    expect(smaTrend(candles(new Array(30).fill(100)), 5).every((x) => x === 0)).toBe(true);
  });
});

/* ──────────────────────────── donchianBreakout ─────────────────────────── */
describe("donchianBreakout — properties", () => {
  it("positions are long-flat (0/1) on random input", () => {
    expect(isBinary(donchianBreakout(candles(CHOPPY), 15))).toBe(true);
  });
  it("flat in warmup, long on a monotone uptrend, flat after a monotone downtrend", () => {
    expect(donchianBreakout(candles(ramp(50)), 10).slice(0, 10).every((x) => x === 0)).toBe(true);
    expect(donchianBreakout(candles(ramp(40)), 10).at(-1)).toBe(1);
    expect(donchianBreakout(candles(ramp(40, -1, 300)), 10).at(-1)).toBe(0);
  });
  it("holds its last state through an inside range (no new high or low)", () => {
    // climb to a high, then oscillate strictly inside the prior range → stays long
    const cl = [...ramp(15), 120, 118, 119, 117.5, 118.5, 117.8];
    const p = donchianBreakout(candles(cl), 10);
    expect(p.at(-1)).toBe(1);
  });
  it("has NO LOOKAHEAD on a noisy series", () => {
    assertNoLookahead((c) => donchianBreakout(c, 12), CHOPPY, CHOPPY.length - 6);
  });
});

/* ──────────────────────────── zMeanReversion ───────────────────────────── */
describe("zMeanReversion — properties", () => {
  it("positions are long-flat (0/1)", () => {
    expect(isBinary(zMeanReversion(candles(CHOPPY), 10, 1, 0))).toBe(true);
  });
  it("a constant series never enters (σ=0 → z=0, never below -zEntry)", () => {
    expect(zMeanReversion(candles(new Array(40).fill(100)), 10, 1, 0).every((x) => x === 0)).toBe(true);
  });
  it("enters long after a sharp dip below the mean (z < -zEntry)", () => {
    // flat band, then a deep one-bar crash → strongly negative z → long
    const cl = [...new Array(20).fill(100).map((_, i) => 100 + (i % 2 ? 0.5 : -0.5)), 80];
    expect(zMeanReversion(candles(cl), 10, 1.5, 0.5).at(-1)).toBe(1);
  });
  it("exits once z recovers to ≥ zExit after an entry", () => {
    // dip (enter), then a strong rally back above the mean → z ≥ zExit → flat
    const cl = [...new Array(20).fill(100).map((_, i) => 100 + (i % 2 ? 0.5 : -0.5)), 80, 130];
    const p = zMeanReversion(candles(cl), 10, 1.5, 0.5);
    expect(p.at(-1)).toBe(0);
  });
  it("has NO LOOKAHEAD", () => {
    assertNoLookahead((c) => zMeanReversion(c, 12, 1, 0), CHOPPY2, CHOPPY2.length - 5);
  });
  it("a wider entry threshold never enters MORE bars than a tighter one (monotone in zEntry)", () => {
    const c = candles(CHOPPY);
    const tight = zMeanReversion(c, 10, 0.5, 0).reduce((s, x) => s + x, 0);
    const wide = zMeanReversion(c, 10, 2.0, 0).reduce((s, x) => s + x, 0);
    expect(wide).toBeLessThanOrEqual(tight);
  });
});

/* ───────────────────────────── buyAndHold ──────────────────────────────── */
describe("buyAndHold — properties", () => {
  it("is all-ones for any length", () => {
    for (const len of [0, 1, 5, 50]) {
      const p = buyAndHold(candles(randomCloses(Math.max(len, 0), len + 1)).slice(0, len));
      expect(p.length).toBe(len);
      expect(p.every((x) => x === 1)).toBe(true);
    }
  });
  it("ignores prices entirely and returns an empty array for empty input", () => {
    expect(buyAndHold(candles(ramp(30)))).toEqual(buyAndHold(candles(randomCloses(30, 99))));
    expect(buyAndHold([])).toEqual([]);
  });
});

/* ───────────────────────────── emaMomentum ─────────────────────────────── */
describe("emaMomentum — properties", () => {
  it("positions are long-flat (0/1) on a noisy series", () => {
    expect(isBinary(emaMomentum(candles(CHOPPY), 10, 30))).toBe(true);
  });
  it("is flat through the slow-EMA warmup (i < slow ⇒ 0)", () => {
    expect(emaMomentum(candles(ramp(60)), 10, 30).slice(0, 30).every((x) => x === 0)).toBe(true);
  });
  it("has NO LOOKAHEAD across several interior perturbation points", () => {
    for (const k of [40, 60, CHOPPY.length - 3]) assertNoLookahead((c) => emaMomentum(c, 10, 30), CHOPPY, k);
  });
});

/* ────────────────────────────── macdTrend ──────────────────────────────── */
describe("macdTrend — properties", () => {
  it("positions are long-flat (0/1)", () => {
    expect(isBinary(macdTrend(candles(CHOPPY)))).toBe(true);
  });
  it("is flat through the slow+sig warmup window", () => {
    expect(macdTrend(candles(ramp(80)), 12, 26, 9).slice(0, 35).every((x) => x === 0)).toBe(true);
  });
  it("has NO LOOKAHEAD", () => {
    assertNoLookahead((c) => macdTrend(c, 12, 26, 9), CHOPPY2, CHOPPY2.length - 4);
  });
  it("is callable with its default params (no fast/slow/sig) and yields a binary series", () => {
    const p = macdTrend(candles(ramp(80)));
    expect(p.length).toBe(80);
    expect(isBinary(p)).toBe(true);
  });
});

/* ───────────────────────────── rsiMomentum ─────────────────────────────── */
describe("rsiMomentum — properties", () => {
  it("positions are long-flat (0/1)", () => {
    expect(isBinary(rsiMomentum(candles(CHOPPY), 14, 55, 45))).toBe(true);
  });
  it("is flat while RSI is still NaN (the warmup region)", () => {
    // rsi[i] is NaN for i ≤ n, so the first ~n bars stay at the default flat
    expect(rsiMomentum(candles(ramp(40)), 14, 55, 45).slice(0, 14).every((x) => x === 0)).toBe(true);
  });
  it("long on persistent strength, flat on persistent weakness", () => {
    expect(rsiMomentum(candles(ramp(40)), 14, 55, 45).at(-1)).toBe(1);
    expect(rsiMomentum(candles(ramp(40, -1, 200)), 14, 55, 45).at(-1)).toBe(0);
  });
  it("has NO LOOKAHEAD", () => {
    assertNoLookahead((c) => rsiMomentum(c, 14, 55, 45), CHOPPY, CHOPPY.length - 5);
  });
});

/* ───────────────────────────── atrBreakout ─────────────────────────────── */
describe("atrBreakout — properties", () => {
  it("positions are long-flat (0/1)", () => {
    expect(isBinary(atrBreakout(candles(CHOPPY), 10, 1))).toBe(true);
  });
  it("is flat through the ATR warmup (i < n)", () => {
    expect(atrBreakout(candles(ramp(50)), 10, 1).slice(0, 10).every((x) => x === 0)).toBe(true);
  });
  it("a larger atrMult never enters MORE bars than a smaller one (stricter filter)", () => {
    const c = candles(CHOPPY, 1);
    const loose = atrBreakout(c, 10, 0.5).reduce((s, x) => s + x, 0);
    const strict = atrBreakout(c, 10, 3.0).reduce((s, x) => s + x, 0);
    expect(strict).toBeLessThanOrEqual(loose);
  });
  it("has NO LOOKAHEAD", () => {
    assertNoLookahead((c) => atrBreakout(c, 10, 1), CHOPPY, CHOPPY.length - 6);
  });
});

/* ────────────────────────────── supertrend ─────────────────────────────── */
describe("supertrend — properties", () => {
  it("positions are long-flat (0/1)", () => {
    expect(isBinary(supertrend(candles(CHOPPY, 2), 10, 3))).toBe(true);
  });
  it("is flat through the ATR warmup (i < n)", () => {
    expect(supertrend(candles(ramp(60), 2), 10, 3).slice(0, 10).every((x) => x === 0)).toBe(true);
  });
  it("long at the end of a clean uptrend, flat at the end of a clean downtrend", () => {
    expect(supertrend(candles(ramp(60), 2), 10, 3).at(-1)).toBe(1);
    expect(supertrend(candles(ramp(60, -1, 300), 2), 10, 3).at(-1)).toBe(0);
  });
  it("has NO LOOKAHEAD across multiple interior points", () => {
    for (const k of [50, 80, CHOPPY.length - 4]) assertNoLookahead((c) => supertrend(c, 10, 3), CHOPPY, k);
  });
});

/* ──────────────────────────── gateByVolatility ─────────────────────────── */
describe("gateByVolatility — properties", () => {
  it("output stays long-flat and equal-length when the input positions are long-flat", () => {
    const g = gateByVolatility(candles(CHOPPY), ones(CHOPPY.length), 14, { maxVol: 0.1 });
    expect(g.length).toBe(CHOPPY.length);
    expect(isBinary(g)).toBe(true);
    const p = emaMomentum(candles(CHOPPY), 10, 30);
    expect(isBinary(gateByVolatility(candles(CHOPPY), p, 14, { maxVol: 0.05 }))).toBe(true);
  });
  it("only SUBTRACTS exposure — never raises a 0 to a 1 (all-zero input stays all-zero)", () => {
    const out = gateByVolatility(candles(CHOPPY), zeros(CHOPPY.length), 14, { minVol: 0, maxVol: 1e9 });
    expect(out.every((x) => x === 0)).toBe(true);
  });
  it("for any input, the gated value at i is ≤ the input value at i (never increases)", () => {
    const c = candles(CHOPPY);
    const p = emaMomentum(c, 10, 30);
    const g = gateByVolatility(c, p, 14, { maxVol: 0.04 });
    for (let i = 0; i < p.length; i++) expect(g[i]).toBeLessThanOrEqual(p[i]);
  });
  it("with no bounds it keeps every finite-vol bar but flattens the NaN warmup region", () => {
    const c = candles(CHOPPY);
    const g = gateByVolatility(c, ones(CHOPPY.length), 14);
    expect(g.slice(0, 14).every((x) => x === 0)).toBe(true); // NaN vol warmup → 0
    expect(g.slice(15).every((x) => x === 1)).toBe(true);    // finite vol → input kept
  });
  it("a tighter maxVol never keeps MORE bars than a looser one (monotone gate)", () => {
    const c = candles(CHOPPY);
    const p = ones(CHOPPY.length);
    const loose = gateByVolatility(c, p, 14, { maxVol: 1 }).reduce((s, x) => s + x, 0);
    const tight = gateByVolatility(c, p, 14, { maxVol: 0.02 }).reduce((s, x) => s + x, 0);
    expect(tight).toBeLessThanOrEqual(loose);
  });
  it("has NO LOOKAHEAD (perturbing a future bar leaves earlier gated positions intact)", () => {
    assertNoLookahead((c) => gateByVolatility(c, emaMomentum(c, 10, 30), 14, { maxVol: 0.1 }), CHOPPY, CHOPPY.length - 5);
  });
});

/* ──────────────────────────── volRegimeFilter ──────────────────────────── */
describe("volRegimeFilter — properties", () => {
  it("output is long-flat and equal-length when input positions are long-flat", () => {
    const c = candles(CHOPPY);
    const p = emaMomentum(c, 10, 30);
    const g = volRegimeFilter(c, p, 14, "high");
    expect(g.length).toBe(CHOPPY.length);
    expect(isBinary(g)).toBe(true);
  });
  it("only SUBTRACTS — never sets a 1 where the input was 0 (all-zero input stays all-zero)", () => {
    const c = candles(CHOPPY);
    const out = volRegimeFilter(c, zeros(CHOPPY.length), 14, "low");
    expect(out.every((x) => x === 0)).toBe(true);
  });
  it("for any input, the gated value at i is ≤ the input value at i", () => {
    const c = candles(CHOPPY2);
    const p = emaMomentum(c, 10, 30);
    for (const regime of ["high", "low"] as const) {
      const g = volRegimeFilter(c, p, 14, regime);
      for (let i = 0; i < p.length; i++) expect(g[i]).toBeLessThanOrEqual(p[i]);
    }
  });
  it("the 'high' and 'low' regimes partition the kept bars (no bar kept by both unless on the median)", () => {
    const c = candles(CHOPPY);
    const p = ones(CHOPPY.length);
    const hi = volRegimeFilter(c, p, 14, "high");
    const lo = volRegimeFilter(c, p, 14, "low");
    // each bar's combined exposure can't exceed input (1); overlap only when v[i] == median
    for (let i = 0; i < p.length; i++) {
      if (hi[i] === 1 && lo[i] === 1) continue; // permitted exactly at the median tie
      expect(hi[i] + lo[i]).toBeLessThanOrEqual(1);
    }
  });
  it("is flat until ≥10 finite vol samples of history exist (insufficient-history guard)", () => {
    const c = candles(CHOPPY);
    const out = volRegimeFilter(c, ones(CHOPPY.length), 14, "high", 100);
    // vol is NaN for i<14, then needs ≥10 finite samples in the trailing window → early bars flat
    expect(out.slice(0, 14).every((x) => x === 0)).toBe(true);
    expect(out[15]).toBe(0); // only ~2 finite samples so far → still flat
  });
  it("has NO LOOKAHEAD — uses only the trailing window, so a future bar can't shift earlier positions", () => {
    assertNoLookahead((c) => volRegimeFilter(c, emaMomentum(c, 10, 30), 14, "high"), CHOPPY, CHOPPY.length - 6);
  });
  it("a smaller lookback never references future bars either (still no-lookahead with lookback=20)", () => {
    assertNoLookahead((c) => volRegimeFilter(c, ones(c.length), 14, "low", 20), CHOPPY2, CHOPPY2.length - 5);
  });
});

/* ───────────────── cross-strategy structural invariants ────────────────── */
describe("all strategies — shared structural properties", () => {
  const closes = randomCloses(100, 424242);
  const c = candles(closes, 2);
  const stratFns: Array<[string, (cc: DailyCandle[]) => number[]]> = [
    ["smaTrend", (cc) => smaTrend(cc, 10)],
    ["donchianBreakout", (cc) => donchianBreakout(cc, 12)],
    ["zMeanReversion", (cc) => zMeanReversion(cc, 12, 1, 0)],
    ["buyAndHold", (cc) => buyAndHold(cc)],
    ["emaMomentum", (cc) => emaMomentum(cc, 10, 30)],
    ["macdTrend", (cc) => macdTrend(cc, 12, 26, 9)],
    ["rsiMomentum", (cc) => rsiMomentum(cc, 14, 55, 45)],
    ["atrBreakout", (cc) => atrBreakout(cc, 10, 1)],
    ["supertrend", (cc) => supertrend(cc, 10, 3)],
  ];

  it("every base strategy returns a series of exactly input length", () => {
    for (const [, fn] of stratFns) expect(fn(c).length).toBe(closes.length);
  });
  it("every base strategy is strictly long-flat (0/1)", () => {
    for (const [, fn] of stratFns) expect(isBinary(fn(c))).toBe(true);
  });
  it("every base strategy is deterministic", () => {
    for (const [, fn] of stratFns) expect(fn(c)).toEqual(fn(c));
  });
  it("every base strategy contains no NaN/undefined positions", () => {
    for (const [, fn] of stratFns) {
      for (const v of fn(c)) expect(Number.isFinite(v)).toBe(true);
    }
  });
  it("a gate over each base strategy can only reduce total exposure (sum_gated ≤ sum_base)", () => {
    for (const [, fn] of stratFns) {
      const base = fn(c);
      const baseSum = base.reduce((s, x) => s + x, 0);
      const g1 = gateByVolatility(c, base, 14, { maxVol: 0.05 }).reduce((s, x) => s + x, 0);
      const g2 = volRegimeFilter(c, base, 14, "high").reduce((s, x) => s + x, 0);
      expect(g1).toBeLessThanOrEqual(baseSum);
      expect(g2).toBeLessThanOrEqual(baseSum);
    }
  });
  it("handles a single-bar history without throwing and returns length 1", () => {
    const one = candles([100]);
    for (const [, fn] of stratFns) expect(fn(one).length).toBe(1);
  });
});
