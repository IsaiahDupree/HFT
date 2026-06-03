import { describe, expect, it } from "vitest";
import {
  extractTradeFeatures,
  type TradeForFeatures,
  type WalletHistorySummary,
  type TradeFeaturesInput,
} from "@/lib/wallets/trade-features";

// Fixed clock so every test value is deterministic — no wall-clock reads.
const NOW = Date.parse("2026-05-25T14:00:00Z"); // hour 14 UTC

// Small seeded LCG (Numerical Recipes constants) for any pseudo-randomness.
// Fully deterministic: same seed → same sequence on every run/machine.
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000; // in [0, 1)
  };
}

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

// Assert every numeric field on the returned features is a real, finite-or-allowed number.
function assertNoNaN(f: ReturnType<typeof extractTradeFeatures>) {
  const numericMaybeNull = [f.priorPriceMove5minPct, f.priorPriceMove30minPct, f.withMoveScore];
  for (const v of numericMaybeNull) {
    if (v !== null) expect(Number.isNaN(v)).toBe(false);
  }
  expect(Number.isNaN(f.sizeZScore)).toBe(false);
  expect(Number.isNaN(f.crossWalletAgreement5min)).toBe(false);
  expect(Number.isNaN(f.crossWalletClusters5min)).toBe(false);
  expect(Number.isNaN(f.hourUtc)).toBe(false);
  expect(Number.isNaN(f.driverConfidence)).toBe(false);
  // cadence may be Infinity by design, but never NaN.
  expect(Number.isNaN(f.cadenceAccelerationFactor)).toBe(false);
}

describe("extractTradeFeatures — invariants & robustness", () => {
  it("is deterministic: identical input yields deeply-equal output", () => {
    const input: TradeFeaturesInput = {
      trade: trade({ usd: 333, price: 0.71 }),
      walletHistory: history({ medianTradeUsd: 120, tradesPerHourMean: 2 }),
      crossWallet: { agreementCount5min: 2, clusterCount5min: 1 },
      nowMs: NOW,
    };
    const a = extractTradeFeatures(input);
    const b = extractTradeFeatures(input);
    expect(a).toEqual(b);
    // re-run with freshly-rebuilt-but-equal input to confirm no hidden state
    const c = extractTradeFeatures({
      trade: trade({ usd: 333, price: 0.71 }),
      walletHistory: history({ medianTradeUsd: 120, tradesPerHourMean: 2 }),
      crossWallet: { agreementCount5min: 2, clusterCount5min: 1 },
      nowMs: NOW,
    });
    expect(c).toEqual(a);
  });

  it("produces no NaN across a seeded sweep of synthetic trades", () => {
    const rng = makeLcg(424242);
    for (let i = 0; i < 50; i++) {
      const price = Math.max(0.001, Math.min(0.999, rng()));
      const usd = Math.round(rng() * 10000);
      const median = Math.round(rng() * 500); // sometimes 0 → exercises the guard
      const tph = Math.floor(rng() * 4); // sometimes 0 → exercises Infinity branch
      const f = extractTradeFeatures({
        trade: trade({ usd, price, side: rng() < 0.5 ? "BUY" : "SELL" }),
        walletHistory: history({ medianTradeUsd: median, tradesPerHourMean: tph }),
        nowMs: NOW,
      });
      assertNoNaN(f);
      expect(f.likelyDrivers.length).toBeGreaterThan(0);
      expect(f.driverConfidence).toBeGreaterThan(0);
      expect(f.driverConfidence).toBeLessThanOrEqual(0.9);
    }
  });

  it("always returns at least one likelyDriver and a positive bounded confidence", () => {
    const f = extractTradeFeatures({
      trade: trade({ ts: new Date(Date.parse("2026-05-25T03:00:00Z")).toISOString() }),
      walletHistory: history({ peakHourUtc: 14 }),
      nowMs: NOW,
    });
    expect(f.likelyDrivers.length).toBeGreaterThanOrEqual(1);
    expect(f.driverConfidence).toBeGreaterThan(0);
    expect(f.driverConfidence).toBeLessThanOrEqual(0.9);
  });

  it("driverConfidence equals the weight of the top-ranked (first) driver", () => {
    // cross-wallet (0.9) is the max possible weight; it must dominate.
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history(),
      crossWallet: { agreementCount5min: 5, clusterCount5min: 3 },
      nowMs: NOW,
    });
    expect(f.likelyDrivers[0]).toContain("cross-wallet consensus tail");
    expect(f.driverConfidence).toBeCloseTo(0.9, 6);
  });

  it("likelyDrivers are ordered by non-increasing weight (confidence is the max)", () => {
    // Stack several signals: cross-wallet + news fade + surge.
    const recent = Array.from({ length: 6 }, (_, i) => ({
      ...trade(),
      ts: new Date(NOW - (i + 1) * 5 * 60_000).toISOString(),
    }));
    const f = extractTradeFeatures({
      trade: trade({ usd: 9000, price: 0.92 }),
      walletHistory: history({ medianTradeUsd: 100, tradesPerHourMean: 1, recentTrades: recent }),
      crossWallet: { agreementCount5min: 4, clusterCount5min: 2 },
      nowMs: NOW,
    });
    expect(f.likelyDrivers.length).toBeGreaterThanOrEqual(3);
    // Top driver's confidence is the global max — no later driver can have outranked it.
    expect(f.driverConfidence).toBeCloseTo(0.9, 6);
    expect(f.likelyDrivers[0]).toContain("cross-wallet consensus tail");
  });
});

