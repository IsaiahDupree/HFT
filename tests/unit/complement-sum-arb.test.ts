/**
 * Tests for the complement-sum arbitrage detector (Phase 12).
 *
 * Covers:
 *   - Happy path: profitable arb with depth
 *   - Threshold gates (combined cost > max, profit < min, time < min hold)
 *   - Depth constraints (insufficient depth → max_pairs = 0 → null)
 *   - Fee adjustments wiping out gross profit
 *   - Invalid prices (≤0, ≥1, NaN)
 *   - Edge: combined exactly at threshold; profit exactly at floor
 */
import { describe, expect, it } from "vitest";
import {
  detectComplementSumArb,
  type BinaryBookSnapshot,
} from "@/lib/strategies/complement-sum-arb";

const NOW = Date.parse("2026-05-28T12:00:00Z");
const HOUR_FROM_NOW = NOW + 60 * 60_000;

function snap(over: Partial<BinaryBookSnapshot> = {}): BinaryBookSnapshot {
  return {
    conditionId: "0xCOND",
    title: "BTC Up vs Down 5m",
    asset: "BTC",
    windowCloseMs: HOUR_FROM_NOW,
    nowMs: NOW,
    upBestAsk: 0.48,
    downBestAsk: 0.48,
    upDepthUsd: 100,
    downDepthUsd: 100,
    feeBps: 20,
    ...over,
  };
}

describe("detectComplementSumArb — happy path", () => {
  it("returns opportunity when combined cost below threshold + adequate depth", () => {
    const op = detectComplementSumArb(snap());
    expect(op).not.toBeNull();
    expect(op!.combined_cost).toBeCloseTo(0.96, 6);
    expect(op!.gross_profit_per_pair).toBeCloseTo(0.04, 6);
    expect(op!.net_profit_per_pair).toBeCloseTo(0.038, 6); // 0.04 - 0.002 fee
    expect(op!.max_pairs).toBeGreaterThan(0);
    expect(op!.capital_required_usd).toBeGreaterThan(0);
    expect(op!.total_profit_usd).toBeCloseTo(op!.max_pairs * op!.net_profit_per_pair, 4);
    expect(op!.roi).toBeGreaterThan(0);
  });

  it("computes ROI correctly", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.48, downBestAsk: 0.48 }))!;
    // combined 0.96; net profit 0.038; roi 0.038 / 0.96 ≈ 0.0396
    expect(op.roi).toBeCloseTo(0.038 / 0.96, 4);
  });

  it("reason mentions asset + cents + pairs", () => {
    const op = detectComplementSumArb(snap())!;
    expect(op.reason).toMatch(/BTC/);
    expect(op.reason).toMatch(/¢/);
    expect(op.reason).toMatch(/pairs/);
  });
});

describe("detectComplementSumArb — threshold gates", () => {
  it("rejects when combined cost > maxCombinedCost", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: 0.50, downBestAsk: 0.50 }))).toBeNull(); // 1.00
    expect(detectComplementSumArb(snap({ upBestAsk: 0.49, downBestAsk: 0.49 }))).toBeNull(); // 0.98 > 0.97 default
  });

  it("accepts combined exactly at threshold 0.97", () => {
    // 0.485 × 2 = 0.97 → gross 0.03 → net 0.028 (≥ 0.02 min profit)
    const op = detectComplementSumArb(snap({ upBestAsk: 0.485, downBestAsk: 0.485 }));
    expect(op).not.toBeNull();
  });

  it("rejects when net profit below minProfitPerPair", () => {
    // combined 0.96, gross 0.04, fee 350bps → net -0.005 → 0 net profit
    expect(detectComplementSumArb(snap(), { feeBps: 350 })).toBeNull();
  });

  it("rejects when time-to-resolve below minHoldMinutes", () => {
    // 30 seconds remaining < 1 min default
    const op = detectComplementSumArb(snap({ windowCloseMs: NOW + 30_000 }));
    expect(op).toBeNull();
  });

  it("respects custom thresholds", () => {
    // With tighter maxCombinedCost=0.95, the default 0.96 case is rejected
    expect(detectComplementSumArb(snap(), { maxCombinedCost: 0.95 })).toBeNull();
    // But pass with lower combined
    expect(detectComplementSumArb(snap({ upBestAsk: 0.47, downBestAsk: 0.47 }), { maxCombinedCost: 0.95 })).not.toBeNull();
  });
});

describe("detectComplementSumArb — depth constraints", () => {
  it("max_pairs floored by shallowest side", () => {
    const op = detectComplementSumArb(snap({ upDepthUsd: 50, downDepthUsd: 200 }));
    expect(op).not.toBeNull();
    // 50 / 0.48 ≈ 104 max pairs from up-side depth
    expect(op!.max_pairs).toBeLessThanOrEqual(Math.floor(50 / 0.48));
  });

  it("returns null when depth too thin for even 1 pair", () => {
    // Depth 0.40 on each side, can't fit even one share at 0.48
    const op = detectComplementSumArb(snap({ upDepthUsd: 0.40, downDepthUsd: 0.40 }));
    expect(op).toBeNull();
  });

  it("returns null on zero depth", () => {
    expect(detectComplementSumArb(snap({ upDepthUsd: 0 }))).toBeNull();
    expect(detectComplementSumArb(snap({ downDepthUsd: 0 }))).toBeNull();
  });
});

describe("detectComplementSumArb — fees", () => {
  it("fee adjustment is fee_bps / 10000 per pair", () => {
    const op = detectComplementSumArb(snap(), { feeBps: 100 })!;
    expect(op.fee_adjustment).toBeCloseTo(0.01, 6);
    // net = gross - fee_adj = 0.04 - 0.01 = 0.03
    expect(op.net_profit_per_pair).toBeCloseTo(0.03, 6);
  });

  it("higher fees reduce ROI proportionally", () => {
    const cheap = detectComplementSumArb(snap(), { feeBps: 0 })!;
    const expensive = detectComplementSumArb(snap(), { feeBps: 100 })!;
    expect(cheap.net_profit_per_pair).toBeGreaterThan(expensive.net_profit_per_pair);
    expect(cheap.roi).toBeGreaterThan(expensive.roi);
  });
});

describe("detectComplementSumArb — invalid input", () => {
  it("returns null on NaN prices", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: NaN }))).toBeNull();
    expect(detectComplementSumArb(snap({ downBestAsk: NaN }))).toBeNull();
  });

  it("returns null on price ≤ 0", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: 0 }))).toBeNull();
    expect(detectComplementSumArb(snap({ downBestAsk: -0.01 }))).toBeNull();
  });

  it("returns null on price ≥ 1 (resolved or malformed)", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: 1.0 }))).toBeNull();
    expect(detectComplementSumArb(snap({ downBestAsk: 1.01 }))).toBeNull();
  });

  it("returns null when windowCloseMs ≤ nowMs (already resolved)", () => {
    expect(detectComplementSumArb(snap({ windowCloseMs: NOW - 1 }))).toBeNull();
    expect(detectComplementSumArb(snap({ windowCloseMs: NOW }))).toBeNull();
  });

  it("returns null on NaN depths", () => {
    expect(detectComplementSumArb(snap({ upDepthUsd: NaN }))).toBeNull();
  });
});
