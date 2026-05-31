/**
 * Tests for the oracle/spot agreement math (PRD-04 #2): the symmetric agreement
 * score, the side-straddle check, the combined gate, and the staleness zones.
 * Pure functions — no network.
 */
import { describe, expect, it } from "vitest";
import {
  exchangeAgreementScore,
  sourcesAgreeSide,
  oracleAgreement,
  stalenessZone,
} from "@/lib/oracle/agreement";

describe("exchangeAgreementScore", () => {
  it("is high when sources agree tightly", () => {
    expect(exchangeAgreementScore([67000, 67010, 67005])).toBeGreaterThan(0.9);
  });

  it("is 0 when the spread reaches maxDisagreement", () => {
    expect(exchangeAgreementScore([67000, 67670], 0.005)).toBe(0); // ~1% > 0.5%
  });

  it("needs ≥2 valid sources (fail closed)", () => {
    expect(exchangeAgreementScore([67000])).toBe(0);
    expect(exchangeAgreementScore([])).toBe(0);
    expect(exchangeAgreementScore([67000, null, 0, -5])).toBe(0);
  });

  it("≈0.75 at 0.125% spread (the threshold point)", () => {
    expect(exchangeAgreementScore([67000, 67000 * 1.00125], 0.005)).toBeCloseTo(0.75, 2);
  });
});

describe("sourcesAgreeSide", () => {
  it("true when all above the target", () => {
    expect(sourcesAgreeSide([67100, 67050, 67080], 67000)).toBe(true);
  });
  it("false when straddling the target", () => {
    expect(sourcesAgreeSide([67100, 66900], 67000)).toBe(false);
  });
  it("true (N/A) with no target", () => {
    expect(sourcesAgreeSide([67100, 66900], null)).toBe(true);
  });
});

describe("oracleAgreement", () => {
  it("agrees when tight and same-side", () => {
    const a = oracleAgreement(
      { coinbase: 67010, okx: 67005, coindesk: 67000, chainlink: 67008 },
      { priceToBeat: 66000 },
    );
    expect(a.agree).toBe(true);
    expect(a.nSources).toBe(4);
    expect(a.score).toBeGreaterThan(0.75);
  });

  it("disagrees on a straddle even if tight", () => {
    const a = oracleAgreement({ coinbase: 67001, okx: 66999 }, { priceToBeat: 67000 });
    expect(a.sideAgree).toBe(false);
    expect(a.agree).toBe(false);
  });

  it("disagrees on a wide spread", () => {
    const a = oracleAgreement({ coinbase: 67000, okx: 68000 }, { priceToBeat: 60000 });
    expect(a.agree).toBe(false);
  });

  it("drops null / non-positive sources", () => {
    const a = oracleAgreement({ coinbase: 67000, okx: null, coindesk: 0, chainlink: undefined });
    expect(a.nSources).toBe(1);
  });
});

describe("stalenessZone", () => {
  it("classifies fresh / aging / stale vs the heartbeat", () => {
    expect(stalenessZone(10, 27)).toBe("fresh");
    expect(stalenessZone(30, 27)).toBe("aging");
    expect(stalenessZone(60, 27, 1.5)).toBe("stale");
  });
});
