import { describe, it, expect } from "vitest";
import { detectLookahead, detectRecursive } from "@/lib/backtest/lookahead-detect";
import { mrPositions, type Bar } from "@/lib/exec/stable-mr";

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ time: i, close: c }));
const series = Array.from({ length: 100 }, (_, i) => ({ close: 1 + 0.01 * Math.sin(i / 5) }));

describe("detectLookahead — the truncation test", () => {
  it("PASSES a clean strategy that uses only the current bar", () => {
    const clean = (b: readonly { close: number }[]) => b.map((x) => (x.close > 1 ? 1 : -1));
    const r = detectLookahead(clean, series);
    expect(r.biased).toBe(false);
    expect(r.checkedTruncations).toBeGreaterThan(0);
  });
  it("CATCHES a strategy that peeks at the next bar", () => {
    const peeker = (b: readonly { close: number }[]) => b.map((x, i) => (i + 1 < b.length && b[i + 1].close > x.close ? 1 : -1));
    const r = detectLookahead(peeker, series);
    expect(r.biased).toBe(true);
    expect(r.firstMismatchIndex).not.toBeNull();
    expect(r.detail).toMatch(/LOOKAHEAD/);
  });
  it("certifies our real mrPositions (stablecoin MR) is lookahead-free", () => {
    const b = bars(series.map((s) => s.close));
    const r = detectLookahead((bb) => mrPositions(bb as Bar[], { entry: 0.003, exit: 0.0005, maxHold: 20 }), b);
    expect(r.biased).toBe(false);
  });
});

describe("detectRecursive — the warmup test", () => {
  it("a non-recursive indicator (last close) converges immediately", () => {
    const lastClose = (w: readonly { close: number }[]) => w[w.length - 1].close;
    const r = detectRecursive(lastClose, series);
    expect(r.converged).toBe(true);
    expect(r.warmupNeeded).toBe(r.values[0].warmup); // stable from the smallest warmup
  });
  it("flags an EMA (recursive, infinite-lookback) as needing warmup / not converging at tight tol", () => {
    const ema = (w: readonly { close: number }[]) => {
      const k = 2 / (50 + 1); let e = w[0].close;
      for (let i = 1; i < w.length; i++) e = w[i].close * k + e * (1 - k);
      return e;
    };
    const r = detectRecursive(ema, series, { warmups: [5, 10, 20], tol: 1e-9 });
    // an EMA seeded at the window start drifts with warmup at a tight tolerance → not yet converged
    expect(r.warmupNeeded === null || r.warmupNeeded! >= 10).toBe(true);
    expect(r.values.length).toBeGreaterThan(1);
  });
});
