import { describe, expect, it } from "vitest";
import { computeLeverageAdvice } from "@/lib/onchain/aave-advisor";
import type { AaveAccountData } from "@/lib/onchain/aave";

function pos(overrides: Partial<AaveAccountData> = {}): AaveAccountData {
  return {
    wallet: "0xabc",
    totalCollateralUsd: 10_000,
    totalDebtUsd: 4_000,
    availableBorrowsUsd: 4_000,
    currentLiquidationThresholdBps: 8000, // 80%
    ltvBps: 7500,
    healthFactor: 2.0,
    riskTier: "healthy",
    ...overrides,
  };
}

describe("computeLeverageAdvice", () => {
  it("recommends 'hold' / amount 0 on no_position", () => {
    const data = pos({
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      healthFactor: Infinity,
      riskTier: "no_position",
    });
    const a = computeLeverageAdvice(data);
    expect(a.recommendation.action).toBe("hold");
    expect(a.recommendation.amountUsd).toBe(0);
    expect(a.recommendation.reason).toContain("no Aave position");
  });

  it("recommends 'borrow_more' when HF >= target with headroom", () => {
    // Collateral 10k, debt 1k, liq threshold 80%, HF target 1.5
    // Max debt at HF=1.5: (10000 * 0.8) / 1.5 = 5333.33
    // Headroom = 5333.33 - 1000 = 4333.33
    const a = computeLeverageAdvice(
      pos({ totalDebtUsd: 1_000, healthFactor: 8.0 }),
      { targetHealthFactor: 1.5 },
    );
    expect(a.recommendation.action).toBe("borrow_more");
    expect(a.recommendation.amountUsd).toBeGreaterThan(4_000);
    expect(a.recommendation.amountUsd).toBeLessThan(4_500);
    expect(a.target.maxDebtUsd).toBeCloseTo(5333.33, 1);
  });

  it("recommends 'hold' when HF >= target but headroom < min delta", () => {
    // Custom min delta of $1000; collateral 10k debt 5000 → headroom ~333
    const a = computeLeverageAdvice(
      pos({ totalDebtUsd: 5_000, healthFactor: 1.6 }),
      { targetHealthFactor: 1.5, minBorrowDeltaUsd: 1000 },
    );
    expect(a.recommendation.action).toBe("hold");
  });

  it("recommends 'repay_some' when HF below target but above urgent", () => {
    // HF = 1.3 (below 1.5, above 1.1) — should be repay_some
    const a = computeLeverageAdvice(pos({ totalDebtUsd: 6_000, healthFactor: 1.3 }), {
      targetHealthFactor: 1.5,
    });
    expect(a.recommendation.action).toBe("repay_some");
    expect(a.recommendation.amountUsd).toBeGreaterThan(0);
  });

  it("recommends 'repay_urgent' when HF < urgent threshold", () => {
    const a = computeLeverageAdvice(pos({ totalDebtUsd: 8_000, healthFactor: 1.05 }), {
      targetHealthFactor: 1.5,
      urgentHealthFactor: 1.1,
    });
    expect(a.recommendation.action).toBe("repay_urgent");
    expect(a.recommendation.amountUsd).toBeGreaterThan(0);
    expect(a.recommendation.reason).toContain("urgent");
  });

  it("max debt math: HF = collateral × liqThreshold / debt → debt = collateral × liqThreshold / HF", () => {
    // 50k collateral, 80% liq threshold, target HF=2.0 → max debt = 50000*0.8/2 = 20000
    const a = computeLeverageAdvice(
      pos({ totalCollateralUsd: 50_000, totalDebtUsd: 10_000, healthFactor: 4.0 }),
      { targetHealthFactor: 2.0 },
    );
    expect(a.target.maxDebtUsd).toBeCloseTo(20_000, 6);
    expect(a.target.remainingHeadroomUsd).toBeCloseTo(10_000, 6);
  });

  it("always stamps the three caveats", () => {
    const a = computeLeverageAdvice(pos());
    expect(a.caveats.length).toBe(3);
    expect(a.caveats[0]).toContain("read-only");
    expect(a.caveats[1]).toContain("liquidationThreshold");
    expect(a.caveats[2]).toContain("personal use only");
  });

  it("handles zero liquidationThreshold without div-by-zero", () => {
    const a = computeLeverageAdvice(
      pos({ currentLiquidationThresholdBps: 0, totalCollateralUsd: 1000, totalDebtUsd: 0 }),
    );
    expect(a.target.maxDebtUsd).toBe(0);
    expect(a.target.remainingHeadroomUsd).toBe(0);
  });

  it("repay amount never goes negative even with strange inputs", () => {
    // Already at target, recommend hold not negative repay
    const a = computeLeverageAdvice(pos({ totalDebtUsd: 2_000, healthFactor: 5.0 }), {
      targetHealthFactor: 1.5,
      minBorrowDeltaUsd: 10_000_000, // very high to avoid borrow_more
    });
    expect(a.recommendation.amountUsd).toBeGreaterThanOrEqual(0);
  });
});
