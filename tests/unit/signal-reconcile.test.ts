/**
 * Tests for shadow reconciliation (did routed signals win?) — pure outcome
 * matching + Wilson-bounded summary. No DB / candles.
 */
import { describe, expect, it } from "vitest";
import { reconcileOne, summarize, type RoutedSignal } from "@/lib/signal/reconcile";

function sig(over: Partial<RoutedSignal> = {}): RoutedSignal {
  return { asset: "ETH", recurrence: "5m", side: "DOWN", entry_price: 0.875, window_end_ts: 1000, ...over };
}

describe("reconcileOne", () => {
  it("DOWN bet wins when the window resolved down", () => {
    const r = reconcileOne(sig({ side: "DOWN" }), /*resolvedUp*/ false);
    expect(r.won).toBe(true);
    expect(r.pnl).toBeCloseTo((2 * (1 - 0.875)) / 0.875, 3); // +profit at 0.875 entry
  });

  it("UP bet loses when the window resolved down", () => {
    const r = reconcileOne(sig({ side: "UP", entry_price: 0.8 }), false);
    expect(r.won).toBe(false);
    expect(r.pnl).toBe(-2);
  });

  it("unresolved window → null (pending)", () => {
    const r = reconcileOne(sig(), null);
    expect(r.won).toBeNull();
    expect(r.pnl).toBeNull();
  });
});

describe("summarize", () => {
  it("aggregates win rate, Wilson lower, PnL, and pending", () => {
    const recon = [
      { won: true, pnl: 0.29 }, { won: true, pnl: 0.29 }, { won: false, pnl: -2 },
      { won: null, pnl: null }, // pending
    ];
    const s = summarize(recon);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.win).toBeCloseTo(0.6667, 3);
    expect(s.pending).toBe(1);
    expect(s.winCiLow).toBeLessThan(s.win);
    expect(s.pnl).toBeCloseTo(-1.42, 2);
  });

  it("empty → zeros", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.win).toBe(0);
  });
});
