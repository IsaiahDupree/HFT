/**
 * Unit tests for the inverse-vol position-sizing overlay (sizing.ts): the
 * no-lookahead guarantee (perturbation test), vol-targeting behaviour, turnover
 * control, exit honouring, warmup, and coarse-grid quantization.
 */
import { describe, it, expect } from "vitest";
import { applySizing, turnover } from "@/lib/backtest/candle/sizing";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

const series = (closes: number[]): DailyCandle[] => closes.map((c, i) => ({ start_unix: i * 3600, open: c, high: c, low: c, close: c, volume: 0 }));
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// a random-walk price path of length n
function walk(n: number, seed: number, vol = 0.01): number[] {
  const r = rng(seed); const px = [100];
  for (let i = 1; i < n; i++) px.push(px[i - 1] * (1 + (r() - 0.5) * 2 * vol));
  return px;
}

describe("sizing: no-lookahead (perturbation)", () => {
  it("changing a FUTURE close never changes any earlier size", () => {
    const px = walk(400, 11);
    const c = series(px);
    const raw = new Array(400).fill(1); // always-long signal isolates the sizing
    const base = applySizing(c, raw, { n: 48 });
    // perturb close at index 300 by +20% and re-size
    const px2 = [...px]; px2[300] *= 1.2;
    const perturbed = applySizing(series(px2), raw, { n: 48 });
    // every size at index < 300 must be byte-identical (no peeking at close[300])
    for (let i = 0; i < 300; i++) expect(perturbed[i]).toBe(base[i]);
    // and at/after 300 it is allowed (and expected) to differ
    expect(perturbed.slice(300).some((v, k) => v !== base[300 + k])).toBe(true);
  });
});

describe("sizing: vol-targeting", () => {
  it("a higher-vol path gets a SMALLER average position than a calm path (same signal)", () => {
    const calm = series(walk(2000, 7, 0.004));
    const wild = series(walk(2000, 7, 0.04)); // 10× the per-bar vol, same seed/structure
    const raw = new Array(2000).fill(1);
    const p = { n: 168, targetVolAnnual: 0.3, periodsPerYear: 8760 };
    const avg = (a: number[]) => a.slice(200).reduce((s, x) => s + x, 0) / (a.length - 200);
    expect(avg(applySizing(wild, raw, p))).toBeLessThan(avg(applySizing(calm, raw, p)));
  });
  it("respects posMax as a hard upper clamp", () => {
    const c = series(walk(1000, 3, 0.0005)); // very calm → wants to lever up
    const sized = applySizing(c, new Array(1000).fill(1), { n: 168, posMax: 1.0, volCap: 1.5 });
    expect(Math.max(...sized)).toBeLessThanOrEqual(1.0);
  });
});

describe("sizing: discipline", () => {
  const c = series(walk(1500, 5, 0.012));
  it("sized turnover does not exceed the raw signal's turnover", () => {
    // a choppy raw signal that flips often
    const raw = c.map((_, i) => (Math.floor(i / 17) % 2 === 0 ? 1 : 0));
    const sized = applySizing(c, raw, { n: 168 });
    expect(turnover(sized)).toBeLessThanOrEqual(turnover(raw) + 1e-9);
  });
  it("honors exits: raw==0 ⇒ size==0", () => {
    const raw = c.map((_, i) => (i % 100 < 50 ? 1 : 0));
    const sized = applySizing(c, raw, { n: 48 });
    sized.forEach((s, i) => { if (raw[i] === 0) expect(s).toBe(0); });
  });
  it("sits out during warmup (i < n)", () => {
    const sized = applySizing(c, new Array(1500).fill(1), { n: 168 });
    for (let i = 0; i < 168; i++) expect(sized[i]).toBe(0);
  });
  it("emits only coarse-grid levels (multiples of sizeStep)", () => {
    const sized = applySizing(c, new Array(1500).fill(1), { n: 168, sizeStep: 0.25 });
    for (const s of sized) expect(Math.abs(s / 0.25 - Math.round(s / 0.25))).toBeLessThan(1e-9);
  });
});
