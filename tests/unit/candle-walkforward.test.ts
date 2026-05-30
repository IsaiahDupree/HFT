/**
 * Unit tests for walk-forward / out-of-sample validation.
 */
import { describe, it, expect } from "vitest";
import { walkForward } from "@/lib/backtest/candle/walkforward";
import { smaTrend, buyAndHold } from "@/lib/backtest/candle/strategies";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

function series(closes: number[]): DailyCandle[] {
  return closes.map((c, i) => ({ start_unix: i * 86400, open: c, high: c, low: c, close: c, volume: 0 }));
}

describe("walkForward", () => {
  it("splits IS/OOS at isFrac and reports the IS-picked variant on OOS", () => {
    // 100 bars steadily rising → a trend strategy should be long-positive in both halves
    const closes = Array.from({ length: 100 }, (_, i) => 100 * 1.01 ** i);
    const c = series(closes);
    const variants = [10, 20].map((n) => ({ label: `sma${n}`, positions: smaTrend(c, n) }));
    const wf = walkForward(c, variants, { isFrac: 0.7, feeBps: 0 });
    expect(wf.splitAt).toBe(70);
    expect(wf.oosBars).toBe(30);
    expect(wf.is.pnlPct).toBeGreaterThan(0);
    expect(wf.oos.pnlPct).toBeGreaterThan(0); // trend persists OOS
  });

  it("OOS uses only the held-out slice (different from IS PnL)", () => {
    const closes = [...Array.from({ length: 70 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 170 - i)];
    const c = series(closes); // rises then falls
    const wf = walkForward(c, [{ label: "bh", positions: buyAndHold(c) }], { isFrac: 0.7, feeBps: 0 });
    expect(wf.is.pnlPct).toBeGreaterThan(0);  // IS rose
    expect(wf.oos.pnlPct).toBeLessThan(0);    // OOS fell — buy&hold loses out-of-sample
  });
});
