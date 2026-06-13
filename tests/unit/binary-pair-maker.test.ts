/**
 * Tests for the merge-maker pair planner — the structural properties that make
 * the lane work: the pair budget is NEVER violated, the unpaired cap is a hard
 * exhaust, the τ floor is reduce-only, prices are on the venue tick, and merge
 * settlement conserves cash.
 */
import { describe, it, expect } from "vitest";
import { planPairQuotes, settleMerge, toTick, type PairMakerParams } from "@/lib/strategies/binary-pair-maker";

const P: PairMakerParams = {
  quoteSizeShares: 25,
  mergeMargin: 0.02,
  feeBuffer: 0.005,
  maxUnpairedShares: 50,
  tauFloorSec: 60,
  safetyEdge: 0.01,
};

const mid = (b: number, a: number) => ({ bestBid: b, bestAsk: a });

describe("planPairQuotes — pair budget", () => {
  it("never lets yesBid + noBid exceed 1 − margin − fees", () => {
    // wide books that would tempt both bids high
    for (const pFair of [0.3, 0.5, 0.62, 0.8]) {
      const plan = planPairQuotes({
        pFair,
        yesBook: mid(pFair - 0.01, pFair + 0.01),
        noBook: mid(1 - pFair - 0.01, 1 - pFair + 0.01),
        yesShares: 0, noShares: 0, tauSec: 200, params: P,
      });
      if (plan.yesBid && plan.noBid) {
        expect(plan.yesBid.px + plan.noBid.px).toBeLessThanOrEqual(1 - P.mergeMargin - P.feeBuffer + 1e-9);
      }
    }
  });

  it("posts both sides on the venue tick", () => {
    const plan = planPairQuotes({
      pFair: 0.537,
      yesBook: mid(0.51, 0.55), noBook: mid(0.43, 0.47),
      yesShares: 0, noShares: 0, tauSec: 200, params: P,
    });
    for (const side of [plan.yesBid, plan.noBid]) {
      expect(side).not.toBeNull();
      expect(Math.abs(side!.px * 100 - Math.round(side!.px * 100))).toBeLessThan(1e-9);
    }
  });

  it("never bids above fair − safetyEdge on either leg", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.60, 0.65), // book way above fair — join would overpay
      noBook: mid(0.30, 0.35),
      yesShares: 0, noShares: 0, tauSec: 200, params: P,
    });
    expect(plan.yesBid!.px).toBeLessThanOrEqual(0.5 - P.safetyEdge + 1e-9);
  });

  it("never crosses an ask", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.40, 0.42), noBook: mid(0.50, 0.52),
      yesShares: 0, noShares: 0, tauSec: 200, params: P,
    });
    expect(plan.yesBid!.px).toBeLessThan(0.42);
    expect(plan.noBid!.px).toBeLessThan(0.52);
  });

  it("returns nothing on a dead fair value", () => {
    const plan = planPairQuotes({
      pFair: NaN as unknown as number,
      yesBook: mid(0.4, 0.6), noBook: mid(0.4, 0.6),
      yesShares: 0, noShares: 0, tauSec: 200, params: P,
    });
    expect(plan.yesBid).toBeNull();
    expect(plan.noBid).toBeNull();
  });
});

describe("planPairQuotes — unpaired cap (the structural exhaust)", () => {
  it("stops adding YES at the cap and keeps the pairing NO bid", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.45, 0.49), noBook: mid(0.45, 0.49),
      yesShares: 75, noShares: 25, // unpaired +50 = cap
      tauSec: 200, params: P,
    });
    expect(plan.unpaired).toBe(50);
    expect(plan.yesBid).toBeNull();
    expect(plan.noBid).not.toBeNull();
    expect(plan.noBid!.reason).toMatch(/pairing down/);
  });

  it("mirror: stops adding NO when NO is in excess", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.45, 0.49), noBook: mid(0.45, 0.49),
      yesShares: 0, noShares: 60,
      tauSec: 200, params: P,
    });
    expect(plan.noBid).toBeNull();
    expect(plan.yesBid).not.toBeNull();
  });
});

describe("planPairQuotes — τ floor (reduce-only endgame)", () => {
  it("below the floor with excess YES, only the NO bid survives", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.45, 0.49), noBook: mid(0.45, 0.49),
      yesShares: 30, noShares: 10, tauSec: 30, params: P,
    });
    expect(plan.yesBid).toBeNull();
    expect(plan.noBid).not.toBeNull();
    expect(plan.noBid!.reason).toMatch(/tau-floor/);
  });

  it("below the floor with flat inventory, quotes nothing", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.45, 0.49), noBook: mid(0.45, 0.49),
      yesShares: 20, noShares: 20, tauSec: 30, params: P,
    });
    expect(plan.yesBid).toBeNull();
    expect(plan.noBid).toBeNull();
  });
});

