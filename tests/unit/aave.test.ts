import { describe, expect, it } from "vitest";
import {
  baseUnitToUsd,
  getAaveAccountData,
  HF_INFINITY_SENTINEL,
  riskTierFor,
  wadToFloat,
} from "@/lib/onchain/aave";

describe("wadToFloat", () => {
  it("converts integer WAD values", () => {
    expect(wadToFloat(1_500_000_000_000_000_000n)).toBeCloseTo(1.5, 6);
    expect(wadToFloat(0n)).toBe(0);
    expect(wadToFloat(2_000_000_000_000_000_000n)).toBe(2);
  });

  it("returns Infinity for max-uint256 sentinel (no-debt case)", () => {
    expect(wadToFloat(HF_INFINITY_SENTINEL)).toBe(Infinity);
  });

  it("preserves small fractional values", () => {
    // 1.05 WAD
    expect(wadToFloat(1_050_000_000_000_000_000n)).toBeCloseTo(1.05, 6);
  });
});

describe("baseUnitToUsd", () => {
  it("converts 1e8 BASE units to USD", () => {
    expect(baseUnitToUsd(100_000_000n)).toBe(1);
    expect(baseUnitToUsd(50_000_000_000n)).toBe(500);
    expect(baseUnitToUsd(0n)).toBe(0);
  });

  it("preserves cents", () => {
    expect(baseUnitToUsd(123_456n)).toBeCloseTo(0.00123456, 8);
  });
});

describe("riskTierFor", () => {
  it("returns no_position when hasPosition=false", () => {
    expect(riskTierFor(0, false)).toBe("no_position");
    expect(riskTierFor(Infinity, false)).toBe("no_position");
  });

  it("returns healthy at HF>=2.0", () => {
    expect(riskTierFor(2.0, true)).toBe("healthy");
    expect(riskTierFor(5.0, true)).toBe("healthy");
  });

  it("returns healthy on Infinity HF (no debt)", () => {
    expect(riskTierFor(Infinity, true)).toBe("healthy");
  });

  it("returns cautious at 1.5 <= HF < 2.0", () => {
    expect(riskTierFor(1.5, true)).toBe("cautious");
    expect(riskTierFor(1.99, true)).toBe("cautious");
  });

  it("returns risky at 1.1 <= HF < 1.5", () => {
    expect(riskTierFor(1.1, true)).toBe("risky");
    expect(riskTierFor(1.49, true)).toBe("risky");
  });

  it("returns pre_liquidation at 1.0 <= HF < 1.1", () => {
    expect(riskTierFor(1.0, true)).toBe("pre_liquidation");
    expect(riskTierFor(1.09, true)).toBe("pre_liquidation");
  });

  it("returns liquidatable at HF < 1.0", () => {
    expect(riskTierFor(0.99, true)).toBe("liquidatable");
    expect(riskTierFor(0.5, true)).toBe("liquidatable");
  });
});

describe("getAaveAccountData", () => {
  it("decodes Pool.getUserAccountData output correctly", async () => {
    const fakeClient = {
      async readContract() {
        // Stubbed Aave response: 50000 USD collateral, 20000 USD debt,
        // 5000 USD avail borrow, 8000 bps liq threshold, 7500 bps ltv, HF=2.0
        return [
          5_000_000_000_000n, // 50000 * 1e8
          2_000_000_000_000n, // 20000 * 1e8
            500_000_000_000n, // 5000 * 1e8
          8000n,
          7500n,
          2_000_000_000_000_000_000n, // HF=2.0 in WAD
        ] as const;
      },
    };
    const r = await getAaveAccountData(fakeClient as any, "0x0000000000000000000000000000000000000001");
    expect(r.totalCollateralUsd).toBe(50_000);
    expect(r.totalDebtUsd).toBe(20_000);
    expect(r.availableBorrowsUsd).toBe(5_000);
    expect(r.currentLiquidationThresholdBps).toBe(8000);
    expect(r.ltvBps).toBe(7500);
    expect(r.healthFactor).toBeCloseTo(2.0, 6);
    expect(r.riskTier).toBe("healthy");
  });

  it("returns no_position when collateral + debt are both zero", async () => {
    const fakeClient = {
      async readContract() {
        return [0n, 0n, 0n, 0n, 0n, HF_INFINITY_SENTINEL] as const;
      },
    };
    const r = await getAaveAccountData(fakeClient as any, "0x0000000000000000000000000000000000000002");
    expect(r.riskTier).toBe("no_position");
    expect(r.totalCollateralUsd).toBe(0);
    expect(r.totalDebtUsd).toBe(0);
    expect(r.healthFactor).toBe(Infinity);
  });

  it("classifies a pre-liquidation position", async () => {
    const fakeClient = {
      async readContract() {
        return [
          1_000_000_000_000n, // 10000 USD collateral
          900_000_000_000n,   // 9000 USD debt
          0n,
          8500n, // 85% liq threshold
          8000n,
          // HF = 10000 * 0.85 / 9000 = 0.944 in WAD ~ 944... but realistic value:
          1_050_000_000_000_000_000n, // HF=1.05
        ] as const;
      },
    };
    const r = await getAaveAccountData(fakeClient as any, "0x0000000000000000000000000000000000000003");
    expect(r.riskTier).toBe("pre_liquidation");
    expect(r.healthFactor).toBeCloseTo(1.05, 4);
  });
});
