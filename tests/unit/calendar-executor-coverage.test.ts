/**
 * calendar-executor-coverage — ADDITIONAL adversarial coverage for planCalendarLegs + calendarBookCheck.
 *
 * Complements tests/unit/calendar-plan.test.ts. Focus areas (per the edge brief):
 *   • fee-amortization monotonicity in DTE   — the one-shot round-trip fee is a FIXED cost; amortized over a
 *                                              longer hold it eats a smaller share of the annualized basis, so for
 *                                              a fixed *annualized (gross)* basis, net APR is monotone-INCREASING
 *                                              in DTE and converges UP toward gross. (For a fixed *raw* basis the
 *                                              per-hold net basis is CONSTANT and net APR ∝ 1/dte — both asserted.)
 *   • near-/far-expiry gates exactly at the boundary (strict <  / strict >, raw value not the display-rounded one)
 *   • backwardation borrow gate + allowSpotBorrow override
 *   • OI floor (strict <, boundary inclusive)
 *   • contango / backwardation SIDE selection (sign correctness)  + the future==spot zero-basis tie
 *   • book cap (calendarBookCheck) boundary + executable filtering
 *   • degenerate inputs (zero/neg spot, dte=0, NaN/undefined fields) handled without throwing/NaN leakage
 *
 * NOTE on "no-lookahead": planCalendarLegs is a PURE per-opportunity transform with no time index — there is no
 * future bar that could leak into a past output. The structural analogue is causal INDEPENDENCE: each plan is a
 * sole function of its own opp+limits, and calendarBookCheck is order-/append-stable (adding a later plan never
 * rewrites an earlier plan's fields). Both are asserted below.
 *
 * Determinism: hand-rolled LCG (same pattern as funding.props.test.ts). fast-check is NOT a dependency here.
 */
import { describe, it, expect } from "vitest";
import { planCalendarLegs, calendarBookCheck, DEFAULT_CAL_LIMITS, type CalendarOpp, type CalendarLimits } from "@/lib/exec/calendar-plan";

// ---- deterministic RNG (Numerical Recipes LCG) — no wall-clock, no platform RNG ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

const opp = (over: Partial<CalendarOpp> = {}): CalendarOpp => ({
  coin: "BTC",
  futureSymbol: "BTC-25SEP26",
  futurePrice: 61_000,
  spotPrice: 60_000,
  dteDays: 60,
  futureOiUsd: 600_000_000,
  spotVenues: ["coinbase"],
  ...over,
});
const lim = (over: Partial<CalendarLimits> = {}): CalendarLimits => ({ ...DEFAULT_CAL_LIMITS, ...over });

// build a future price for a target ANNUALIZED gross basis (%) over `dte` days, given spot
const futForAnnualBasis = (spot: number, annualPct: number, dte: number) => spot * (1 + (annualPct / 100) * (dte / 365));
// build a future price for a target RAW basis (%) given spot
const futForRawBasis = (spot: number, rawPct: number) => spot * (1 + rawPct / 100);

const noBlocker = (b: string[], re: RegExp) => expect(b.some((x) => re.test(x))).toBe(false);
const hasBlocker = (b: string[], re: RegExp) => expect(b.some((x) => re.test(x))).toBe(true);