describe("planPairQuotes — realized-cost pair guard", () => {
  const G: PairMakerParams = { ...P, costGuard: true };

  it("caps the COMPLETING bid so a held leg's pair locks >= mergeMargin in realized terms", () => {
    // hold 50 YES at avg cost 0.60 (expensive). Without the guard the NO bid would
    // pair at well over (1 - 0.60) = 0.40, locking NEGATIVE margin. The guard caps
    // NO at toTick(1 - 0.02 - 0.60) = 0.38 → realized pair cost 0.60 + 0.38 = 0.98.
    // unpaired 40 < cap(50) so the cost-guard reason survives (not overwritten by the unpaired exhaust)
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.49, 0.51), noBook: mid(0.49, 0.51), // NO touch would tempt a 0.50 bid
      yesShares: 40, noShares: 0, yesCost: 40 * 0.60,
      tauSec: 200, params: G,
    });
    expect(plan.noBid).not.toBeNull();
    expect(plan.noBid!.px).toBeLessThanOrEqual(0.38 + 1e-9);
    // realized pair locks >= margin
    expect(0.60 + plan.noBid!.px).toBeLessThanOrEqual(1 - G.mergeMargin + 1e-9);
    expect(plan.noBid!.reason).toMatch(/cost-guard/);
  });

  it("withdraws the completing side when no tick-valid price survives the cap", () => {
    // held YES avg cost 0.99 → cap = toTick(1 - 0.02 - 0.99) < 0.01 → NO withdrawn
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.49, 0.51), noBook: mid(0.49, 0.51),
      yesShares: 30, noShares: 0, yesCost: 30 * 0.99,
      tauSec: 200, params: G,
    });
    expect(plan.noBid).toBeNull();
  });

  it("mirror: held NO caps the completing YES bid", () => {
    const plan = planPairQuotes({
      pFair: 0.5,
      yesBook: mid(0.49, 0.51), noBook: mid(0.49, 0.51),
      yesShares: 0, noShares: 40, noCost: 40 * 0.58,
      tauSec: 200, params: G,
    });
    expect(plan.yesBid).not.toBeNull();
    expect(plan.yesBid!.px).toBeLessThanOrEqual(0.40 + 1e-9); // toTick(1 - 0.02 - 0.58)
  });

  it("is a no-op vs baseline when costGuard is off (default)", () => {
    const inp = {
      pFair: 0.5,
      yesBook: mid(0.49, 0.51), noBook: mid(0.49, 0.51),
      yesShares: 50, noShares: 0, yesCost: 50 * 0.60, tauSec: 200,
    } as const;
    const guarded = planPairQuotes({ ...inp, params: G });
    const baseline = planPairQuotes({ ...inp, params: P });
    // the guard only tightens — baseline NO bid is >= guarded NO bid
    expect(baseline.noBid!.px).toBeGreaterThanOrEqual(guarded.noBid!.px - 1e-9);
  });

  it("does not touch quotes when inventory is flat (no held leg to guard)", () => {
    const inp = {
      pFair: 0.5, yesBook: mid(0.49, 0.51), noBook: mid(0.49, 0.51),
      yesShares: 0, noShares: 0, yesCost: 0, noCost: 0, tauSec: 200,
    } as const;
    const guarded = planPairQuotes({ ...inp, params: G });
    const baseline = planPairQuotes({ ...inp, params: P });
    expect(guarded.yesBid!.px).toBeCloseTo(baseline.yesBid!.px, 9);
    expect(guarded.noBid!.px).toBeCloseTo(baseline.noBid!.px, 9);
  });
});

describe("settleMerge", () => {
  it("merges complete sets at $1 and locks the margin", () => {
    // 30 YES @ 0.48 avg, 20 NO @ 0.47 avg → 20 sets, margin 20·(1−0.95)=1.00
    const r = settleMerge({ yesShares: 30, noShares: 20, yesCost: 30 * 0.48, noCost: 20 * 0.47 });
    expect(r.merged).toBe(20);
    expect(r.cashIn).toBeCloseTo(20, 9);
    expect(r.lockedMargin).toBeCloseTo(20 * (1 - 0.95), 9);
    expect(r.next.yesShares).toBe(10);
    expect(r.next.noShares).toBe(0);
    expect(r.next.yesCost).toBeCloseTo(10 * 0.48, 9);
    expect(r.next.noCost).toBeCloseTo(0, 9);
  });

  it("no-op when one leg is empty", () => {
    const r = settleMerge({ yesShares: 10, noShares: 0, yesCost: 4.8, noCost: 0 });
    expect(r.merged).toBe(0);
    expect(r.next.yesShares).toBe(10);
  });

  it("cash conservation: cost out + margin == cash in", () => {
    const st = { yesShares: 13, noShares: 13, yesCost: 13 * 0.46, noCost: 13 * 0.51 };
    const r = settleMerge(st);
    const costOfMerged = st.yesCost + st.noCost - (r.next.yesCost + r.next.noCost);
    expect(costOfMerged + r.lockedMargin).toBeCloseTo(r.cashIn, 9);
  });
});

describe("toTick", () => {
  it("rounds down to the cent and clamps", () => {
    expect(toTick(0.537)).toBeCloseTo(0.53, 9);
    expect(toTick(0.5399999)).toBeCloseTo(0.53, 9);
    expect(toTick(0.005)).toBeCloseTo(0.01, 9);
    expect(toTick(1.2)).toBeCloseTo(0.99, 9);
  });
});