describe("extractTradeFeatures — sizeZScore", () => {
  it("is exactly zero when trade size equals the median", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 100 }),
      walletHistory: history({ medianTradeUsd: 100 }),
      nowMs: NOW,
    });
    expect(f.sizeZScore).toBeCloseTo(0, 9);
  });

  it("is negative when the trade is smaller than the median", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 25 }),
      walletHistory: history({ medianTradeUsd: 100 }),
      nowMs: NOW,
    });
    // (25 - 100) / max(1, 100) = -0.75
    expect(f.sizeZScore).toBeCloseTo(-0.75, 9);
    expect(f.sizeZScore).toBeLessThan(0);
  });

  it("falls back to 0 when median is non-positive (no division blow-up)", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 9999 }),
      walletHistory: history({ medianTradeUsd: 0 }),
      nowMs: NOW,
    });
    expect(f.sizeZScore).toBe(0);
    assertNoNaN(f);
  });

  it("is monotonic non-decreasing in trade size for a fixed median", () => {
    const median = 150;
    let prev = -Infinity;
    for (const usd of [0, 50, 150, 300, 1200, 6000]) {
      const f = extractTradeFeatures({
        trade: trade({ usd }),
        walletHistory: history({ medianTradeUsd: median }),
        nowMs: NOW,
      });
      expect(f.sizeZScore).toBeGreaterThanOrEqual(prev);
      prev = f.sizeZScore;
    }
  });

  it("uses max(1, median) as the denominator floor for tiny medians", () => {
    // median = 0.5 → denominator floored to 1, so z = (3 - 0.5)/1 = 2.5
    const f = extractTradeFeatures({
      trade: trade({ usd: 3 }),
      walletHistory: history({ medianTradeUsd: 0.5 }),
      nowMs: NOW,
    });
    expect(f.sizeZScore).toBeCloseTo(2.5, 9);
  });
});

