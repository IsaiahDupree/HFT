/**
 * Pure-function tests for the momentum derivatives. Build candles by hand
 * to validate velocity / acceleration / z-velocity against known shapes.
 */
import { describe, expect, it } from "vitest";
import { acceleration, latestClose, momentumScore, velocity, zVelocity, type Candle } from "@/lib/arena/momentum";

function mkCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ product_id: "X", start_unix: 1_800_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 0 }));
}

describe("momentum primitives", () => {
  it("latestClose returns the last bar's close", () => {
    expect(latestClose(mkCandles([1, 2, 3]))).toBe(3);
    expect(latestClose([])).toBeUndefined();
  });

  it.each([
    { closes: [100, 100, 100, 100, 100, 100], window: 5, expected: 0 },           // flat → 0
    { closes: [100, 101, 102, 103, 104, 105], window: 5, expected: 0.05 },        // +5% over 5
    { closes: [100, 99, 98, 97, 96, 95], window: 5, expected: -0.05 },             // -5% over 5
  ])("velocity over window=$window on closes=$closes ≈ $expected", ({ closes, window, expected }) => {
    expect(velocity(mkCandles(closes), window)).toBeCloseTo(expected, 6);
  });

  it("velocity returns NaN when there isn't enough history", () => {
    expect(Number.isNaN(velocity(mkCandles([100, 101, 102]), 5))).toBe(true);
  });

  it("acceleration is POSITIVE when velocity is increasing over the window", () => {
    // Linear-ish then accelerating: late candles climb harder.
    const closes = [100, 100.1, 100.2, 100.3, 100.4, 100.8, 101.5];
    const a = acceleration(mkCandles(closes), 6);
    expect(a).toBeGreaterThan(0);
  });

  it("acceleration is NEGATIVE when velocity is decaying", () => {
    // Sharp rise early then flattening
    const closes = [100, 100.8, 101.5, 102, 102.1, 102.15, 102.2];
    const a = acceleration(mkCandles(closes), 6);
    expect(a).toBeLessThan(0);
  });

  it("zVelocity returns NaN on a perfectly stationary series (no variance)", () => {
    // 30 candles, all 100 → all velocities are 0 → stdev is 0 → z undefined.
    const closes = Array.from({ length: 30 }, () => 100);
    expect(Number.isNaN(zVelocity(mkCandles(closes), 5))).toBe(true);
  });

  it("zVelocity is finite (near 0) on a low-noise stationary series", () => {
    // Tiny noise so stdev > 0, allowing a finite z-score.
    const closes = Array.from({ length: 30 }, (_, i) => 100 + ((i % 3) - 1) * 0.01);
    const z = zVelocity(mkCandles(closes), 5);
    expect(Number.isFinite(z)).toBe(true);
    expect(Math.abs(z)).toBeLessThan(3);
  });

  it("zVelocity is large positive on a one-shot spike at the end", () => {
    const flat = Array.from({ length: 25 }, () => 100);
    const spike = [101, 102, 103, 104, 105]; // 5% spike in last 5 candles
    const z = zVelocity(mkCandles([...flat, ...spike]), 5);
    expect(z).toBeGreaterThan(1.5);
  });

  it("momentumScore combines velocity + acceleration sign", () => {
    // Rising AND accelerating → positive
    const upAccel = [100, 100.05, 100.1, 100.2, 100.4, 100.8];
    expect(momentumScore(mkCandles(upAccel), 5)).toBeGreaterThan(0.3);
    // Flat → near 0
    const flat = [100, 100, 100, 100, 100, 100];
    expect(Math.abs(momentumScore(mkCandles(flat), 5))).toBeLessThan(0.1);
    // Falling AND accelerating down → negative
    const downAccel = [100, 99.95, 99.9, 99.8, 99.6, 99.2];
    expect(momentumScore(mkCandles(downAccel), 5)).toBeLessThan(-0.3);
  });
});
