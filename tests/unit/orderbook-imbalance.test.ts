import { describe, expect, it } from "vitest";
import {
  detectOrderbookImbalance,
  type OrderbookSnapshot,
} from "@/lib/strategies/orderbook-imbalance";

function book(bids: Array<[number, number]>, asks: Array<[number, number]>): OrderbookSnapshot {
  return {
    conditionId: "cond-1",
    marketTitle: "Test market",
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    ts: new Date().toISOString(),
  };
}

describe("detectOrderbookImbalance", () => {
  it("returns null on empty bids", () => {
    expect(detectOrderbookImbalance(book([], [[0.5, 1000]]))).toBeNull();
  });

  it("returns null on empty asks", () => {
    expect(detectOrderbookImbalance(book([[0.5, 1000]], []))).toBeNull();
  });

  it("returns null on dust book below minTotalDepthUsd", () => {
    // bid: $0.5 * 10 = $5, ask: $0.5 * 10 = $5, total $10
    const r = detectOrderbookImbalance(book([[0.5, 10]], [[0.51, 10]]), { minTotalDepthUsd: 1000 });
    expect(r).toBeNull();
  });

  it("returns null on balanced book", () => {
    // bids and asks roughly equal — ratio ~1, below default 3.0 threshold
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 1000], [0.49, 500], [0.48, 500]],
        [[0.51, 1000], [0.52, 500], [0.53, 500]],
      ),
    );
    expect(r).toBeNull();
  });

  it("fires BUY signal on bid-heavy book (ratio >= 3.0)", () => {
    // bid: 0.5*3000 + 0.49*1000 + 0.48*1000 = 1500+490+480 = 2470
    // ask: 0.51*500 + 0.52*100 + 0.53*100 = 255+52+53 = 360
    // ratio = 2470/360 = 6.86 → BUY
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 3000], [0.49, 1000], [0.48, 1000]],
        [[0.51, 500], [0.52, 100], [0.53, 100]],
      ),
    );
    expect(r).not.toBeNull();
    expect(r!.side).toBe("BUY");
    expect(r!.imbalanceRatio).toBeGreaterThan(3);
  });

  it("fires SELL signal on ask-heavy book (ratio <= 1/3.0)", () => {
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 500], [0.49, 100], [0.48, 100]],
        [[0.51, 3000], [0.52, 1000], [0.53, 1000]],
      ),
    );
    expect(r).not.toBeNull();
    expect(r!.side).toBe("SELL");
    expect(r!.imbalanceRatio).toBeLessThan(0.34);
  });

  it("signalStrength is between 0 and 1", () => {
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 50_000], [0.49, 10_000], [0.48, 10_000]],
        [[0.51, 100], [0.52, 50], [0.53, 50]],
      ),
    );
    expect(r!.signalStrength).toBeGreaterThan(0);
    expect(r!.signalStrength).toBeLessThanOrEqual(1);
  });

  it("uses only top-N levels (default 3)", () => {
    // Add a huge bid at level 4 — should NOT count
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 1000], [0.49, 1000], [0.48, 1000], [0.47, 1_000_000]],
        [[0.51, 1000], [0.52, 1000], [0.53, 1000], [0.54, 1_000_000]],
      ),
    );
    expect(r).toBeNull(); // top-3 are balanced
  });

  it("custom topLevels = 5 includes deeper book", () => {
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 100], [0.49, 100], [0.48, 100], [0.47, 100], [0.46, 10_000]],
        [[0.51, 100], [0.52, 100], [0.53, 100], [0.54, 100], [0.55, 100]],
      ),
      { topLevels: 5, minRatio: 3.0 },
    );
    expect(r).not.toBeNull();
    expect(r!.side).toBe("BUY");
  });

  it("custom minRatio = 2.0 catches a 2.5:1 skew that wouldn't fire at default 3.0", () => {
    // ratio ~2.5
    const args: Parameters<typeof detectOrderbookImbalance>[0] = book(
      [[0.5, 2500], [0.49, 100], [0.48, 100]],
      [[0.51, 1000], [0.52, 100], [0.53, 100]],
    );
    expect(detectOrderbookImbalance(args, { minRatio: 3.0 })).toBeNull();
    expect(detectOrderbookImbalance(args, { minRatio: 2.0 })).not.toBeNull();
  });

  it("output includes marketKey alias for downstream consumers", () => {
    const r = detectOrderbookImbalance(
      book(
        [[0.5, 3000], [0.49, 1000], [0.48, 1000]],
        [[0.51, 500], [0.52, 100], [0.53, 100]],
      ),
    );
    expect(r!.marketKey).toBe("cond-1");
  });
});
