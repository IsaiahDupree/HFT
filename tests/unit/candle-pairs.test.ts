import { describe, it, expect } from "vitest";
import {
  pairPosition, pairReturns, pairsVariantSeries, allPairs, defaultPairsVariants,
} from "@/lib/backtest/candle/pairs";
import { buildPriceSeries, type PriceSeries } from "@/lib/backtest/candle/xsection";

function mk(prices: Record<string, number[]>): { data: PriceSeries; days: number[] } {
  const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
  for (const c of Object.keys(prices)) rows[c] = prices[c].map((close, i) => ({ start_unix: i, close }));
  const { data, days } = buildPriceSeries(rows);
  return { data, days };
}

describe("pairs — pairPosition (z-entry / z-exit / hold band)", () => {
  it("enters SHORT the spread on a large positive z (last point spikes up)", () => {
    expect(pairPosition([0, 0, 0, 0, 5], 1, 0.5, 0)).toBe(-1);
  });
  it("enters LONG the spread on a large negative z (last point spikes down)", () => {
    expect(pairPosition([0, 0, 0, 0, -5], 1, 0.5, 0)).toBe(1);
  });
  it("a constant window (std 0 → z 0) is flat", () => {
    expect(pairPosition([1, 1, 1, 1, 1], 1, 0.5, 1)).toBe(0);
  });
  it("exits (flat) when |z| < exitZ", () => {
    // [-1,1,-1,1,0]: mean 0, std 1, last 0 → z 0 → below exitZ
    expect(pairPosition([-1, 1, -1, 1, 0], 2, 0.5, 1)).toBe(0);
  });
  it("HOLDS the previous position in the dead band exitZ ≤ |z| ≤ entryZ", () => {
    const win = [0, 0, 0, 0, 1]; // z ≈ 1.79, between exitZ 0.5 and entryZ 2
    expect(pairPosition(win, 2, 0.5, 1)).toBe(1);
    expect(pairPosition(win, 2, 0.5, -1)).toBe(-1);
    expect(pairPosition(win, 2, 0.5, 0)).toBe(0);
  });
  it("z is scale-invariant (depends on shape, not magnitude)", () => {
    expect(pairPosition([0, 0, 0, 0, 1], 1, 0.5, 0)).toBe(pairPosition([0, 0, 0, 0, 1000], 1, 0.5, 0));
  });
});

describe("pairs — pairReturns", () => {
  it("identical coins never trade (spread constant 0 → no position → all-zero)", () => {
    const { data, days } = mk({ A: [100, 100, 100, 100, 100, 100], B: [100, 100, 100, 100, 100, 100] });
    const r = pairReturns("A", "B", data, days, 3, 1.5, { feeBps: 10 });
    expect([...r.values()].every((x) => x === 0)).toBe(true);
  });

  it("captures a stretch-then-revert: short the spread on the spike, profit on reversion", () => {
    // A spikes to 130 at day4 (spread stretches), reverts to 100 at day5; B flat.
    const { data, days } = mk({ A: [100, 100, 100, 100, 130, 100], B: [100, 100, 100, 100, 100, 100] });
    const r = pairReturns("A", "B", data, days, 3, 1.0, { feeBps: 1, exitZ: 0.5 });
    expect(r.get(4)).toBeGreaterThan(0); // entered short at the spike, A fell → +PnL
  });

  it("is invariant to scaling one coin's whole path by a constant (spread shifts, z unchanged)", () => {
    const base = mk({ A: [100, 110, 95, 130, 90, 120], B: [100, 100, 100, 100, 100, 100] });
    const scaled = mk({ A: [700, 770, 665, 910, 630, 840], B: [100, 100, 100, 100, 100, 100] }); // A × 7
    const r0 = pairReturns("A", "B", base.data, base.days, 3, 1.0, { feeBps: 5 });
    const r1 = pairReturns("A", "B", scaled.data, scaled.days, 3, 1.0, { feeBps: 5 });
    for (const k of r0.keys()) expect(r1.get(k)).toBeCloseTo(r0.get(k)!, 9);
  });

  it("has NO LOOKAHEAD: perturbing a far-future price leaves earlier returns unchanged", () => {
    const a = [100, 108, 96, 120, 92, 115, 101, 130];
    const b = [100, 101, 99, 102, 98, 103, 100, 104];
    const base = mk({ A: a, B: b });
    const r0 = pairReturns("A", "B", base.data, base.days, 3, 1.0, { feeBps: 5 });
    const a2 = [...a]; a2[7] = 9999;            // mutate only the last day
    const pert = mk({ A: a2, B: b });
    const r1 = pairReturns("A", "B", pert.data, pert.days, 3, 1.0, { feeBps: 5 });
    for (const k of r0.keys()) if (k < base.days.length - 2) expect(r1.get(k)).toBeCloseTo(r0.get(k)!, 12);
  });

  it("is inactive (empty series) when a coin is missing", () => {
    const { data, days } = mk({ A: [100, 101, 102, 103, 104] });
    expect(pairReturns("A", "ZZZ", data, days, 2, 1.5).size).toBe(0);
  });

  it("higher fee never increases a pair's total return when it trades", () => {
    const { data, days } = mk({ A: [100, 100, 100, 130, 100, 125, 100], B: [100, 100, 100, 100, 100, 100, 100] });
    const lo = [...pairReturns("A", "B", data, days, 3, 1.0, { feeBps: 0 }).values()].reduce((s, x) => s + x, 0);
    const hi = [...pairReturns("A", "B", data, days, 3, 1.0, { feeBps: 100 }).values()].reduce((s, x) => s + x, 0);
    expect(hi).toBeLessThan(lo);
  });
});

describe("pairs — portfolio + helpers", () => {
  it("pairsVariantSeries equal-weights active pairs each day", () => {
    const { data, days } = mk({
      A: [100, 100, 100, 130, 100, 100], B: [100, 100, 100, 100, 100, 100], C: [100, 100, 100, 70, 100, 100],
    });
    const pairs = allPairs(["A", "B", "C"]);
    const s = pairsVariantSeries({ label: "x", W: 3, entryZ: 1.0 }, pairs, data, days, { feeBps: 1, startIndex: 3 });
    expect(s).toHaveLength(days.length - 1 - 3);
    expect(s.some((x) => x !== 0)).toBe(true); // at least one pair traded the day-3 dislocation
  });

  it("allPairs returns n·(n−1)/2 unordered pairs", () => {
    expect(allPairs(["A", "B", "C", "D"])).toHaveLength(6);
    expect(allPairs(["A"])).toHaveLength(0);
  });

  it("defaultPairsVariants is the 3×3 window×z grid", () => {
    const vs = defaultPairsVariants();
    expect(vs).toHaveLength(9);
    expect(vs[0]).toEqual({ label: "W20/z1.5", W: 20, entryZ: 1.5 });
    expect(new Set(vs.map((v) => v.W))).toEqual(new Set([20, 40, 60]));
  });
});
