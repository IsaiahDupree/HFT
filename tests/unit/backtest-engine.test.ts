import { describe, expect, it } from "vitest";
import { runBacktest, thresholdMeanReversion } from "@/lib/backtest/engine";
import type { SnapshotPoint } from "@/lib/backtest/types";

function snap(midpoint: number, captured_at = `2026-01-01T00:00:${String(midpoint).padStart(2, "0")}Z`): SnapshotPoint {
  return {
    token_id: "t",
    question: "Will X?",
    midpoint,
    yes_price: midpoint,
    no_price: 1 - midpoint,
    spread: 0,
    volume_24h: 100,
    captured_at,
  };
}

describe("runBacktest — pure backtester", () => {
  it("returns zero pnl when decision function never trades", () => {
    const r = runBacktest([snap(0.5), snap(0.55), snap(0.45)], () => ({ action: "hold" }));
    expect(r.tradesCount).toBe(0);
    expect(r.pnlUsd).toBe(0);
    expect(r.endingEquity).toBe(r.startingCash);
  });

  it("realizes a winning trade end-to-end (enter low, exit high)", () => {
    const fn = thresholdMeanReversion({ buyBelow: 0.30, sellAbove: 0.50, sizeShares: 10 });
    // dip to 0.25, recover to 0.55
    const snaps = [snap(0.40), snap(0.25), snap(0.30), snap(0.55), snap(0.60)];
    const r = runBacktest(snaps, fn, { startingCash: 100 });
    expect(r.tradesCount).toBe(1);
    expect(r.trades[0].entryPrice).toBe(0.25);
    expect(r.trades[0].exitPrice).toBe(0.55);
    expect(r.trades[0].pnl).toBeCloseTo(3.0, 5);                     // 10 * (0.55 - 0.25)
    expect(r.pnlUsd).toBeCloseTo(3.0, 5);
    expect(r.winRate).toBe(1.0);
  });

  it("force-closes any open trade at the last snapshot price", () => {
    const fn = thresholdMeanReversion({ buyBelow: 0.30, sellAbove: 0.90, sizeShares: 5 });
    // enters at 0.25, never reaches 0.90 sell threshold ⇒ force-closed at last price 0.40
    const snaps = [snap(0.25), snap(0.30), snap(0.40)];
    const r = runBacktest(snaps, fn, { startingCash: 100 });
    expect(r.tradesCount).toBe(1);
    expect(r.trades[0].exitPrice).toBe(0.40);
    expect(r.trades[0].pnl).toBeCloseTo(5 * (0.40 - 0.25), 5);
  });

  it("computes max_drawdown and arena score correctly", () => {
    // Strategy whose equity rises then falls
    let entered = false;
    const decide = (s: SnapshotPoint) => {
      if (!entered) {
        entered = true;
        return { action: "enter" as const, side: "YES" as const, size: 100 };
      }
      return { action: "hold" as const };
    };
    const snaps = [
      snap(0.50), // enter at 0.50, equity = 0
      snap(0.70), // mtm: 100 * (0.70-0.50) = +20  ⇒ peak
      snap(0.40), // mtm: 100 * (0.40-0.50) = -10  ⇒ dd = 30 vs peak 1020
    ];
    const r = runBacktest(snaps, decide, { startingCash: 1000 });
    expect(r.maxDrawdownUsd).toBeGreaterThan(0);
    // score = pnl_pct * 100 - 2 * max_dd_pct * 100
    // Sanity: a losing scenario has a negative score.
    expect(r.score).toBeLessThan(0);
  });

  it("doesn't trade when starting cash can't cover the entry", () => {
    const fn = thresholdMeanReversion({ buyBelow: 1.0, sellAbove: 1.5, sizeShares: 1_000_000 });
    const snaps = [snap(0.50)];
    const r = runBacktest(snaps, fn, { startingCash: 10 });
    expect(r.tradesCount).toBe(0);
  });
});