describe("planCalendarLegs — fee amortization is monotonic in DTE", () => {
  it("for a FIXED ANNUALIZED gross basis, net APR strictly increases with DTE (one-shot fee amortized over more time)", () => {
    const spot = 60_000;
    const annual = 12; // 12% gross annualized basis, held constant across tenors
    const dtes = [10, 20, 40, 80, 160, 320];
    const aprs = dtes.map((dte) =>
      planCalendarLegs(
        opp({ spotPrice: spot, futurePrice: futForAnnualBasis(spot, annual, dte), dteDays: dte }),
        1000,
        lim({ minNetApr: -1e9 }), // disable the economics gate so we can read net APR across all tenors
      ).expectedAprNet,
    );
    // strictly increasing, and always below the gross 12% (fee can only drag down)
    for (let i = 1; i < aprs.length; i++) expect(aprs[i]).toBeGreaterThan(aprs[i - 1]);
    aprs.forEach((a) => expect(a).toBeLessThan(annual));
    // and converging UP toward gross as DTE → large (fee share → 0)
    expect(aprs[aprs.length - 1]).toBeGreaterThan(annual - 1);
  });

  it("monotonicity holds for random fixed-annualized baskets (property over seeds)", () => {
    const r = lcg(7);
    for (let t = 0; t < 40; t++) {
      const spot = between(r, 1_000, 80_000);
      const annual = between(r, 5, 60); // strictly positive gross
      const dteA = Math.floor(between(r, 8, 120));
      const dteB = dteA + Math.floor(between(r, 1, 240)); // strictly longer hold
      const mk = (dte: number) =>
        planCalendarLegs(opp({ spotPrice: spot, futurePrice: futForAnnualBasis(spot, annual, dte), dteDays: dte }), 1000, lim({ minNetApr: -1e9 })).expectedAprNet;
      // longer hold ⇒ higher (or equal under rounding) net APR for the same gross carry rate
      expect(mk(dteB)).toBeGreaterThanOrEqual(mk(dteA) - 1e-9);
    }
  });

  it("for a FIXED RAW basis, the per-hold NET basis is CONSTANT in DTE (the fee is one-shot, captured once)", () => {
    const spot = 60_000;
    const fut = futForRawBasis(spot, 3); // 3% raw basis, same regardless of tenor
    const netBases = [15, 30, 90, 200].map(
      (dte) => planCalendarLegs(opp({ spotPrice: spot, futurePrice: fut, dteDays: dte }), 1000, lim({ minNetApr: -1e9 })).expectedNetBasisPct,
    );
    netBases.forEach((nb) => expect(nb).toBeCloseTo(netBases[0], 9));
    // and (3 - 0.20) with default 5bp/side ×4 fills
    expect(netBases[0]).toBeCloseTo(3 - 0.2, 9);
  });

  it("for a FIXED RAW basis, net APR is ∝ 1/dte (decreasing) — the inverse of the gross-rate framing", () => {
    const spot = 60_000;
    const fut = futForRawBasis(spot, 3);
    const aprs = [30, 60, 120, 240].map(
      (dte) => planCalendarLegs(opp({ spotPrice: spot, futurePrice: fut, dteDays: dte }), 1000, lim({ minNetApr: -1e9 })).expectedAprNet,
    );
    for (let i = 1; i < aprs.length; i++) expect(aprs[i]).toBeLessThan(aprs[i - 1]);
  });

  it("higher fee per side never INCREASES net APR (fee is a non-negative drag)", () => {
    const r = lcg(8);
    for (let t = 0; t < 30; t++) {
      const spot = between(r, 5_000, 70_000);
      const raw = between(r, 1, 8);
      const dte = Math.floor(between(r, 30, 300));
      const o = opp({ spotPrice: spot, futurePrice: futForRawBasis(spot, raw), dteDays: dte });
      const lo = planCalendarLegs(o, 1000, lim({ minNetApr: -1e9, feeBpsPerSide: 1 })).expectedAprNet;
      const hi = planCalendarLegs(o, 1000, lim({ minNetApr: -1e9, feeBpsPerSide: 25 })).expectedAprNet;
      expect(hi).toBeLessThanOrEqual(lo + 1e-9);
    }
  });
});

describe("planCalendarLegs — near-/far-expiry gates exactly at the boundary", () => {
  // near-expiry uses  dteDays < minDteDays  (strict): == minDteDays PASSES, just below BLOCKS.
  it("near-expiry: dte == minDteDays passes; dte just below blocks (boundary is strict, exclusive at min)", () => {
    const econ = lim({ minDteDays: 7, minNetApr: -1e9, minFutureOiUsd: 0 });
    const big = opp({ futurePrice: 70_000, spotPrice: 60_000 }); // fat basis so only the tenor gate can fire
    noBlocker(planCalendarLegs({ ...big, dteDays: 7 }, 1000, econ).blockers, /near|friction|expiry/);
    hasBlocker(planCalendarLegs({ ...big, dteDays: 6 }, 1000, econ).blockers, /near|friction|expiry/);
    // fractional just-below: 6.9 rounds to "7d" in the message but the RAW value < 7 still blocks
    const frac = planCalendarLegs({ ...big, dteDays: 6.9 }, 1000, econ);
    hasBlocker(frac.blockers, /near|friction|expiry/);
    expect(frac.blockers.some((b) => /^7d to expiry < 7d/.test(b))).toBe(true); // display rounds, gate uses raw
  });

  // far-expiry uses  dteDays > maxDteDays  (strict): == maxDteDays PASSES, just above BLOCKS.
  it("far-expiry: dte == maxDteDays passes; dte just above blocks", () => {
    const econ = lim({ maxDteDays: 365, minNetApr: -1e9, minFutureOiUsd: 0 });
    const big = opp({ futurePrice: 70_000, spotPrice: 60_000 });
    noBlocker(planCalendarLegs({ ...big, dteDays: 365 }, 1000, econ).blockers, /locked too long|> 365d/);
    hasBlocker(planCalendarLegs({ ...big, dteDays: 366 }, 1000, econ).blockers, /locked too long|> 365d/);
    hasBlocker(planCalendarLegs({ ...big, dteDays: 365.1 }, 1000, econ).blockers, /locked too long/);
  });

  it("the two tenor gates partition the line: [min, max] is the only no-tenor-blocker window", () => {
    const r = lcg(9);
    const econ = lim({ minDteDays: 7, maxDteDays: 365, minNetApr: -1e9, minFutureOiUsd: 0 });
    const big = opp({ futurePrice: 80_000, spotPrice: 60_000 });
    for (let t = 0; t < 50; t++) {
      const dte = between(r, 0.1, 500);
      const b = planCalendarLegs({ ...big, dteDays: dte }, 1000, econ).blockers;
      const tenorBlocked = b.some((x) => /near|friction|locked too long/.test(x));
      const inWindow = dte >= 7 && dte <= 365;
      expect(tenorBlocked).toBe(!inWindow);
    }
  });
});

