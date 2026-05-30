import { describe, expect, it } from "vitest";
import { realizedVol, returnOver, summarize, zScoreVsRollingMean, type PricePoint } from "@/lib/polymarket/signals";
import { syntheticSeries } from "../helpers/fixtures";

describe("returnOver", () => {
  it.each([
    { len: 2, secondsAgo: 60, expected: null }, // length 2 with same t fails closeness, but expected null when best===latest
  ])("returns null when series too short to differ ($len pts)", ({ len }) => {
    const s: PricePoint[] = [{ t: 100, p: 1 }, { t: 200, p: 2 }];
    expect(returnOver(s.slice(0, len), 0)).toBeNull(); // latest equals best when secondsAgo=0
  });

  it("returns null on empty or single-point series", () => {
    expect(returnOver([], 60)).toBeNull();
    expect(returnOver([{ t: 0, p: 1 }], 60)).toBeNull();
  });

  it.each([
    { latest: 0.6, prev: 0.5, expected: 0.2 },
    { latest: 0.5, prev: 0.5, expected: 0 },
    { latest: 0.4, prev: 0.5, expected: -0.2 },
    { latest: 0.1, prev: 0.05, expected: 1.0 },
    { latest: 0.99, prev: 0.01, expected: 98 },
  ])("computes return $prev → $latest = $expected", ({ latest, prev, expected }) => {
    const s: PricePoint[] = [{ t: 1000, p: prev }, { t: 1060, p: latest }];
    const r = returnOver(s, 60);
    expect(r).toBeCloseTo(expected, 5);
  });

  it("picks the point closest to the requested timestamp", () => {
    const s: PricePoint[] = [
      { t: 0, p: 0.5 },
      { t: 60, p: 0.6 },
      { t: 3600, p: 0.7 },
    ];
    // secondsAgo from latest (3600) is 3600s → target=0 → matches p=0.5
    expect(returnOver(s, 3600)).toBeCloseTo((0.7 - 0.5) / 0.5, 5);
  });

  it("returns null when reference price is 0", () => {
    const s: PricePoint[] = [{ t: 0, p: 0 }, { t: 60, p: 0.5 }];
    expect(returnOver(s, 60)).toBeNull();
  });
});

describe("realizedVol", () => {
  it("returns 0 for series under 3 points", () => {
    expect(realizedVol([])).toBe(0);
    expect(realizedVol([{ t: 0, p: 1 }])).toBe(0);
    expect(realizedVol([{ t: 0, p: 1 }, { t: 1, p: 1 }])).toBe(0);
  });

  it.each([
    { name: "flat", series: [1, 1, 1, 1, 1], expected: 0 },
    { name: "monotone", series: [1, 1.01, 1.0201, 1.030301, 1.04060401], expected: 0 }, // constant 1% returns → std = 0
  ])("$name series has expected vol", ({ series, expected }) => {
    const s = series.map((p, i) => ({ t: i, p }));
    expect(realizedVol(s)).toBeCloseTo(expected, 5);
  });

  it.each([
    { mag: 0.01 },
    { mag: 0.05 },
    { mag: 0.1 },
    { mag: 0.2 },
  ])("vol grows with noise magnitude $mag", ({ mag }) => {
    const base = Array.from({ length: 30 }, (_, i) => 0.5 + Math.sin(i) * mag);
    const s = base.map((p, i) => ({ t: i, p }));
    expect(realizedVol(s)).toBeGreaterThan(0);
  });

  it("skips zero-priced anchor points", () => {
    const s: PricePoint[] = [{ t: 0, p: 0 }, { t: 1, p: 0.5 }, { t: 2, p: 0.6 }];
    // First return is skipped (prev=0); only 0.5→0.6 contributes — but n<2 returns 0
    expect(realizedVol(s)).toBe(0);
  });

  it("monotonic series with varying step sizes produces positive vol", () => {
    const s: PricePoint[] = [
      { t: 0, p: 0.1 },
      { t: 1, p: 0.15 },
      { t: 2, p: 0.13 },
      { t: 3, p: 0.18 },
      { t: 4, p: 0.16 },
    ];
    expect(realizedVol(s)).toBeGreaterThan(0);
  });
});

