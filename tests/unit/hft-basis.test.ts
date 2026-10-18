import { describe, expect, it } from "vitest";
import { computeBasis } from "@/lib/hft/basis";

describe("computeBasis", () => {
  it("basis = perp − spot, expressed in bps of spot", () => {
    const r = computeBasis({ spot: 2000, perp: 2002, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(r.basis).toBe(2);
    expect(r.basisBps).toBeCloseTo(10, 6);
  });

  it("funding APR derived from hourly rate", () => {
    // 0.0001 (1 bp) per hour → 8760 bp/year = 87.6 % APR
    const r = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0001, fundingHorizonHours: 1 });
    expect(r.fundingBpsHourly).toBeCloseTo(1, 6);
    expect(r.fundingApr).toBeCloseTo(0.876, 3);
  });

  it("Hyperliquid-style 8h funding rescaled to per-hour", () => {
    // 0.0008 over 8h = 0.0001/h
    const r = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0008, fundingHorizonHours: 8 });
    expect(r.fundingBpsHourly).toBeCloseTo(1, 6);
  });

  it("preferred leg flips with basis sign", () => {
    expect(computeBasis({ spot: 2000, perp: 2004, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("long-basis");
    expect(computeBasis({ spot: 2000, perp: 1996, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("short-basis");
    expect(computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("flat");
  });

  it("zero spot doesn't divide by zero", () => {
    const r = computeBasis({ spot: 0, perp: 100, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(r.basisBps).toBe(0);
  });

  it("24h carry scales hourly funding by 24", () => {
    const r = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0001, fundingHorizonHours: 1 });
    expect(r.carry24hBps).toBeCloseTo(24, 6);
  });
});