describe("extractTradeFeatures — cadence acceleration", () => {
  it("is zero when there are no recent trades and a positive baseline", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 3, recentTrades: [] }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBe(0);
  });

  it("equals recentInLastHour / baseline exactly", () => {
    // 3 trades within the hour before the trade ts; baseline 2 → factor 1.5
    const recent: TradeForFeatures[] = [10, 25, 50].map((m) => ({
      ...trade(),
      ts: new Date(NOW - m * 60_000).toISOString(),
    }));
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 2, recentTrades: recent }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBeCloseTo(1.5, 9);
  });

  it("excludes recent trades older than one hour from the count", () => {
    // One trade 90 minutes old must NOT count; one 20 minutes old must.
    const recent: TradeForFeatures[] = [
      { ...trade(), ts: new Date(NOW - 90 * 60_000).toISOString() },
      { ...trade(), ts: new Date(NOW - 20 * 60_000).toISOString() },
    ];
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 1, recentTrades: recent }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBeCloseTo(1, 9); // only the 20-min trade counts
  });

  it("is Infinity when baseline is zero but recent trades exist", () => {
    const recent: TradeForFeatures[] = [
      { ...trade(), ts: new Date(NOW - 5 * 60_000).toISOString() },
    ];
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 0, recentTrades: recent }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBe(Infinity);
    // Infinite cadence must NOT produce an "activity surge" driver (guarded by isFinite).
    expect(f.likelyDrivers.some((d) => d.includes("activity surge"))).toBe(false);
    assertNoNaN(f);
  });

  it("is zero when baseline is zero and there are no recent trades", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 0, recentTrades: [] }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBe(0);
  });

  it("ignores recent trades with unparseable timestamps", () => {
    const recent: TradeForFeatures[] = [
      { ...trade(), ts: "not-a-date" },
      { ...trade(), ts: new Date(NOW - 15 * 60_000).toISOString() },
    ];
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history({ tradesPerHourMean: 1, recentTrades: recent }),
      nowMs: NOW,
    });
    expect(f.cadenceAccelerationFactor).toBeCloseTo(1, 9);
    assertNoNaN(f);
  });
});

describe("extractTradeFeatures — peak window & time of day", () => {
  it("hourUtc reflects the trade timestamp's UTC hour", () => {
    const f = extractTradeFeatures({
      trade: trade({ ts: new Date(Date.parse("2026-05-25T09:30:00Z")).toISOString() }),
      walletHistory: history(),
      nowMs: NOW,
    });
    expect(f.hourUtc).toBe(9);
  });

  it("hourUtc defaults to 0 for an unparseable timestamp (no NaN)", () => {
    const f = extractTradeFeatures({
      trade: trade({ ts: "garbage-timestamp" }),
      walletHistory: history({ peakHourUtc: 12 }),
      nowMs: NOW,
    });
    expect(f.hourUtc).toBe(0);
    assertNoNaN(f);
  });

  it("inPeakWindow is true exactly within ±2 hours (circular) and false at distance 3", () => {
    const peak = 14;
    const within = [12, 13, 14, 15, 16]; // distances 2,1,0,1,2
    for (const h of within) {
      const f = extractTradeFeatures({
        trade: trade({ ts: `2026-05-25T${String(h).padStart(2, "0")}:00:00Z` }),
        walletHistory: history({ peakHourUtc: peak }),
        nowMs: NOW,
      });
      expect(f.inPeakWindow).toBe(true);
    }
    // distance 3 → outside the window
    const fOut = extractTradeFeatures({
      trade: trade({ ts: `2026-05-25T11:00:00Z` }),
      walletHistory: history({ peakHourUtc: peak }),
      nowMs: NOW,
    });
    expect(fOut.inPeakWindow).toBe(false);
  });

  it("peak window wraps around midnight (peak 23, trade hour 1 → distance 2)", () => {
    const f = extractTradeFeatures({
      trade: trade({ ts: `2026-05-25T01:00:00Z` }),
      walletHistory: history({ peakHourUtc: 23 }),
      nowMs: NOW,
    });
    expect(f.inPeakWindow).toBe(true);
  });
});