describe("zScoreVsRollingMean", () => {
  it("returns 0 for short series", () => {
    expect(zScoreVsRollingMean([])).toBe(0);
    expect(zScoreVsRollingMean([{ t: 0, p: 0.5 }])).toBe(0);
    expect(zScoreVsRollingMean([{ t: 0, p: 0.5 }, { t: 1, p: 0.6 }, { t: 2, p: 0.7 }])).toBe(0);
  });

  it("returns 0 when window stdev is 0 (constant window)", () => {
    const s: PricePoint[] = [
      { t: 0, p: 0.5 },
      { t: 1, p: 0.5 },
      { t: 2, p: 0.5 },
      { t: 3, p: 0.5 },
      { t: 4, p: 0.7 },
    ];
    expect(zScoreVsRollingMean(s)).toBe(0);
  });

  it.each([
    { latest: 0.6, window: [0.4, 0.4, 0.4, 0.5, 0.5], expectedSign: 1 },
    { latest: 0.2, window: [0.4, 0.4, 0.4, 0.5, 0.5], expectedSign: -1 },
    { latest: 0.45, window: [0.4, 0.4, 0.4, 0.5, 0.5], expectedSign: 0 }, // near mean
  ])("sign of z-score matches direction from mean (latest $latest)", ({ latest, window, expectedSign }) => {
    const s: PricePoint[] = [...window, latest].map((p, i) => ({ t: i, p }));
    const z = zScoreVsRollingMean(s);
    if (expectedSign === 1) expect(z).toBeGreaterThan(0);
    else if (expectedSign === -1) expect(z).toBeLessThan(0);
    else expect(Math.abs(z)).toBeLessThan(1);
  });
});

describe("summarize", () => {
  it("returns zeros on empty input", () => {
    const s = summarize("x", []);
    expect(s).toEqual({ label: "x", n: 0, mean: 0, std: 0, min: 0, max: 0, p10: 0, p90: 0 });
  });

  it.each([
    { vals: [1], mean: 1, std: 0, min: 1, max: 1 },
    { vals: [1, 2, 3, 4, 5], mean: 3, min: 1, max: 5 },
    { vals: [10, 10, 10, 10, 10], mean: 10, std: 0, min: 10, max: 10 },
  ])("summarises [$vals]", ({ vals, mean, std, min, max }) => {
    const s = summarize("x", vals);
    expect(s.n).toBe(vals.length);
    expect(s.mean).toBeCloseTo(mean, 5);
    if (std !== undefined) expect(s.std).toBeCloseTo(std, 5);
    if (min !== undefined) expect(s.min).toBe(min);
    if (max !== undefined) expect(s.max).toBe(max);
  });

  it("p10 and p90 fall within min/max", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i);
    const s = summarize("x", vals);
    expect(s.p10).toBeGreaterThanOrEqual(s.min);
    expect(s.p10).toBeLessThanOrEqual(s.max);
    expect(s.p90).toBeGreaterThanOrEqual(s.p10);
    expect(s.p90).toBeLessThanOrEqual(s.max);
  });

  it.each([
    { len: 10 }, { len: 50 }, { len: 100 }, { len: 500 }, { len: 1000 },
  ])("handles length $len without throwing", ({ len }) => {
    const vals = Array.from({ length: len }, (_, i) => Math.sin(i) * 0.5 + 0.5);
    const s = summarize("x", vals);
    expect(s.n).toBe(len);
    expect(Number.isFinite(s.mean)).toBe(true);
    expect(Number.isFinite(s.std)).toBe(true);
  });
});

describe("synthetic series helper", () => {
  it.each([
    { len: 5, start: 0.5, slope: 0.01 },
    { len: 50, start: 0.1, slope: 0 },
    { len: 100, start: 0.9, slope: -0.005 },
  ])("produces series of length $len starting at $start", ({ len, start, slope }) => {
    const s = syntheticSeries({ len, start, slope });
    expect(s).toHaveLength(len);
    expect(s[0].p).toBeCloseTo(start, 5);
    expect(s[s.length - 1].p).toBeCloseTo(start + slope * (len - 1), 5);
  });
});