describe("planCalendarLegs — net-APR economics gate boundary", () => {
  // gate: netApr < minNetApr (strict). At exactly minNetApr it PASSES even though the DISPLAYED field rounds.
  it("net APR exactly at minNetApr passes; a hair below blocks (gate uses unrounded netApr, not the 1-dp field)", () => {
    const spot = 60_000;
    // dte=365 ⇒ netApr = basisPct - 0.20 (fee). Want netApr == 6 ⇒ basisPct == 6.20.
    const atBoundary = planCalendarLegs(
      opp({ spotPrice: spot, futurePrice: futForRawBasis(spot, 6.2), dteDays: 365 }),
      1000,
      lim({ minNetApr: 6, feeBpsPerSide: 5, minFutureOiUsd: 0 }),
    );
    expect(atBoundary.expectedAprNet).toBeCloseTo(6.0, 6);
    noBlocker(atBoundary.blockers, /uneconomic/);

    const justBelow = planCalendarLegs(
      opp({ spotPrice: spot, futurePrice: futForRawBasis(spot, 6.199), dteDays: 365 }),
      1000,
      lim({ minNetApr: 6, feeBpsPerSide: 5, minFutureOiUsd: 0 }),
    );
    // field still rounds to 6.0, yet the raw netApr (<6) trips the gate — proves the comparison is on the raw value
    expect(justBelow.expectedAprNet).toBe(6); // rounded display
    hasBlocker(justBelow.blockers, /uneconomic/);
  });
});

describe("planCalendarLegs — OI liquidity floor boundary", () => {
  // gate: futureOiUsd < minFutureOiUsd (strict). == floor passes, floor-1 blocks.
  it("OI exactly at the floor passes; one dollar below blocks", () => {
    const econ = lim({ minFutureOiUsd: 5_000_000, minNetApr: -1e9 });
    const fat = opp({ futurePrice: 65_000, spotPrice: 60_000, dteDays: 90 });
    noBlocker(planCalendarLegs({ ...fat, futureOiUsd: 5_000_000 }, 1000, econ).blockers, /OI .*too illiquid/);
    hasBlocker(planCalendarLegs({ ...fat, futureOiUsd: 4_999_999 }, 1000, econ).blockers, /OI .*too illiquid/);
    hasBlocker(planCalendarLegs({ ...fat, futureOiUsd: 0 }, 1000, econ).blockers, /OI .*too illiquid/);
  });
});

