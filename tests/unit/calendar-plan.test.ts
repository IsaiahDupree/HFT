import { describe, it, expect } from "vitest";
import { planCalendarLegs, calendarBookCheck, DEFAULT_CAL_LIMITS, type CalendarOpp } from "@/lib/exec/calendar-plan";

const opp = (over: Partial<CalendarOpp> = {}): CalendarOpp => ({
  coin: "BTC", futureSymbol: "BTC-25SEP26", futurePrice: 61_000, spotPrice: 60_000, dteDays: 60,
  futureOiUsd: 600_000_000, spotVenues: ["coinbase"], ...over,
});

describe("planCalendarLegs — cash-and-carry basis trade", () => {
  it("contango → SHORT future + LONG spot (no borrow), delta-neutral, notional-matched", () => {
    const p = planCalendarLegs(opp({ futurePrice: 61_000, spotPrice: 60_000 }), 1000);
    expect(p.futureLeg.positionSide).toBe("short");
    expect(p.futureLeg.action).toBe("sell");
    expect(p.spotLeg!.positionSide).toBe("long");
    expect(p.spotLeg!.action).toBe("buy");
    expect(p.futureLeg.notionalUsd).toBe(p.spotLeg!.notionalUsd);
    expect(p.deltaNeutral).toBe(true);
    expect(p.blockers).toEqual([]);
  });

  it("annualizes the basis and nets the one-shot round-trip fee over the hold", () => {
    const p = planCalendarLegs(opp({ futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), 1000, { ...DEFAULT_CAL_LIMITS, feeBpsPerSide: 5 });
    // raw basis 3.333%; annualized = 3.333×365/90 = 13.5%; net = (3.333 − 0.20)×365/90 ≈ 12.7%
    expect(p.basisPct).toBeCloseTo(3.333, 2);
    expect(p.annualizedBasisPct).toBeCloseTo(3.333 * 365 / 90, 0);
    expect(p.expectedAprNet).toBeCloseTo((3.333 - 0.2) * 365 / 90, 0);
    expect(p.blockers).toEqual([]);
  });

  it("BLOCKS a near-expiry contract (friction dominates the residual basis)", () => {
    const p = planCalendarLegs(opp({ dteDays: 3 }), 1000);
    expect(p.blockers.some((b) => /near|friction|expiry/.test(b))).toBe(true);
  });

  it("BLOCKS a contract too far out (capital locked too long)", () => {
    const p = planCalendarLegs(opp({ dteDays: 400 }), 1000, { ...DEFAULT_CAL_LIMITS, maxDteDays: 365 });
    expect(p.blockers.some((b) => /locked too long|> 365d/.test(b))).toBe(true);
  });

  it("BLOCKS an uneconomic (after-fee) thin basis", () => {
    const p = planCalendarLegs(opp({ futurePrice: 60_100, spotPrice: 60_000, dteDays: 30 }), 1000);
    expect(p.blockers.some((b) => /uneconomic|net /.test(b))).toBe(true);
  });

  it("backwardation → LONG future + SHORT spot, blocked by default (needs borrow)", () => {
    const p = planCalendarLegs(opp({ futurePrice: 59_000, spotPrice: 60_000 }), 1000);
    expect(p.futureLeg.positionSide).toBe("long");
    expect(p.spotLeg!.positionSide).toBe("short");
    expect(p.blockers.some((b) => /BORROW/.test(b))).toBe(true);
  });

  it("BLOCKS an illiquid future (OI below floor)", () => {
    const p = planCalendarLegs(opp({ futureOiUsd: 1_000_000 }), 1000, { ...DEFAULT_CAL_LIMITS, minFutureOiUsd: 5_000_000 });
    expect(p.blockers.some((b) => /OI .*too illiquid/.test(b))).toBe(true);
  });

  it("BLOCKS an unhedgeable coin; allowUnhedged clears the naked blocker", () => {
    const naked = planCalendarLegs(opp({ coin: "XYZ", spotVenues: [] }), 1000);
    expect(naked.spotLeg).toBeNull();
    expect(naked.blockers.some((b) => /cannot hedge|NAKED/.test(b))).toBe(true);
    const over = planCalendarLegs(opp({ coin: "XYZ", spotVenues: [] }), 1000, { ...DEFAULT_CAL_LIMITS, allowUnhedged: true });
    expect(over.blockers.some((b) => /NAKED/.test(b))).toBe(false);
  });

  it("caps notional at the per-name limit", () => {
    const p = planCalendarLegs(opp(), 999_999, { ...DEFAULT_CAL_LIMITS, maxNotionalPerName: 1000 });
    expect(p.futureLeg.notionalUsd).toBe(1000);
  });
});

describe("calendarBookCheck", () => {
  it("only counts executable plans and flags the book cap", () => {
    const good = planCalendarLegs(opp({ coin: "BTC", futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), 1000);
    const bad = planCalendarLegs(opp({ coin: "XYZ", spotVenues: [] }), 1000); // unhedgeable
    const { executable, totalNotional, bookBlockers } = calendarBookCheck([good, bad], { ...DEFAULT_CAL_LIMITS, maxTotalNotional: 5000 });
    expect(executable).toHaveLength(1);
    expect(totalNotional).toBe(1000);
    expect(bookBlockers).toEqual([]);
  });

  it("flags when total notional exceeds the book cap", () => {
    const plans = ["BTC", "ETH", "SOL"].map((c) => planCalendarLegs(opp({ coin: c, futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), 1000));
    const { bookBlockers } = calendarBookCheck(plans, { ...DEFAULT_CAL_LIMITS, maxTotalNotional: 2500 });
    expect(bookBlockers.some((b) => /book notional/.test(b))).toBe(true);
  });
});
