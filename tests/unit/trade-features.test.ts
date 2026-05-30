import { describe, expect, it } from "vitest";
import {
  extractTradeFeatures,
  type TradeForFeatures,
  type WalletHistorySummary,
} from "@/lib/wallets/trade-features";

const NOW = Date.parse("2026-05-25T14:00:00Z"); // hour 14 UTC

function trade(overrides: Partial<TradeForFeatures> = {}): TradeForFeatures {
  return {
    marketKey: "cond-1",
    direction: "YES",
    side: "BUY",
    price: 0.5,
    usd: 200,
    ts: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function history(overrides: Partial<WalletHistorySummary> = {}): WalletHistorySummary {
  return {
    medianTradeUsd: 100,
    tradesPerHourMean: 1,
    peakHourUtc: 14,
    recentTrades: [],
    ...overrides,
  };
}

describe("extractTradeFeatures", () => {
  it("returns sane defaults with minimal context", () => {
    const f = extractTradeFeatures({ trade: trade(), walletHistory: history(), nowMs: NOW });
    expect(f.priorPriceMove5minPct).toBeNull();
    expect(f.withMoveScore).toBeNull();
    expect(f.sizeZScore).toBeCloseTo(1, 6); // (200-100)/100
    expect(f.inPeakWindow).toBe(true);
    expect(f.hourUtc).toBe(14);
    expect(f.likelyDrivers.length).toBeGreaterThan(0);
  });

  it("flags a size z-score > 4 + extreme price as news_fade", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 5000, price: 0.92 }),
      walletHistory: history({ medianTradeUsd: 100 }),
      nowMs: NOW,
    });
    expect(f.sizeZScore).toBeGreaterThan(40); // (5000-100)/100
    expect(f.likelyDrivers[0]).toContain("news fade");
  });

  it("flags activity surge when cadence > 2x baseline", () => {
    const tickAt = (mins: number) =>
      ({ ...trade(), ts: new Date(NOW - mins * 60_000).toISOString() } as TradeForFeatures);
    const recent = [tickAt(5), tickAt(10), tickAt(20), tickAt(30), tickAt(40)]; // 5 trades in last hour
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 1, recentTrades: recent }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBeGreaterThan(2);
    expect(f.likelyDrivers.some((d) => d.includes("activity surge"))).toBe(true);
  });

  it("ranks cross-wallet consensus tail as the top driver when 3+ wallets / 2+ clusters", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history(),
      crossWallet: { agreementCount5min: 4, clusterCount5min: 3 },
      nowMs: NOW,
    });
    expect(f.likelyDrivers[0]).toContain("cross-wallet consensus tail");
    expect(f.driverConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects momentum follower from marketContext (5min move + same direction)", () => {
    // Price was 0.40 5min ago, now 0.50 → 25% up move. BUY YES is aligned.
    const ctx = new Map<number, number>([[5, 0.40], [30, 0.42]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.50, side: "BUY", direction: "YES" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct).toBeCloseTo(0.25, 4);
    expect(f.withMoveScore).toBe(1);
    expect(f.likelyDrivers.some((d) => d.includes("momentum follower"))).toBe(true);
  });

  it("detects fade-big-move when trade is against a > 5% prior move", () => {
    // Price was 0.40 5min ago, now 0.50. SELL YES = against the up move.
    const ctx = new Map<number, number>([[5, 0.40]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.50, side: "SELL", direction: "YES" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.withMoveScore).toBe(-1);
    expect(f.likelyDrivers.some((d) => d.includes("fade big move"))).toBe(true);
  });

  it("handles 'mid-move' (between 2% and 5%) with the early-fade/tail labels", () => {
    // Price was 0.49 5min ago, now 0.50 → 2.04% up. Below 5% so it's "small".
    const ctx = new Map<number, number>([[5, 0.49]]);
    const fMomentum = extractTradeFeatures({
      trade: trade({ price: 0.50, side: "BUY", direction: "YES" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    const fFade = extractTradeFeatures({
      trade: trade({ price: 0.50, side: "SELL", direction: "YES" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(fMomentum.likelyDrivers.some((d) => d.includes("momentum-tail"))).toBe(true);
    expect(fFade.likelyDrivers.some((d) => d.includes("early fade"))).toBe(true);
  });

  it("returns 'scheduled / routine' when in peak window with normal size and no other signal", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 110 }), // close to median
      walletHistory: history({ medianTradeUsd: 100, peakHourUtc: 14 }),
      nowMs: NOW,
    });
    expect(f.likelyDrivers[0]).toContain("scheduled");
  });

  it("falls back to 'no dominant driver' when nothing fires", () => {
    // Use a trade outside the peak window with size near median so the
    // "scheduled / routine" rule doesn't catch it either.
    const f = extractTradeFeatures({
      trade: trade({ usd: 110, ts: new Date(Date.parse("2026-05-25T03:00:00Z")).toISOString() }),
      walletHistory: history({ medianTradeUsd: 100, peakHourUtc: 14 }),
      nowMs: NOW,
    });
    expect(f.likelyDrivers[0]).toBe("no dominant driver");
    expect(f.driverConfidence).toBeLessThan(0.5);
  });

  it("computes inPeakWindow correctly across hour wrap", () => {
    // Peak hour 1, trade at hour 23 → distance is min(|23-1|, 24-|23-1|) = min(22, 2) = 2
    const f = extractTradeFeatures({
      trade: trade({ ts: new Date(Date.parse("2026-05-25T23:00:00Z")).toISOString() }),
      walletHistory: history({ peakHourUtc: 1 }),
      nowMs: NOW,
    });
    expect(f.inPeakWindow).toBe(true);
  });

  it("ranks multiple competing drivers by weight (news fade > momentum > surge)", () => {
    // Large + extreme + cadence surge + cross-wallet
    const ctx = new Map<number, number>([[5, 0.4]]);
    const recent = Array.from({ length: 6 }, (_, i) => ({
      ...trade(),
      ts: new Date(NOW - (i + 1) * 5 * 60_000).toISOString(),
    }));
    const f = extractTradeFeatures({
      trade: trade({ usd: 8000, price: 0.92, side: "BUY", direction: "YES" }),
      walletHistory: history({ medianTradeUsd: 100, recentTrades: recent }),
      marketContext: { pricesBeforeMin: ctx },
      crossWallet: { agreementCount5min: 4, clusterCount5min: 3 },
      nowMs: NOW,
    });
    // Cross-wallet consensus tail (0.9) wins
    expect(f.likelyDrivers[0]).toContain("cross-wallet consensus tail");
    // news fade (0.85) should rank second
    expect(f.likelyDrivers[1]).toContain("news fade");
  });
});