describe("planCalendarLegs — contango/backwardation side selection (sign correctness)", () => {
  it("contango (future > spot) ⇒ SHORT future + LONG spot, no borrow needed", () => {
    const p = planCalendarLegs(opp({ futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), 1000);
    expect(p.futureLeg.positionSide).toBe("short");
    expect(p.futureLeg.action).toBe("sell");
    expect(p.spotLeg!.positionSide).toBe("long");
    expect(p.spotLeg!.action).toBe("buy");
    expect(p.basisPct).toBeGreaterThan(0);
    noBlocker(p.blockers, /BORROW/); // long-spot never needs a borrow
  });

  it("backwardation (future < spot) ⇒ LONG future + SHORT spot (the borrow leg)", () => {
    const p = planCalendarLegs(opp({ futurePrice: 58_000, spotPrice: 60_000, dteDays: 90 }), 1000, lim({ allowSpotBorrow: true }));
    expect(p.futureLeg.positionSide).toBe("long");
    expect(p.futureLeg.action).toBe("buy");
    expect(p.spotLeg!.positionSide).toBe("short");
    expect(p.spotLeg!.action).toBe("sell");
    expect(p.basisPct).toBeLessThan(0);
  });

  it("zero-basis tie (future == spot) resolves to the contango branch (basis >= 0): SHORT future + LONG spot", () => {
    const p = planCalendarLegs(opp({ futurePrice: 60_000, spotPrice: 60_000, dteDays: 90 }), 1000, lim({ minNetApr: -1e9 }));
    expect(p.basisPct).toBe(0);
    expect(p.futureLeg.positionSide).toBe("short");
    expect(p.spotLeg!.positionSide).toBe("long");
    noBlocker(p.blockers, /BORROW/); // tie does NOT take the short-spot/borrow path
  });

  it("side selection is correct across a random sweep around parity (sign(basis) drives the legs)", () => {
    const r = lcg(11);
    for (let t = 0; t < 60; t++) {
      const spot = between(r, 1_000, 70_000);
      const drift = between(r, -0.08, 0.08);
      const fut = spot * (1 + drift);
      const p = planCalendarLegs(opp({ spotPrice: spot, futurePrice: fut, dteDays: 90 }), 1000, lim({ allowSpotBorrow: true, minNetApr: -1e9, minFutureOiUsd: 0 }));
      const contango = fut >= spot;
      expect(p.futureLeg.positionSide).toBe(contango ? "short" : "long");
      expect(p.spotLeg!.positionSide).toBe(contango ? "long" : "short");
      // legs are always opposite ⇒ delta-neutral construction
      expect(p.futureLeg.positionSide).not.toBe(p.spotLeg!.positionSide);
    }
  });
});

describe("planCalendarLegs — backwardation borrow gate + allowSpotBorrow override", () => {
  it("backwardation blocks by default (needs spot borrow); allowSpotBorrow=true clears ONLY the borrow blocker", () => {
    const o = opp({ futurePrice: 56_000, spotPrice: 60_000, dteDays: 90 }); // ~ -6.67% raw, fat enough to be economic
    const blocked = planCalendarLegs(o, 1000); // default allowSpotBorrow:false
    hasBlocker(blocked.blockers, /BORROW/);

    const cleared = planCalendarLegs(o, 1000, lim({ allowSpotBorrow: true }));
    noBlocker(cleared.blockers, /BORROW/);
    // the override must not silently disable the OTHER gates — same opp, OI floor still enforced
    const stillIlliquid = planCalendarLegs({ ...o, futureOiUsd: 1 }, 1000, lim({ allowSpotBorrow: true }));
    hasBlocker(stillIlliquid.blockers, /OI .*too illiquid/);
  });

  it("contango never trips the borrow gate regardless of allowSpotBorrow", () => {
    const o = opp({ futurePrice: 63_000, spotPrice: 60_000, dteDays: 90 });
    noBlocker(planCalendarLegs(o, 1000, lim({ allowSpotBorrow: false })).blockers, /BORROW/);
    noBlocker(planCalendarLegs(o, 1000, lim({ allowSpotBorrow: true })).blockers, /BORROW/);
  });
});

describe("planCalendarLegs — degenerate / adversarial inputs (no throw, no NaN leakage)", () => {
  it("spotPrice = 0 ⇒ basis defined as 0 (no div-by-zero), still emits a finite plan", () => {
    const p = planCalendarLegs(opp({ spotPrice: 0, futurePrice: 60_000 }), 1000);
    expect(p.basisPct).toBe(0);
    expect(Number.isFinite(p.annualizedBasisPct)).toBe(true);
    expect(Number.isFinite(p.expectedAprNet)).toBe(true);
    expect(p.futureLeg.positionSide).toBe("short"); // basis>=0 branch
  });

  it("negative spotPrice ⇒ guarded to basis 0 (spotPrice>0 check), finite outputs", () => {
    const p = planCalendarLegs(opp({ spotPrice: -100, futurePrice: 60_000 }), 1000);
    expect(p.basisPct).toBe(0);
    expect(Number.isFinite(p.annualizedBasisPct)).toBe(true);
  });

  it("dteDays = 0 ⇒ no div-by-zero: annualized and net APR are 0; near-expiry AND uneconomic both fire", () => {
    const p = planCalendarLegs(opp({ dteDays: 0, futurePrice: 65_000 }), 1000);
    expect(p.annualizedBasisPct).toBe(0);
    expect(p.expectedAprNet).toBe(0);
    hasBlocker(p.blockers, /near|friction|expiry/);
    hasBlocker(p.blockers, /uneconomic/);
  });

  it("NaN futurePrice ⇒ NaN basis propagates but never throws, and the plan is still produced", () => {
    const p = planCalendarLegs(opp({ futurePrice: NaN, spotPrice: 60_000, dteDays: 90 }), 1000);
    expect(Number.isNaN(p.basisPct)).toBe(true);
    // NaN comparisons are all false ⇒ contango branch (basis>=0 is false ⇒ "long"); assert it doesn't throw + has a leg
    expect(p.futureLeg).toBeTruthy();
    expect(p.spotLeg).toBeTruthy();
  });

  it("empty spotVenues ⇒ unhedged blocker by default; allowUnhedged clears it (spotLeg stays null either way)", () => {
    const naked = planCalendarLegs(opp({ coin: "XYZ", spotVenues: [], futurePrice: 65_000, dteDays: 90 }), 1000);
    expect(naked.spotLeg).toBeNull();
    expect(naked.deltaNeutral).toBe(false);
    hasBlocker(naked.blockers, /cannot hedge|NAKED/);

    const over = planCalendarLegs(opp({ coin: "XYZ", spotVenues: [], futurePrice: 65_000, dteDays: 90 }), 1000, lim({ allowUnhedged: true }));
    expect(over.spotLeg).toBeNull();
    noBlocker(over.blockers, /NAKED/);
  });

  it("notional is capped at maxNotionalPerName even for absurd capital, and matched on both legs", () => {
    const p = planCalendarLegs(opp({ futurePrice: 65_000, dteDays: 90 }), 9_999_999_999, lim({ maxNotionalPerName: 1_000 }));
    expect(p.futureLeg.notionalUsd).toBe(1_000);
    expect(p.spotLeg!.notionalUsd).toBe(1_000);
    // because notional is clamped by Math.min, the per-name-cap blocker can never fire on the clamped value
    noBlocker(p.blockers, /per-name cap/);
  });

  it("negative capital flows through Math.min as the (smaller) notional — outputs stay finite and self-consistent", () => {
    const p = planCalendarLegs(opp({ futurePrice: 65_000, dteDays: 90 }), -500, lim({ maxNotionalPerName: 1_000 }));
    expect(p.futureLeg.notionalUsd).toBe(-500);
    expect(p.spotLeg!.notionalUsd).toBe(-500); // legs stay matched
  });
});

describe("planCalendarLegs — purity / causal independence (the no-lookahead analogue for a stateless transform)", () => {
  it("is a pure function of (opp, limits): identical inputs ⇒ deeply-equal output", () => {
    const o = opp({ futurePrice: 62_500, spotPrice: 60_000, dteDays: 77 });
    expect(planCalendarLegs(o, 1234, lim({ feeBpsPerSide: 4 }))).toEqual(planCalendarLegs(o, 1234, lim({ feeBpsPerSide: 4 })));
  });

  it("does not mutate its opp / limits inputs", () => {
    const o = opp({ futurePrice: 62_000, spotPrice: 60_000, dteDays: 90, spotVenues: ["coinbase", "kraken"] });
    const oCopy = JSON.parse(JSON.stringify(o));
    const l = lim({ feeBpsPerSide: 6 });
    const lCopy = JSON.parse(JSON.stringify(l));
    planCalendarLegs(o, 1000, l);
    expect(o).toEqual(oCopy);
    expect(l).toEqual(lCopy);
  });

  it("rounding contract: reported fields are fixed-precision (≤3dp basis/net, ≤1dp annualized/apr)", () => {
    const r = lcg(13);
    for (let t = 0; t < 40; t++) {
      const spot = between(r, 1_000, 70_000);
      const fut = spot * (1 + between(r, -0.1, 0.1));
      const dte = Math.floor(between(r, 5, 400));
      const p = planCalendarLegs(opp({ spotPrice: spot, futurePrice: fut, dteDays: dte }), 1000, lim({ allowSpotBorrow: true, minNetApr: -1e9, minFutureOiUsd: 0 }));
      const dp = (x: number, d: number) => Math.abs(x - +x.toFixed(d)) < 1e-9;
      expect(dp(p.basisPct, 3)).toBe(true);
      expect(dp(p.expectedNetBasisPct, 3)).toBe(true);
      expect(dp(p.annualizedBasisPct, 1)).toBe(true);
      expect(dp(p.expectedAprNet, 1)).toBe(true);
    }
  });
});

describe("calendarBookCheck — total-notional book cap + executable filtering", () => {
  const goodPlan = (coin: string) =>
    planCalendarLegs(opp({ coin, futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), 1000); // 1000 notional, no blockers

  it("only blocker-free plans count toward the book; blocked plans are excluded from totalNotional", () => {
    const good = goodPlan("BTC");
    const blocked = planCalendarLegs(opp({ coin: "ZZZ", spotVenues: [], futurePrice: 62_000, dteDays: 90 }), 1000); // unhedged blocker
    const { executable, totalNotional, bookBlockers } = calendarBookCheck([good, blocked], lim({ maxTotalNotional: 5_000 }));
    expect(executable).toHaveLength(1);
    expect(executable[0].coin).toBe("BTC");
    expect(totalNotional).toBe(1_000); // blocked plan's notional NOT summed
    expect(bookBlockers).toEqual([]);
  });

  it("book cap is strict >: total == cap passes, total just over blocks", () => {
    const four = [1, 2, 3, 4].map((i) => goodPlan(`C${i}`)); // 4 × 1000 = 4000
    const atCap = calendarBookCheck(four, lim({ maxTotalNotional: 4_000 }));
    expect(atCap.totalNotional).toBe(4_000);
    expect(atCap.bookBlockers).toEqual([]); // == cap is allowed (gate is > )

    const five = [1, 2, 3, 4, 5].map((i) => goodPlan(`C${i}`)); // 5000
    const over = calendarBookCheck(five, lim({ maxTotalNotional: 4_000 }));
    expect(over.totalNotional).toBe(5_000);
    hasBlocker(over.bookBlockers, /book notional/);
  });

  it("empty book ⇒ zero notional, no executables, no blockers", () => {
    const { executable, totalNotional, bookBlockers } = calendarBookCheck([], lim({ maxTotalNotional: 5_000 }));
    expect(executable).toEqual([]);
    expect(totalNotional).toBe(0);
    expect(bookBlockers).toEqual([]);
  });

  it("a book of ALL-blocked plans is empty and never trips the cap (no false positive)", () => {
    const blocked = ["A", "B", "C"].map((c) => planCalendarLegs(opp({ coin: c, spotVenues: [], futurePrice: 62_000, dteDays: 90 }), 1000));
    const { executable, totalNotional, bookBlockers } = calendarBookCheck(blocked, lim({ maxTotalNotional: 1 }));
    expect(executable).toEqual([]);
    expect(totalNotional).toBe(0);
    expect(bookBlockers).toEqual([]); // cap of $1 is irrelevant — nothing executable to sum
  });

  it("append-stability (causal analogue): adding a later plan never rewrites the earlier executables, only extends them", () => {
    const head = [goodPlan("BTC"), goodPlan("ETH")];
    const headRes = calendarBookCheck(head, lim({ maxTotalNotional: 1e9 }));
    const full = calendarBookCheck([...head, goodPlan("SOL")], lim({ maxTotalNotional: 1e9 }));
    // the first two executables are byte-for-byte identical (order + content preserved)
    expect(full.executable.slice(0, 2)).toEqual(headRes.executable);
    expect(full.totalNotional).toBe(headRes.totalNotional + 1_000);
  });

  it("does not mutate the input plans array or its members", () => {
    const plans = [goodPlan("BTC"), goodPlan("ETH")];
    const copy = JSON.parse(JSON.stringify(plans));
    calendarBookCheck(plans, lim({ maxTotalNotional: 100 }));
    expect(plans).toEqual(copy);
  });

  it("totalNotional sums futureLeg notionals exactly across a random executable basket", () => {
    const r = lcg(17);
    const plans = Array.from({ length: 6 }, (_, i) => {
      const cap = Math.floor(between(r, 100, 900));
      return planCalendarLegs(opp({ coin: `K${i}`, futurePrice: 62_000, spotPrice: 60_000, dteDays: 90 }), cap, lim({ maxNotionalPerName: cap }));
    });
    const expected = plans.reduce((a, p) => a + p.futureLeg.notionalUsd, 0);
    expect(calendarBookCheck(plans, lim({ maxTotalNotional: 1e9 })).totalNotional).toBe(expected);
  });
});
