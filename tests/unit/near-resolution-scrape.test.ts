import { describe, expect, it } from "vitest";
import { detectNearResolutionScrape, type ScrapeMarket } from "@/lib/strategies/near-resolution-scrape";

const NOW = Date.parse("2026-05-26T00:00:00Z");
const IN_14_DAYS = new Date(NOW + 14 * 86_400_000).toISOString();
const IN_2_DAYS = new Date(NOW + 2 * 86_400_000).toISOString();
const IN_HOURS = new Date(NOW + 6 * 3_600_000).toISOString();
const IN_60_DAYS = new Date(NOW + 60 * 86_400_000).toISOString();

function mkt(overrides: Partial<ScrapeMarket> = {}): ScrapeMarket {
  return {
    conditionId: "0xcond1",
    title: "Will BTC reach $90K in May?",
    endDate: IN_14_DAYS,
    bestAskYes: 0.03,
    bestAskNo: 0.97,
    liquidityUsd: 10_000,
    ...overrides,
  };
}

describe("detectNearResolutionScrape", () => {
  it("returns the NO-side opportunity when NO is winning at 0.97", () => {
    const op = detectNearResolutionScrape(mkt(), { nowMs: NOW });
    expect(op).not.toBeNull();
    expect(op!.side).toBe("NO");
    expect(op!.entryPrice).toBe(0.97);
    expect(op!.edge).toBeCloseTo(0.03 - 0.002, 4); // 0.03 - 20bps fee
    expect(op!.daysToResolution).toBeCloseTo(14, 1);
  });

  it("returns the YES-side opportunity when YES is winning at 0.96", () => {
    const op = detectNearResolutionScrape(mkt({ bestAskYes: 0.96, bestAskNo: 0.04 }), { nowMs: NOW });
    expect(op).not.toBeNull();
    expect(op!.side).toBe("YES");
    expect(op!.entryPrice).toBe(0.96);
  });

  it("returns null when winning side is below minPrice", () => {
    const op = detectNearResolutionScrape(mkt({ bestAskYes: 0.7, bestAskNo: 0.3 }), { nowMs: NOW });
    expect(op).toBeNull();
  });

  it("returns null when market resolves too soon", () => {
    const op = detectNearResolutionScrape(mkt({ endDate: IN_HOURS }), {
      nowMs: NOW,
      minDaysToResolution: 1,
    });
    expect(op).toBeNull();
  });

  it("returns null when market resolves too far in the future", () => {
    const op = detectNearResolutionScrape(mkt({ endDate: IN_60_DAYS }), {
      nowMs: NOW,
      maxDaysToResolution: 30,
    });
    expect(op).toBeNull();
  });

  it("returns null on invalid endDate", () => {
    const op = detectNearResolutionScrape(mkt({ endDate: "not-a-date" }), { nowMs: NOW });
    expect(op).toBeNull();
  });

  it("returns null on zero prices", () => {
    expect(detectNearResolutionScrape(mkt({ bestAskYes: 0, bestAskNo: 0 }), { nowMs: NOW })).toBeNull();
  });

  it("returns null when price >= 1 (already resolved)", () => {
    expect(
      detectNearResolutionScrape(mkt({ bestAskYes: 0.001, bestAskNo: 1.0 }), { nowMs: NOW }),
    ).toBeNull();
  });

  it("computes annualizedEdge correctly", () => {
    // 14d to resolution, entry 0.97, edge 0.028 after 20bps fee
    // annualized = (0.028 / 0.97) * (365 / 14) ≈ 0.753 ≈ 75.3%
    const op = detectNearResolutionScrape(mkt(), { nowMs: NOW });
    expect(op!.annualizedEdge).toBeGreaterThan(0.7);
    expect(op!.annualizedEdge).toBeLessThan(0.8);
  });

  it("shorter window = higher annualized edge for same entry price", () => {
    const longWindow = detectNearResolutionScrape(mkt({ endDate: IN_14_DAYS }), { nowMs: NOW });
    const shortWindow = detectNearResolutionScrape(mkt({ endDate: IN_2_DAYS }), { nowMs: NOW });
    expect(shortWindow!.annualizedEdge).toBeGreaterThan(longWindow!.annualizedEdge * 2);
  });

  it("returns null when fee wipes out the edge", () => {
    // entry 0.999, fee 100bps → gross edge 0.001, fee 0.01 → negative
    const op = detectNearResolutionScrape(mkt({ bestAskNo: 0.999 }), { nowMs: NOW, feeBps: 100 });
    expect(op).toBeNull();
  });

  it("custom minPrice = 0.99 filters out 0.97 markets", () => {
    const op = detectNearResolutionScrape(mkt(), { nowMs: NOW, minPrice: 0.99 });
    expect(op).toBeNull();
  });

  it("liquidityUsd surfaces in the opportunity for downstream sizing", () => {
    const op = detectNearResolutionScrape(mkt({ liquidityUsd: 250_000 }), { nowMs: NOW });
    expect(op!.liquidityUsd).toBe(250_000);
  });
});
