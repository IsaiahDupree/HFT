import { describe, expect, it } from "vitest";
import { fingerprintWallet, type RawTrade } from "@/lib/wallets/fingerprint";

function tradeAt(
  isoOrEpoch: string | number,
  overrides: Partial<RawTrade> = {},
): RawTrade {
  const ts = typeof isoOrEpoch === "string" ? Date.parse(isoOrEpoch) / 1000 : isoOrEpoch;
  return {
    side: "BUY",
    price: 0.5,
    size: 100,
    usdcSize: 50,
    timestamp: ts,
    eventSlug: "btc-up-or-down-hourly",
    title: "Bitcoin Up or Down — 5 min",
    outcome: "Up",
    ...overrides,
  };
}

describe("fingerprintWallet — empty + small samples", () => {
  it("returns low_signal on an empty wallet", () => {
    const fp = fingerprintWallet({ trades: [] });
    expect(fp.strategyFamily).toBe("low_signal");
    expect(fp.sampledTrades).toBe(0);
    expect(fp.caveats[0]).toMatch(/small sample/);
  });

  it("flags small-sample even for non-empty <50 trades", () => {
    const fp = fingerprintWallet({
      trades: Array.from({ length: 10 }, (_, i) => tradeAt(`2026-05-25T00:0${i}:00Z`)),
    });
    expect(fp.strategyFamily).toBe("low_signal");
    expect(fp.caveats.some((c) => c.includes("small sample"))).toBe(true);
  });
});

describe("fingerprintWallet — latency_arb signature", () => {
  it("classifies high-cadence crypto-only as latency_arb", () => {
    // 200 trades over ~3 hours, all crypto, tight intervals
    const trades = Array.from({ length: 200 }, (_, i) =>
      tradeAt(`2026-05-25T00:00:00Z` /* base */, {
        timestamp: Date.parse("2026-05-25T00:00:00Z") / 1000 + i * 30, // every 30s
        eventSlug: "btc-up-or-down-hourly",
        title: "BTC Up/Down 5min",
      }),
    );
    const fp = fingerprintWallet({ trades });
    expect(fp.cryptoPct).toBeGreaterThan(0.9);
    expect(fp.tradesPerHourMean).toBeGreaterThan(50);
    expect(fp.interTradeMedianSec).toBeLessThan(60);
    expect(fp.cadenceBotScore).toBeGreaterThan(0.7);
    expect(fp.strategyFamily).toBe("latency_arb");
  });
});

describe("fingerprintWallet — correlated_basket signature", () => {
  it("detects the @0xb55fa... pattern: multiple crypto assets in same direction same window", () => {
    // 4 cohorts × 4 assets × ~14 trades each (above 50 to clear low_signal)
    const trades: RawTrade[] = [];
    const baseHour = Date.parse("2026-05-09T00:00:00Z") / 1000;
    for (let cohort = 0; cohort < 4; cohort++) {
      const cohortBase = baseHour + cohort * 3600;
      for (const asset of ["btc", "eth", "sol", "xrp"]) {
        for (let i = 0; i < 4; i++) {
          trades.push(tradeAt(0, {
            timestamp: cohortBase + i * 60,
            eventSlug: `${asset}-up-or-down-hourly`,
            title: `${asset.toUpperCase()} Up or Down`,
            outcome: "Down",
          }));
        }
      }
    }
    const fp = fingerprintWallet({ trades });
    expect(fp.cryptoPct).toBeCloseTo(1.0, 1);
    expect(fp.correlatedBasketCohorts).toBeGreaterThanOrEqual(3);
    expect(fp.strategyFamily).toBe("correlated_basket");
    // Examples reference the right assets
    expect(fp.correlatedBasketExamples[0].assets.length).toBeGreaterThanOrEqual(3);
    expect(["BUY", "SELL", "UP", "DOWN"]).toContain(fp.correlatedBasketExamples[0].side);
  });
});

describe("fingerprintWallet — market_making signature", () => {
  it("classifies high-cadence near-midpoint entries on non-crypto as market_making", () => {
    const trades = Array.from({ length: 150 }, (_, i) =>
      tradeAt(0, {
        timestamp: Date.parse("2026-05-25T00:00:00Z") / 1000 + i * 30,
        eventSlug: "election-2028-winner",
        title: "Election 2028",
        outcome: "Yes",
        price: 0.49 + (i % 5) * 0.005, // 0.49 .. 0.51
      }),
    );
    const fp = fingerprintWallet({ trades });
    expect(fp.midpointEntryPct).toBeGreaterThan(0.6);
    expect(fp.strategyFamily).toBe("market_making");
  });
});

describe("fingerprintWallet — longshot_hunter signature", () => {
  it("classifies tail-heavy entries as longshot_hunter", () => {
    const trades = Array.from({ length: 100 }, (_, i) =>
      tradeAt(0, {
        timestamp: Date.parse("2026-05-25T00:00:00Z") / 1000 + i * 300,
        eventSlug: "obscure-political-bet",
        title: "Obscure Bet",
        outcome: "Yes",
        price: i % 2 === 0 ? 0.05 : 0.95,
      }),
    );
    const fp = fingerprintWallet({ trades });
    expect(fp.tailEntryPct).toBeGreaterThan(0.5);
    expect(fp.strategyFamily).toBe("longshot_hunter");
  });
});

describe("fingerprintWallet — realized PnL from closed positions", () => {
  it("computes realizedPnlUsd and winRate when closed positions are provided", () => {
    const trades = Array.from({ length: 60 }, (_, i) => tradeAt(`2026-05-25T00:0${i % 10}:00Z`));
    const closed = [
      { cashPnl: 100 }, { cashPnl: -50 }, { cashPnl: 25 }, { cashPnl: -10 }, { cashPnl: 75 },
    ];
    const fp = fingerprintWallet({ trades, closedPositions: closed });
    expect(fp.realizedPnlUsd).toBe(140);
    expect(fp.winRate).toBeCloseTo(0.6, 5);
    expect(fp.sampledClosedPositions).toBe(5);
  });
});

describe("fingerprintWallet — time-of-day", () => {
  it("identifies the peak UTC hour and concentration", () => {
    // 60 trades, mostly at hour 14 (UTC)
    const trades: RawTrade[] = [];
    for (let i = 0; i < 50; i++) {
      trades.push(tradeAt(`2026-05-${(i % 28) + 1 < 10 ? "0" : ""}${(i % 28) + 1}T14:30:00Z`));
    }
    for (let i = 0; i < 10; i++) {
      trades.push(tradeAt(`2026-05-25T03:00:00Z`));
    }
    const fp = fingerprintWallet({ trades });
    expect(fp.peakHourUtc).toBe(14);
    expect(fp.peakHourConcentrationPct).toBeGreaterThan(0.6);
  });
});
