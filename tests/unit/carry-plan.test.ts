import { describe, it, expect } from "vitest";
import { planCarryLegs, bookSafetyCheck, DEFAULT_LIMITS, type CarryOpp } from "@/lib/exec/carry-plan";

const opp = (over: Partial<CarryOpp> = {}): CarryOpp => ({ coin: "LAB", fundingApr: 60, persistence: 0.9, perpVenue: "hyperliquid", spotVenues: ["coinbase"], ...over });

describe("planCarryLegs — the two-leg carry trade", () => {
  it("positive funding → SHORT perp + LONG spot (no borrow), delta-neutral, notional-matched", () => {
    const p = planCarryLegs(opp({ fundingApr: 60 }), 1000);
    expect(p.perpLeg.positionSide).toBe("short");
    expect(p.perpLeg.action).toBe("sell");
    expect(p.spotLeg!.positionSide).toBe("long");
    expect(p.spotLeg!.action).toBe("buy");
    expect(p.perpLeg.notionalUsd).toBe(p.spotLeg!.notionalUsd); // matched
    expect(p.deltaNeutral).toBe(true);
    expect(p.blockers).toEqual([]);
  });

  it("computes net carry after the amortized round-trip fee", () => {
    const p = planCarryLegs(opp({ fundingApr: 73 }), 1000, { ...DEFAULT_LIMITS, feeBpsPerSide: 5, holdDays: 14 });
    // gross 73/365*100 = 20 bp/day; fee drag = 10/14 = 0.71 bp/day → net ~19.3
    expect(p.expectedDailyCarryBp).toBeCloseTo(73 / 365 * 100 - 10 / 14, 1);
    expect(p.expectedAprNet).toBeGreaterThan(60);
  });

  it("BLOCKS transient funding (persistence below the floor)", () => {
    const p = planCarryLegs(opp({ persistence: 0.56 }), 1000);
    expect(p.blockers.some((b) => /transient|persistence/.test(b))).toBe(true);
  });

  it("BLOCKS an unhedgeable coin (no spot venue) rather than running naked", () => {
    const p = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000);
    expect(p.spotLeg).toBeNull();
    expect(p.deltaNeutral).toBe(false);
    expect(p.blockers.some((b) => /cannot hedge|NAKED/.test(b))).toBe(true);
  });

  it("allowUnhedged override clears the naked blocker (operator opt-in)", () => {
    const p = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000, { ...DEFAULT_LIMITS, allowUnhedged: true });
    expect(p.blockers.some((b) => /NAKED/.test(b))).toBe(false);
  });

  it("negative funding (long-perp/short-spot) is blocked by default (needs spot borrow)", () => {
    const p = planCarryLegs(opp({ fundingApr: -50 }), 1000);
    expect(p.perpLeg.positionSide).toBe("long");
    expect(p.spotLeg!.positionSide).toBe("short");
    expect(p.blockers.some((b) => /BORROW/.test(b))).toBe(true);
  });

  it("BLOCKS an uneconomic (after-fee) carry", () => {
    const p = planCarryLegs(opp({ fundingApr: 8 }), 1000, { ...DEFAULT_LIMITS, minNetApr: 15 });
    expect(p.blockers.some((b) => /uneconomic|net /.test(b))).toBe(true);
  });

  it("caps notional at the per-name limit", () => {
    const p = planCarryLegs(opp(), 999999, { ...DEFAULT_LIMITS, maxNotionalPerName: 1000 });
    expect(p.perpLeg.notionalUsd).toBe(1000);
  });
});

describe("bookSafetyCheck", () => {
  it("only counts executable (no-blocker) plans and flags the book cap", () => {
    const good = planCarryLegs(opp({ coin: "LAB" }), 1000);
    const bad = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000); // unhedgeable → blocked
    const { executable, totalNotional, bookBlockers } = bookSafetyCheck([good, bad], { ...DEFAULT_LIMITS, maxTotalNotional: 5000 });
    expect(executable).toHaveLength(1);
    expect(totalNotional).toBe(1000);
    expect(bookBlockers).toEqual([]);
  });
  it("flags when total notional exceeds the book cap", () => {
    const plans = ["A", "B", "C"].map((c) => planCarryLegs(opp({ coin: c }), 1000));
    const { bookBlockers } = bookSafetyCheck(plans, { ...DEFAULT_LIMITS, maxTotalNotional: 2500 });
    expect(bookBlockers.some((b) => /book notional/.test(b))).toBe(true);
  });
});
