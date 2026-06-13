/**
 * Locks the EXACT honest-fill mechanic the dip-catcher verdict rests on
 * (scripts/dip-catcher-backtest.ts): a flat cheap resting BUY bid fills ONLY
 * when the real trade tape SELLS through it — a book mid merely *touching* the
 * price does NOT fill us. This is the honest counter to the optimistic mid-touch
 * backtest. Uses the real bridge (toQueueEvents) + queue model (simulateQueueFills).
 */
import { describe, it, expect } from "vitest";
import { toQueueEvents } from "@/lib/backtest/pmxt";
import { simulateQueueFills, type RestingQuote } from "@/lib/backtest/queue-fill";
import type { PmxtEvent } from "@/lib/backtest/pmxt";

const quote: RestingQuote = { side: "bid", price: 0.03, size: 25, postedTs: 1000 };

describe("dip-catcher honest-fill mechanic", () => {
  it("a book mid dipping to 3c with NO trade through it does NOT fill the resting 3c bid", () => {
    // The book shows our price as the touch (ask collapses to 3c) but nobody PRINTS a sell at 3c.
    const events: PmxtEvent[] = [
      { type: "book", ts: 1100, bids: [[0.03, 50]], asks: [[0.04, 200]] },
      { type: "book", ts: 1200, bids: [[0.03, 50]], asks: [[0.03, 10]] }, // mid "touched" 3c — optimism would fill
      { type: "book", ts: 1300, bids: [[0.02, 80]], asks: [[0.05, 100]] }, // reverses away, still no print at 3c
    ];
    const r = simulateQueueFills(quote, toQueueEvents(events, quote), { cancelMode: "prorata" });
    expect(r.filledQty).toBe(0); // honest model: no sell through 3c ⇒ no fill
  });

  it("fills only when a SELL print trades at/through 3c (after clearing the queue ahead)", () => {
    const events: PmxtEvent[] = [
      { type: "book", ts: 1100, bids: [[0.03, 10]], asks: [[0.05, 100]] }, // 10 visible ahead of us at 3c
      { type: "trade", ts: 1200, price: 0.03, size: 40, aggressor: "SELL" }, // sells through: 10 ahead, then 25 to us
    ];
    const r = simulateQueueFills(quote, toQueueEvents(events, quote), { cancelMode: "prorata" });
    expect(r.filledQty).toBeCloseTo(25, 9); // full clip after the 10 ahead is consumed
  });

  it("a SELL print that does not reach 3c leaves us unfilled", () => {
    const events: PmxtEvent[] = [
      { type: "book", ts: 1100, bids: [[0.04, 30]], asks: [[0.05, 100]] },
      { type: "trade", ts: 1200, price: 0.04, size: 50, aggressor: "SELL" }, // prints at 4c, never at/through our 3c
    ];
    const r = simulateQueueFills(quote, toQueueEvents(events, quote), { cancelMode: "prorata" });
    expect(r.filledQty).toBe(0);
  });

  it("no trades on the tape at all ⇒ zero fills (the kill-switch the report flags)", () => {
    const events: PmxtEvent[] = [
      { type: "book", ts: 1100, bids: [[0.03, 5]], asks: [[0.06, 100]] },
      { type: "book", ts: 1500, bids: [[0.03, 5]], asks: [[0.06, 100]] },
    ];
    const r = simulateQueueFills(quote, toQueueEvents(events, quote), { cancelMode: "prorata" });
    expect(r.filledQty).toBe(0);
  });
});