describe("extractTradeFeatures — market dynamics", () => {
  it("returns null move/score fields when no marketContext is supplied", () => {
    const f = extractTradeFeatures({ trade: trade(), walletHistory: history(), nowMs: NOW });
    expect(f.priorPriceMove5minPct).toBeNull();
    expect(f.priorPriceMove30minPct).toBeNull();
    expect(f.withMoveScore).toBeNull();
  });

  it("treats a non-positive past price as missing (null), not a divide-by-zero", () => {
    const ctx = new Map<number, number>([[5, 0], [30, -1]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.5 }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct).toBeNull();
    expect(f.priorPriceMove30minPct).toBeNull();
    expect(f.withMoveScore).toBeNull();
    assertNoNaN(f);
  });

  it("computes the 5-min move percent exactly: (price - past)/past", () => {
    const ctx = new Map<number, number>([[5, 0.4]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.46 }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    // (0.46 - 0.4) / 0.4 = 0.15
    expect(f.priorPriceMove5minPct).toBeCloseTo(0.15, 9);
  });

  it("withMoveScore is 0 when the move magnitude is below the 2% threshold", () => {
    const ctx = new Map<number, number>([[5, 0.5]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.505, side: "BUY" }), // 1% up — below 2% threshold
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct).toBeCloseTo(0.01, 9);
    expect(f.withMoveScore).toBe(0);
  });

  it("withMoveScore is symmetric in side: BUY and SELL on the same up-move have opposite signs", () => {
    const ctx = new Map<number, number>([[5, 0.4]]);
    const fBuy = extractTradeFeatures({
      trade: trade({ price: 0.5, side: "BUY" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    const fSell = extractTradeFeatures({
      trade: trade({ price: 0.5, side: "SELL" }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(fBuy.withMoveScore).toBe(1);
    expect(fSell.withMoveScore).toBe(-1);
    expect(fBuy.withMoveScore! + fSell.withMoveScore!).toBe(0);
  });

  it("a down-move flips alignment: BUY on a down move is against (-1)", () => {
    const ctx = new Map<number, number>([[5, 0.6]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.5, side: "BUY" }), // ~-16.7% down move
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct!).toBeLessThan(0);
    expect(f.withMoveScore).toBe(-1);
  });

  it("the 30-min move uses the 30-min bucket independently of the 5-min bucket", () => {
    const ctx = new Map<number, number>([[5, 0.45], [30, 0.30]]);
    const f = extractTradeFeatures({
      trade: trade({ price: 0.45 }),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: ctx },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct).toBeCloseTo(0, 9); // 0.45 vs 0.45
    expect(f.priorPriceMove30minPct).toBeCloseTo(0.5, 9); // (0.45-0.30)/0.30
  });
});

describe("extractTradeFeatures — cross-wallet passthrough", () => {
  it("defaults cross-wallet counts to zero when crossWallet is omitted", () => {
    const f = extractTradeFeatures({ trade: trade(), walletHistory: history(), nowMs: NOW });
    expect(f.crossWalletAgreement5min).toBe(0);
    expect(f.crossWalletClusters5min).toBe(0);
  });

  it("passes through cross-wallet counts verbatim", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history(),
      crossWallet: { agreementCount5min: 7, clusterCount5min: 4 },
      nowMs: NOW,
    });
    expect(f.crossWalletAgreement5min).toBe(7);
    expect(f.crossWalletClusters5min).toBe(4);
  });

  it("does NOT fire the consensus tail driver below the 3-wallet / 2-cluster threshold", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history(),
      crossWallet: { agreementCount5min: 3, clusterCount5min: 1 }, // clusters < 2
      nowMs: NOW,
    });
    expect(f.likelyDrivers.some((d) => d.includes("cross-wallet consensus tail"))).toBe(false);
  });
});

describe("extractTradeFeatures — empty / minimal context degrades gracefully", () => {
  it("zeroed wallet history and empty trade context still yield valid, NaN-free features", () => {
    const f = extractTradeFeatures({
      trade: trade({ usd: 0, price: 0.5 }),
      walletHistory: {
        medianTradeUsd: 0,
        tradesPerHourMean: 0,
        peakHourUtc: 0,
        recentTrades: [],
      },
      nowMs: NOW,
    });
    expect(f.sizeZScore).toBe(0);
    expect(f.cadenceAccelerationFactor).toBe(0);
    expect(f.crossWalletAgreement5min).toBe(0);
    expect(f.priorPriceMove5minPct).toBeNull();
    expect(f.likelyDrivers.length).toBeGreaterThan(0);
    assertNoNaN(f);
  });

  it("an empty pricesBeforeMin map yields null moves but a valid result", () => {
    const f = extractTradeFeatures({
      trade: trade(),
      walletHistory: history(),
      marketContext: { pricesBeforeMin: new Map<number, number>() },
      nowMs: NOW,
    });
    expect(f.priorPriceMove5minPct).toBeNull();
    expect(f.priorPriceMove30minPct).toBeNull();
    expect(f.withMoveScore).toBeNull();
    expect(f.likelyDrivers.length).toBeGreaterThan(0);
    assertNoNaN(f);
  });
});
