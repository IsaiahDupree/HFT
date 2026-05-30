import { describe, expect, it } from "vitest";
import { scoreCopyability, type CopyabilityClosedPosition, type CopyabilityTrade } from "@/lib/wallets/copyability";

function closed(cashPnl: number): CopyabilityClosedPosition {
  return { cashPnl, conditionId: `c${cashPnl}` };
}

describe("scoreCopyability", () => {
  it("returns score 0 with insufficient closed-positions sample", () => {
    const r = scoreCopyability({ wallet: "0xA", closedPositions: [closed(10), closed(20)] });
    expect(r.copyabilityScore).toBe(0);
    expect(r.caveats.some((c) => c.includes("insufficient closed positions"))).toBe(true);
  });

  it("returns score 0 when avg PnL is negative (profit-gate)", () => {
    const losses = [-100, -50, -200, -10, -30, -40];
    const r = scoreCopyability({ wallet: "0xA", closedPositions: losses.map(closed) });
    expect(r.copyabilityScore).toBe(0);
    expect(r.avgPnlUsd).toBeLessThan(0);
    expect(r.caveats.some((c) => c.includes("negative expectation"))).toBe(true);
  });

  it("scores a consistent profitable wallet highly", () => {
    // 30 wins of $25 each — perfect consistency, full sample, 100% win rate
    const wins = Array.from({ length: 30 }, () => closed(25));
    const r = scoreCopyability({ wallet: "0xA", closedPositions: wins });
    expect(r.winRate).toBe(1);
    expect(r.avgPnlUsd).toBe(25);
    expect(r.pnlStdevUsd).toBe(0);
    expect(r.copyabilityScore).toBeGreaterThanOrEqual(95);
  });

  it("penalizes high-variance pattern even with same total PnL", () => {
    // Same total ($300) and same N (10), but one is consistent and the other isn't
    const consistent = Array.from({ length: 10 }, () => closed(30));
    const swingy = [closed(500), closed(-100), closed(200), closed(-50), closed(100), closed(-100), closed(50), closed(-50), closed(-100), closed(-150)];
    const rA = scoreCopyability({ wallet: "0xA", closedPositions: consistent });
    const rB = scoreCopyability({ wallet: "0xB", closedPositions: swingy });
    // wallet A's profile is more reliable
    expect(rA.copyabilityScore).toBeGreaterThan(rB.copyabilityScore);
    expect(rA.totalPnlUsd).toBe(300);
  });

  it("penalizes small sample even with high win rate", () => {
    // 5 wins, perfect — but sampleFactor = 5/30 caps score
    const five = [closed(20), closed(20), closed(20), closed(20), closed(20)];
    const thirty = Array.from({ length: 30 }, () => closed(20));
    const rSmall = scoreCopyability({ wallet: "0xA", closedPositions: five });
    const rBig = scoreCopyability({ wallet: "0xB", closedPositions: thirty });
    expect(rBig.copyabilityScore).toBeGreaterThan(rSmall.copyabilityScore);
  });

  it("computes median hold time when trades are provided", () => {
    const closed = [{ cashPnl: 10, conditionId: "c1" }];
    const trades: CopyabilityTrade[] = [
      { conditionId: "c1", timestamp: 1000, side: "BUY", usdcSize: 100 },
      { conditionId: "c1", timestamp: 1000 + 1800, side: "SELL", usdcSize: 100 }, // 30 min later
      { conditionId: "c2", timestamp: 2000, side: "BUY", usdcSize: 50 },
      { conditionId: "c2", timestamp: 2000 + 3600, side: "SELL", usdcSize: 50 }, // 60 min later
    ];
    const r = scoreCopyability({ wallet: "0xA", closedPositions: closed, trades });
    expect(r.medianHoldMinutes).toBe(45); // median of 30 and 60
  });

  it("handles missing trades gracefully (medianHoldMinutes is null + caveat added)", () => {
    const r = scoreCopyability({ wallet: "0xA", closedPositions: [closed(10), closed(20)] });
    expect(r.medianHoldMinutes).toBeNull();
    expect(r.caveats.some((c) => c.includes("hold time unknown"))).toBe(true);
  });

  it("reports largest win + loss across closes", () => {
    const positions = [closed(50), closed(-30), closed(200), closed(-100), closed(10)];
    const r = scoreCopyability({ wallet: "0xA", closedPositions: positions });
    expect(r.largestWinUsd).toBe(200);
    expect(r.largestLossUsd).toBe(-100);
  });

  it("includes the snapshot-only caveat in all reports", () => {
    const r = scoreCopyability({
      wallet: "0xA",
      closedPositions: Array.from({ length: 10 }, () => closed(25)),
    });
    expect(r.caveats.some((c) => c.includes("snapshot-only"))).toBe(true);
  });

  it("score never exceeds 100 even with extreme inputs", () => {
    const huge = Array.from({ length: 1000 }, () => closed(10_000));
    const r = scoreCopyability({ wallet: "0xA", closedPositions: huge });
    expect(r.copyabilityScore).toBeLessThanOrEqual(100);
  });
});
