import { describe, expect, it } from "vitest";
import {
  applyLatency,
  getFillFn,
  latencyMsToSnapshots,
  midpointFill,
  walkBookFill,
} from "@/lib/backtest/fill-model";
import type { SnapshotPoint } from "@/lib/backtest/types";
import { runBacktest, thresholdMeanReversion } from "@/lib/backtest/engine";

function snap(
  midpoint: number,
  yes: number,
  no: number,
  spread: number,
  captured_at = `2026-01-01T00:00:${String(Math.floor(midpoint * 100)).padStart(2, "0")}Z`,
): SnapshotPoint {
  return {
    token_id: "t", question: "q",
    midpoint, yes_price: yes, no_price: no, spread,
    volume_24h: 100, captured_at,
  };
}

describe("midpointFill", () => {
  it("fills full size at midpoint", () => {
    const r = midpointFill({ side: "YES", snapshot: snap(0.5, 0.45, 0.55, 0.1), size: 10 });
    expect(r.price).toBe(0.5);
    expect(r.filledSize).toBe(10);
  });
  it("returns null when midpoint is missing", () => {
    const r = midpointFill({ side: "YES", snapshot: { ...snap(0, 0, 0, 0), midpoint: null }, size: 10 });
    expect(r.price).toBeNull();
    expect(r.filledSize).toBe(0);
  });
});

describe("walkBookFill", () => {
  // For binary markets the snapshot's yes_price / no_price are the *asks*.
  // The implied bid for YES is 1 − no_ask; for NO it's 1 − yes_ask. So a
  // snapshot with yes_ask=0.55 and no_ask=0.50 has yes_bid=0.50, no_bid=0.45,
  // and an implied bid-ask spread of $0.05.
  it("open YES pays the yes ask", () => {
    const r = walkBookFill({ side: "YES", action: "open", snapshot: snap(0.5, 0.55, 0.50, 0.05), size: 10 });
    expect(r.price).toBe(0.55);
  });
  it("close YES receives 1 − no_ask (the YES bid)", () => {
    const r = walkBookFill({ side: "YES", action: "close", snapshot: snap(0.5, 0.55, 0.50, 0.05), size: 10 });
    expect(r.price).toBeCloseTo(1 - 0.50, 5);
  });
  it("open NO pays the no ask", () => {
    const r = walkBookFill({ side: "NO", action: "open", snapshot: snap(0.5, 0.55, 0.50, 0.05), size: 10 });
    expect(r.price).toBe(0.50);
  });
  it("close NO receives 1 − yes_ask", () => {
    const r = walkBookFill({ side: "NO", action: "close", snapshot: snap(0.5, 0.55, 0.50, 0.05), size: 10 });
    expect(r.price).toBeCloseTo(1 - 0.55, 5);
  });
  it("falls back to midpoint ± half-spread when explicit price missing", () => {
    const s = { ...snap(0.5, 0, 0, 0.1), yes_price: null, no_price: null };
    const open = walkBookFill({ side: "YES", action: "open", snapshot: s, size: 10 });
    expect(open.price).toBeCloseTo(0.55, 5); // midpoint + half spread
    const close = walkBookFill({ side: "YES", action: "close", snapshot: s, size: 10 });
    expect(close.price).toBeCloseTo(0.45, 5); // midpoint - half spread
  });
});

describe("getFillFn", () => {
  it("returns midpoint or walk_book by name", () => {
    expect(getFillFn("midpoint")).toBe(midpointFill);
    expect(getFillFn("walk_book")).toBe(walkBookFill);
  });
});

describe("applyLatency", () => {
  const snaps = [snap(0.4, 0.4, 0.6, 0.0), snap(0.5, 0.5, 0.5, 0.0), snap(0.6, 0.6, 0.4, 0.0)];
  it("returns the same snapshot when delay=0", () => {
    expect(applyLatency(snaps, 0, 0)).toBe(snaps[0]);
  });
  it("shifts by delay snapshots", () => {
    expect(applyLatency(snaps, 0, 1)).toBe(snaps[1]);
    expect(applyLatency(snaps, 0, 2)).toBe(snaps[2]);
  });
  it("clamps to the last snapshot", () => {
    expect(applyLatency(snaps, 1, 99)).toBe(snaps[2]);
  });
});

describe("latencyMsToSnapshots", () => {
  it("returns 0 when latencyMs=0 or snapshots too sparse", () => {
    const snaps = [
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:00Z"),
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:01:00Z"),  // 60s apart
    ];
    expect(latencyMsToSnapshots(snaps, 0)).toBe(0);
  });
  it("estimates snapshot count from average inter-snapshot gap", () => {
    const snaps = [
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:00Z"),
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:01:00Z"),  // 60s apart
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:02:00Z"),  // 60s apart again
    ];
    // 60s gap, so 30000ms latency ≈ 1 snapshot of delay
    expect(latencyMsToSnapshots(snaps, 30_000)).toBe(1);
    // 120000ms ≈ 2 snapshots
    expect(latencyMsToSnapshots(snaps, 120_000)).toBe(2);
  });
});

describe("runBacktest — fill model integration", () => {
  it("walk_book pays the spread on round trip (PnL < midpoint when spread > 0)", () => {
    // Each snap has a 2¢ bid-ask spread: yes_ask + no_ask = 1.02
    // YES bid = 1 − no_ask
    const snaps = [
      snap(0.40, 0.41, 0.61, 0.02),
      snap(0.25, 0.26, 0.76, 0.02),  // dip — triggers buy
      snap(0.30, 0.31, 0.71, 0.02),
      snap(0.55, 0.56, 0.46, 0.02),  // recovery — triggers exit
      snap(0.60, 0.61, 0.41, 0.02),
    ];
    const fn = thresholdMeanReversion({ buyBelow: 0.30, sellAbove: 0.50, sizeShares: 10 });
    const mid = runBacktest(snaps, fn, { fillModel: "midpoint" });
    const wlk = runBacktest(snaps, fn, { fillModel: "walk_book" });
    expect(mid.tradesCount).toBe(1);
    expect(wlk.tradesCount).toBe(1);
    // Midpoint: buy 0.25, sell 0.55 → +0.30/share
    // Walk-book: buy yes_ask=0.26, sell (1 − no_ask) = 1 − 0.46 = 0.54 → +0.28/share
    // So walk-book is 0.02 × 10 = $0.20 worse per round trip (spread cost twice halved).
    expect(wlk.pnlUsd).toBeLessThan(mid.pnlUsd);
  });

  it("latency shifts the fill price to a later snapshot", () => {
    const snaps = [
      snap(0.40, 0.40, 0.60, 0, "2026-01-01T00:00:00Z"),
      snap(0.25, 0.25, 0.75, 0, "2026-01-01T00:01:00Z"),  // decision-snapshot for buy
      snap(0.35, 0.35, 0.65, 0, "2026-01-01T00:02:00Z"),  // latency=60s → fills here
      snap(0.55, 0.55, 0.45, 0, "2026-01-01T00:03:00Z"),  // decision-snapshot for exit
      snap(0.65, 0.65, 0.35, 0, "2026-01-01T00:04:00Z"),  // latency → fills here
    ];
    const fn = thresholdMeanReversion({ buyBelow: 0.30, sellAbove: 0.50, sizeShares: 10 });
    const noLag = runBacktest(snaps, fn);
    const lagged = runBacktest(snaps, fn, { latencyMs: 60_000 });
    expect(noLag.trades[0].entryPrice).toBe(0.25);   // fills at decision snapshot
    expect(lagged.trades[0].entryPrice).toBe(0.35);  // fills one snapshot later (worse)
  });
});
