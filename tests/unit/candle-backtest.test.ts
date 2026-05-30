/**
 * Unit tests for the candle backtest engine + daily strategies.
 */
import { describe, it, expect } from "vitest";
import { runCandleBacktest, type DailyCandle } from "@/lib/backtest/candle/engine";
import { buyAndHold, smaTrend, donchianBreakout } from "@/lib/backtest/candle/strategies";

function series(closes: number[]): DailyCandle[] {
  return closes.map((c, i) => ({ start_unix: i * 86400, open: c, high: c, low: c, close: c, volume: 0 }));
}

describe("candle backtest engine", () => {
  it("buy-and-hold on a rising series → PnL ≈ buy&hold, no trades cost beyond entry", () => {
    const c = series([100, 110, 121, 133.1]); // +10%/bar
    const r = runCandleBacktest(c, buyAndHold(c), { feeBps: 0 });
    expect(r.pnlPct).toBeCloseTo(33.1, 1);
    expect(r.buyHoldPct).toBeCloseTo(33.1, 1);
    expect(r.trades).toBe(1);
  });

  it("flat positions → zero PnL", () => {
    const c = series([100, 90, 120, 80]);
    const r = runCandleBacktest(c, new Array(c.length).fill(0), { feeBps: 10 });
    expect(r.pnlPct).toBeCloseTo(0, 9);
    expect(r.trades).toBe(0);
  });

  it("fees reduce PnL on turnover", () => {
    const c = series([100, 101, 100, 101, 100]);
    const noFee = runCandleBacktest(c, [1, 0, 1, 0, 0], { feeBps: 0 });
    const fee = runCandleBacktest(c, [1, 0, 1, 0, 0], { feeBps: 50 });
    expect(fee.pnlPct).toBeLessThan(noFee.pnlPct);
  });
});

describe("daily strategies", () => {
  it("smaTrend is flat before it has n closes, then long above the SMA", () => {
    const c = series([10, 11, 12, 13, 14, 15]);
    const pos = smaTrend(c, 3);
    expect(pos[0]).toBe(0); // < n closes
    expect(pos[5]).toBe(1); // rising → above SMA
  });

  it("donchianBreakout goes long on a new high and exits on a new low", () => {
    const c = series([10, 10, 10, 10, 20, 20, 5, 5]);
    const pos = donchianBreakout(c, 3);
    expect(pos[4]).toBe(1);  // 20 > prior 3-day high (10) → long
    expect(pos[6]).toBe(0);  // 5 < prior 3-day low → exit
  });
});
