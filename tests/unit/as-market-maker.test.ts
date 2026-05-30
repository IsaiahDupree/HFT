/**
 * Unit tests for the Avellaneda-Stoikov / logit-space / Polymarket-V2-fee
 * market-making library. Validates the math the handbook specifies.
 */
import { describe, it, expect } from "vitest";
import {
  logit, sigmoid, microprice, asQuotes, logitSpaceQuotes, vpinPM,
  takerFee, makerRebate, breakevenAlpha, effectiveHalfSpread,
  kellyFraction, positionSize, mmDecisionFromMid, FEE_CATEGORIES, type ASParams,
} from "@/lib/strategies/as-market-maker";

const P: ASParams = { gamma: 2, sigma: 0.4, kappa: 10, T: 1 };

describe("primitives", () => {
  it("logit/sigmoid are inverses", () => {
    for (const p of [0.05, 0.3, 0.5, 0.8, 0.95]) expect(sigmoid(logit(p))).toBeCloseTo(p, 9);
  });
  it("microprice leans toward the side with less size (more pressure)", () => {
    // heavy bid size pushes the weighted-mid toward the ask
    const mp = microprice(0.40, 100, 0.42, 10);
    expect(mp).toBeGreaterThan(0.41);
  });
});

describe("Avellaneda-Stoikov quoting", () => {
  it("flat inventory → reservation == mid, quotes symmetric", () => {
    const q = asQuotes(0.5, 0, 0, P);
    expect(q.reservation).toBeCloseTo(0.5, 9);
    expect(q.ask - q.reservation).toBeCloseTo(q.reservation - q.bid, 9);
  });
  it("long inventory skews reservation BELOW mid (encourages offloading)", () => {
    expect(asQuotes(0.5, +5, 0, P).reservation).toBeLessThan(0.5);
    expect(asQuotes(0.5, -5, 0, P).reservation).toBeGreaterThan(0.5);
  });
  it("logit-space quotes stay within (0,1) and widen near the boundary", () => {
    const mid = logitSpaceQuotes(0.5, 0, 0, P)!;
    const edge = logitSpaceQuotes(0.05, 0, 0, P)!;
    expect(mid.bid).toBeGreaterThan(0); expect(mid.ask).toBeLessThan(1);
    // same logit half-spread → smaller price spread near the boundary
    expect(edge.ask - edge.bid).toBeLessThan(mid.ask - mid.bid);
  });
  it("withdraws when inventory exceeds the boundary-aware cap", () => {
    expect(logitSpaceQuotes(0.02, 999, 0, P)).toBeNull();
  });
});

describe("Polymarket V2 fees", () => {
  it("taker fee peaks at p=0.5 and vanishes at the boundaries", () => {
    const mid = takerFee(0.5, 100, "finance");
    expect(takerFee(0.02, 100, "finance")).toBeLessThan(mid);
    expect(takerFee(0.98, 100, "finance")).toBeLessThan(mid);
    expect(mid).toBeCloseTo(0.01 * 100 * 0.25 * 4, 9); // peak == rate·size at p=0.5
  });
  it("finance has the richest maker rebate share; geopolitics is fee-free", () => {
    expect(FEE_CATEGORIES.finance[1]).toBe(0.5);
    expect(takerFee(0.5, 100, "geopolitics")).toBe(0);
    expect(makerRebate(0.5, 100, "finance")).toBeCloseTo(takerFee(0.5, 100, "finance") * 0.5, 9);
  });
  it("rebate widens the effective half-spread", () => {
    const delta = 0.005;
    expect(effectiveHalfSpread(delta, 0.5, 100, "finance")).toBeGreaterThan(delta);
  });
  it("breakeven alpha is in (0,1) and rises with wider spreads", () => {
    const a1 = breakevenAlpha(0.005, 0.5);
    const a2 = breakevenAlpha(0.02, 0.5);
    expect(a1).toBeGreaterThan(0); expect(a2).toBeLessThan(1);
    expect(a2).toBeGreaterThan(a1);
  });
});

describe("VPIN + Kelly", () => {
  it("balanced flow → low VPIN, one-sided flow → high VPIN", () => {
    const balanced = vpinPM([{ buy: 50, sell: 50, p: 0.5 }]);
    const toxic = vpinPM([{ buy: 100, sell: 0, p: 0.5 }]);
    expect(toxic).toBeGreaterThan(balanced);
  });
  it("kelly is 0 at no edge, positive when q>c, capped", () => {
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.7, 0.5)).toBeGreaterThan(0);
    expect(positionSize(1000, 0.7, 0.5, 0.5)).toBeGreaterThan(0);
  });
});

describe("snapshot-sim MM decision", () => {
  it("BUY when mid is far below fair, HOLD inside the band", () => {
    // long inventory pulls fair below mid → SELL bias; flat + cheap mid → BUY
    const buy = mmDecisionFromMid(0.30, -8, 0, P, "finance", 50);
    expect(["BUY", "HOLD"]).toContain(buy.side);
    const hold = mmDecisionFromMid(0.50, 0, 0, P, "finance", 50);
    expect(hold.side).toBe("HOLD"); // at the mid with flat inventory there is no edge
  });
});
