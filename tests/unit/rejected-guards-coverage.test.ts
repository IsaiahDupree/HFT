/**
 * rejected-guards-coverage — REGRESSION GUARDS for three carry candidates that were TESTED and
 * REJECTED (docs/EDGES.md "Tested and rejected"). Each rejection rests on HONEST accounting that a
 * naive funding-only model omits. These tests encode that WHY as executable assertions, so a future
 * "fix" that silently un-rejects a dead edge trips a guard instead of shipping.
 *
 * The three dead edges (and the source script each mirrors):
 *   1. Cross-sectional funding "carry"  — scripts/_carry-xsection-funding-carry.ts
 *      funding-only = BUY (Sharpe 8.9); price-aware = −65% STAND_ASIDE. Baskets don't cancel:
 *      shorting pumped high-funding alts loses MORE on price than the funding pays.
 *   2. Inter-exchange funding carry      — scripts/_carry-interexchange-funding-carry.ts
 *      spread ~1.4 bp/day → ~0.6% APR, uneconomic once you pay both perp legs.
 *   3. Basis roll-down TIMING            — scripts/_carry-basis-rolldown-curve.ts
 *      "enter only in the fat dte band" is falsified — full-life is best; the band just sheds
 *      days-at-risk without improving the carry.
 *
 * Convention (no network): tiny FIXED inline fixtures + a deterministic LCG (the repo's property-test
 * pattern from funding.props.test.ts — fast-check is NOT installed here, so we drive randomness with
 * a seeded LCG). Property tests are LCG-driven exactly as the existing suite does it.
 */
import { describe, it, expect } from "vitest";
import {
  xsectionFundingOnlyReturn,
  xsectionPriceAwareReturn,
  interexchangeCarryEconomics,
  dteBandGatedReturns,
  carryPerDayAtRisk,
  type XsectionLeg,
} from "@/lib/exec/rejected-carry-guards";
import { calendarBasisReturns } from "@/lib/backtest/candle/funding";
import { sharpe } from "@/lib/backtest/candle/stats";

// ── deterministic LCG (Numerical Recipes), same as funding.props.test.ts ──
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const leg = (funding: number, priceRet: number): XsectionLeg => ({ funding, priceRet });

// =================================================================================================
// REJECTION #1 — cross-sectional funding "carry": the baskets don't cancel.
// =================================================================================================
describe("REJECTION #1 — xsection funding carry: price-aware kills the funding-only mirage", () => {
  // THE TRAP fixture: high-funding shorts are high BECAUSE they're being bid up. The short basket
  // pays you fat funding (+0.02/day) but those coins PUMP (+8%/day); the long basket pays you nothing
  // (~0 funding) and drifts flat. Funding-only looks fat; price-aware is deeply negative.
  const shortBasket = [leg(0.02, 0.08), leg(0.025, 0.10), leg(0.018, 0.07)]; // top funding, pumping
  const longBasket = [leg(0.0, 0.0), leg(-0.001, 0.005), leg(0.001, -0.005)]; // bottom funding, flat

  it("funding-only model reports POSITIVE income (the mirage that earned the BUY)", () => {
    const fundingOnly = xsectionFundingOnlyReturn(shortBasket, longBasket);
    expect(fundingOnly).toBeGreaterThan(0); // collect shorts' fat funding, pay ~0 on longs
  });

  it("price-aware model goes NEGATIVE on the same bar (the honest −65% verdict)", () => {
    const honest = xsectionPriceAwareReturn(shortBasket, longBasket);
    expect(honest).toBeLessThan(0); // the pump on the short leg swamps the funding collected
  });

  it("CORE GUARD: price-aware ≤ funding-only whenever shorts pump harder than longs (basket never cancels favorably)", () => {
    // priceP&L = −mean(shortPriceRet) + mean(longPriceRet); when shorts pump more, this is < 0,
    // so the honest return is strictly below the funding-only return. This is the WHY of the rejection.
    const fundingOnly = xsectionFundingOnlyReturn(shortBasket, longBasket);
    const honest = xsectionPriceAwareReturn(shortBasket, longBasket);
    expect(honest).toBeLessThan(fundingOnly);
  });

  it("the gap between the two views is EXACTLY the basket price P&L (accounting identity)", () => {
    const fundingOnly = xsectionFundingOnlyReturn(shortBasket, longBasket);
    const honest = xsectionPriceAwareReturn(shortBasket, longBasket);
    const meanShortPx = sum(shortBasket.map((l) => l.priceRet)) / shortBasket.length;
    const meanLongPx = sum(longBasket.map((l) => l.priceRet)) / longBasket.length;
    const pricePnL = -meanShortPx + meanLongPx;
    expect(honest - fundingOnly).toBeCloseTo(pricePnL, 12);
  });

  it("PROPERTY (LCG): over many random bars where high funding co-moves with price pumps, the price-aware MEAN is below funding-only", () => {
    const r = lcg(101);
    let fOnlySum = 0, honestSum = 0;
    const N = 400;
    for (let t = 0; t < N; t++) {
      // shorts: positive funding f, price return correlated to f (high funding ⇒ pump): px ≈ 4·f + noise
      const shorts: XsectionLeg[] = Array.from({ length: 3 }, () => {
        const f = between(r, 0.005, 0.03);
        return leg(f, 4 * f + between(r, -0.01, 0.01));
      });
      // longs: ~zero funding, flat-ish price
      const longs: XsectionLeg[] = Array.from({ length: 3 }, () =>
        leg(between(r, -0.002, 0.002), between(r, -0.01, 0.01)),
      );
      fOnlySum += xsectionFundingOnlyReturn(shorts, longs);
      honestSum += xsectionPriceAwareReturn(shorts, longs);
    }
    expect(honestSum / N).toBeLessThan(fOnlySum / N);
    expect(fOnlySum / N).toBeGreaterThan(0); // funding-only stays in the "BUY" mirage
    expect(honestSum / N).toBeLessThan(0);   // honest accounting is net-negative → STAND_ASIDE
  });

  it("SIGN sanity: if baskets TRULY cancel (no price co-movement, symmetric), the two views agree", () => {
    // shorts and longs both flat price, only funding differs → price P&L = 0 → identical returns.
    const s = [leg(0.01, 0), leg(0.012, 0)];
    const l = [leg(-0.001, 0), leg(0.0, 0)];
    expect(xsectionPriceAwareReturn(s, l)).toBeCloseTo(xsectionFundingOnlyReturn(s, l), 12);
  });

  it("FEE monotonicity: a higher per-leg fee on turnover never raises either return", () => {
    const r = lcg(102);
    for (let t = 0; t < 50; t++) {
      const s = Array.from({ length: 3 }, () => leg(between(r, 0, 0.02), between(r, -0.05, 0.05)));
      const l = Array.from({ length: 3 }, () => leg(between(r, -0.01, 0.01), between(r, -0.05, 0.05)));
      const turnover = between(r, 0.1, 2);
      const lo = xsectionPriceAwareReturn(s, l, 1, turnover);
      const hi = xsectionPriceAwareReturn(s, l, 20, turnover);
      expect(hi).toBeLessThanOrEqual(lo + 1e-12);
      const loF = xsectionFundingOnlyReturn(s, l, 1, turnover);
      const hiF = xsectionFundingOnlyReturn(s, l, 20, turnover);
      expect(hiF).toBeLessThanOrEqual(loF + 1e-12);
    }
  });

  it("zero turnover ⇒ fee never applies (fee charged only on legs that move)", () => {
    const s = [leg(0.02, 0.01)], l = [leg(0, 0)];
    expect(xsectionPriceAwareReturn(s, l, 999, 0)).toBeCloseTo(xsectionPriceAwareReturn(s, l, 0, 0), 12);
  });

  it("DEGENERATE: empty baskets earn exactly 0 (no NaN from div-by-zero)", () => {
    expect(xsectionFundingOnlyReturn([], [])).toBe(0);
    expect(xsectionPriceAwareReturn([], [])).toBe(0);
    expect(Number.isFinite(xsectionPriceAwareReturn([], [leg(0.01, 0.01)]))).toBe(true);
  });

  it("does not mutate the input baskets", () => {
    const s = [leg(0.02, 0.08)], l = [leg(0, 0)];
    const sCopy = JSON.parse(JSON.stringify(s)), lCopy = JSON.parse(JSON.stringify(l));
    xsectionPriceAwareReturn(s, l, 5, 1);
    xsectionFundingOnlyReturn(s, l, 5, 1);
    expect(s).toEqual(sCopy);
    expect(l).toEqual(lCopy);
  });
});

// =================================================================================================
// REJECTION #2 — inter-exchange funding carry: the spread is too small vs fees.
// =================================================================================================
describe("REJECTION #2 — inter-exchange funding carry: uneconomic vs fees", () => {
  it("THE REJECTION: ~1.4 bp/day spread at 3 bp/side is uneconomic (net < the 3% bar)", () => {
    // EDGES.md: spread 1.4 bp/day → ~0.6% APR. We hold ~7d before amortizing the cross-venue round-trip.
    const e = interexchangeCarryEconomics(1.4, /*feeBpsPerSide*/ 3, /*holdDays*/ 7);
    expect(e.economic).toBe(false);
    expect(e.netAprPct).toBeLessThan(3);
    // gross is the ~5% headline; the fee drag on a 4-leg cross-venue round-trip eats most of it.
    expect(e.grossAprPct).toBeCloseTo(1.4 / 1e4 * 365 * 100, 4);
  });

  it("even at a generous 1 bp/side, a 1.4 bp/day spread held a week clears the bar — but 3 bp/side does NOT (boundary of the gate)", () => {
    const cheap = interexchangeCarryEconomics(1.4, 1, 7);
    const realistic = interexchangeCarryEconomics(1.4, 3, 7);
    // at 1bp/side the fee drag is small; the point of the rejection is REALISTIC (≥3bp) taker fees.
    expect(realistic.netAprPct).toBeLessThan(cheap.netAprPct);
    expect(realistic.economic).toBe(false);
  });

  it("MONOTONE in fee: higher per-side fee strictly lowers net APR", () => {
    const r = lcg(201);
    for (let t = 0; t < 60; t++) {
      const spread = between(r, 0.5, 5);
      const hold = between(r, 1, 30);
      const lo = interexchangeCarryEconomics(spread, 1, hold).netAprPct;
      const hi = interexchangeCarryEconomics(spread, 8, hold).netAprPct;
      expect(hi).toBeLessThan(lo);
    }
  });

  it("MONOTONE in spread: a wider spread can only raise net APR (the income side)", () => {
    const r = lcg(202);
    for (let t = 0; t < 60; t++) {
      const fee = between(r, 1, 6), hold = between(r, 3, 20);
      const narrow = interexchangeCarryEconomics(1.0, fee, hold).netAprPct;
      const wide = interexchangeCarryEconomics(5.0, fee, hold).netAprPct;
      expect(wide).toBeGreaterThan(narrow);
    }
  });

  it("MONOTONE in hold: holding longer amortizes the fixed round-trip → higher net APR", () => {
    const short = interexchangeCarryEconomics(1.4, 3, 1).netAprPct;
    const long = interexchangeCarryEconomics(1.4, 3, 30).netAprPct;
    expect(long).toBeGreaterThan(short); // same gross, smaller amortized fee drag
  });

  it("ECONOMIC SIGN: spread sign is irrelevant — you collect |spread| (short the higher-funding venue)", () => {
    const pos = interexchangeCarryEconomics(2.0, 2, 10);
    const neg = interexchangeCarryEconomics(-2.0, 2, 10);
    expect(pos.grossAprPct).toBeCloseTo(neg.grossAprPct, 12);
    expect(pos.netAprPct).toBeCloseTo(neg.netAprPct, 12);
  });

  it("a FAT spread DOES clear the bar (the gate isn't rigged to always reject) — guards against over-rejecting", () => {
    // if the venue spread were genuinely large (e.g. 20 bp/day), the carry would be economic; the
    // rejection is specifically about the REAL ~1.4 bp/day spread, not the structure itself.
    const fat = interexchangeCarryEconomics(20, 3, 7);
    expect(fat.economic).toBe(true);
    expect(fat.netAprPct).toBeGreaterThan(3);
  });

  it("BOUNDARY: net exactly at the minNetApr threshold counts as economic (≥, inclusive)", () => {
    // pick a spread that lands net ≈ exactly the bar at 0 fee (fee drag = 0): grossApr = minApr.
    // gross = spread/1e4*365*100 = 3 ⇒ spread = 3 / (365*100) * 1e4 = 0.8219 bp/day
    const spread = 3 / (365 * 100) * 1e4;
    const e = interexchangeCarryEconomics(spread, 0, 7, 3);
    expect(e.feeDragAprPct).toBe(0);
    expect(e.netAprPct).toBeCloseTo(3, 6);
    expect(e.economic).toBe(true); // ≥ is inclusive
  });

  it("DEGENERATE: zero spread → zero gross, net is purely negative fee drag, never economic", () => {
    const e = interexchangeCarryEconomics(0, 3, 7);
    expect(e.grossAprPct).toBe(0);
    expect(e.netAprPct).toBeLessThanOrEqual(0);
    expect(e.economic).toBe(false);
  });

  it("DEGENERATE: holdDays clamped at ≥1 (no divide-by-zero / no Infinity)", () => {
    const e = interexchangeCarryEconomics(1.4, 3, 0);
    expect(Number.isFinite(e.feeDragAprPct)).toBe(true);
    expect(Number.isFinite(e.netAprPct)).toBe(true);
  });
});

// =================================================================================================
// REJECTION #3 — basis roll-down TIMING: the fat-dte-band overlay adds no edge over full-life.
// =================================================================================================
describe("REJECTION #3 — basis roll-down timing: full-life beats the fat-band gate", () => {
  // Build a small synthetic cash-and-carry fixture via the TESTED primitive calendarBasisReturns:
  // a single contract converging linearly from a contango basis to ~0 at expiry. dte counts down.
  // We harvest the full-life carry, then test that gating to a "fat" dte band doesn't add Sharpe.
  function buildContract(days: number, startBasis: number): { spot: number[]; fut: number[]; dte: number[]; roll: boolean[] } {
    const spot: number[] = [], fut: number[] = [], dte: number[] = [], roll: boolean[] = [];
    for (let i = 0; i < days; i++) {
      const dteI = days - i; // counts down to ~1 at the last bar
      const s = 100; // flat spot → carry is PURE convergence, no price noise (isolates the timing claim)
      const basis = startBasis * (dteI / days); // basis shrinks linearly to ~0 at expiry
      spot.push(s);
      fut.push(s * (1 + basis));
      dte.push(dteI);
      roll.push(false); // single contract, no stitch seam
    }
    return { spot, fut, dte, roll };
  }

  const days = 90;
  const c = buildContract(days, 0.02); // 2% contango at entry, converging to 0
  const opts = { minBasisAnn: 0, feeBps: 0, tailSkip: 1, oneSided: true };
  const fullLife = calendarBasisReturns(c.spot, c.fut, c.dte, c.roll, opts);
  const dteAtEntry = c.dte.slice(0, fullLife.length); // dte observed at the entry of each realized bar

  it("the full-life carry is POSITIVE (a real convergence carry exists to harvest)", () => {
    expect(sum(fullLife)).toBeGreaterThan(0);
  });

  it("THE REJECTION: gating to the 'fat' dte band does NOT improve annualized Sharpe over full-life", () => {
    const fatBand = dteBandGatedReturns(fullLife, dteAtEntry, { lo: 30, hi: 90 });
    const shFull = sharpe(fullLife);
    const shBand = sharpe(fatBand);
    // The textbook claim is that the band IMPROVES Sharpe. On an honest linear-convergence carry it
    // does not — the per-day carry is uniform, so dropping days only sheds sample without raising
    // the mean/std ratio. Guard: the band's Sharpe is NOT meaningfully above full-life.
    expect(shBand).toBeLessThanOrEqual(shFull + 1e-9);
  });

  it("the band only REMOVES bars — every gated bar is either the full-life value or exactly 0", () => {
    const band = dteBandGatedReturns(fullLife, dteAtEntry, { lo: 30, hi: 60 });
    band.forEach((v, i) => expect(v === fullLife[i] || v === 0).toBe(true));
  });

  it("gating cannot ADD carry: total gated income ≤ total full-life income (for a positive carry)", () => {
    const band = dteBandGatedReturns(fullLife, dteAtEntry, { lo: 45, hi: 90 });
    expect(sum(band)).toBeLessThanOrEqual(sum(fullLife) + 1e-12);
  });

  it("carry/day-AT-RISK is ~flat across dte (the premise of the 'fat band' is false on uniform convergence)", () => {
    // near band vs far band: per-day-at-risk carry should be close, NOT dramatically fatter far out.
    const near = carryPerDayAtRisk(dteBandGatedReturns(fullLife, dteAtEntry, { lo: 1, hi: 30 }));
    const far = carryPerDayAtRisk(dteBandGatedReturns(fullLife, dteAtEntry, { lo: 60, hi: 90 }));
    // both positive, and the far band is not more than ~2× the near band — no fat-band edge.
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near * 2);
  });

  it("NO-LOOKAHEAD: perturbing a FUTURE full-life return never changes an earlier gated value", () => {
    const k = 60;
    const base = dteBandGatedReturns(fullLife, dteAtEntry, { lo: 10, hi: 90 });
    const perturbed = [...fullLife];
    perturbed[k] = perturbed[k] + 5; // blow up a future bar
    const pert = dteBandGatedReturns(perturbed, dteAtEntry, { lo: 10, hi: 90 });
    for (let i = 0; i < k; i++) expect(pert[i]).toBe(base[i]);
  });

  it("NO-LOOKAHEAD: perturbing dte[k] only changes the gated output at index k", () => {
    const k = 40;
    const base = dteBandGatedReturns(fullLife, dteAtEntry, { lo: 30, hi: 60 });
    const dte2 = [...dteAtEntry];
    dte2[k] = -999; // force it out of band
    const pert = dteBandGatedReturns(fullLife, dte2, { lo: 30, hi: 60 });
    for (let i = 0; i < base.length; i++) {
      if (i !== k) expect(pert[i]).toBe(base[i]);
    }
  });

  it("BOUNDARY: band edges are inclusive (dte == lo and dte == hi are kept)", () => {
    const rets = [1, 1, 1, 1, 1];
    const dte = [10, 20, 30, 40, 50];
    const g = dteBandGatedReturns(rets, dte, { lo: 20, hi: 40 });
    expect(g).toEqual([0, 1, 1, 1, 0]); // 20 and 40 inclusive; 10 and 50 dropped
  });

  it("DEGENERATE: non-finite dte zeroes that bar (NaN/undefined are never 'in band')", () => {
    const rets = [1, 1, 1, 1];
    const dte = [NaN, undefined as unknown as number, Infinity, 25];
    const g = dteBandGatedReturns(rets, dte, { lo: 0, hi: 100 });
    expect(g).toEqual([0, 0, 0, 1]);
  });

  it("DEGENERATE: an empty stream gates to an empty stream; carryPerDayAtRisk([]) === 0", () => {
    expect(dteBandGatedReturns([], [], { lo: 0, hi: 1 })).toEqual([]);
    expect(carryPerDayAtRisk([])).toBe(0);
    expect(carryPerDayAtRisk([0, 0, 0])).toBe(0); // all-flat → 0, no div-by-zero
  });

  it("a band that covers the whole dte range reproduces the full-life stream exactly (identity)", () => {
    const g = dteBandGatedReturns(fullLife, dteAtEntry, { lo: -1, hi: 1e9 });
    expect(g).toEqual([...fullLife]);
  });

  it("does not mutate inputs", () => {
    const rets = [1, 2, 3], dte = [10, 20, 30];
    const rCopy = [...rets], dCopy = [...dte];
    dteBandGatedReturns(rets, dte, { lo: 0, hi: 100 });
    expect(rets).toEqual(rCopy);
    expect(dte).toEqual(dCopy);
  });
});

// =================================================================================================
// META — the unifying lesson: a LOOSE-hedge carry is a directional bet in disguise.
// =================================================================================================
describe("META — carry is real only when the hedge is tight (the rejections share one root cause)", () => {
  it("loose-basket (xsection) carry's honest return is dominated by price, not funding", () => {
    // construct a bar where funding is modest but price dispersion is large → price term dominates.
    const shorts = [leg(0.001, 0.20)]; // tiny funding, huge pump
    const longs = [leg(0.0, -0.05)];   // no funding, dropping
    const honest = xsectionPriceAwareReturn(shorts, longs);
    const fundingTerm = 0.001 - 0.0;
    const priceTerm = -0.20 + -0.05;
    expect(honest).toBeCloseTo(fundingTerm + priceTerm, 12);
    // |price term| ≫ |funding term| ⇒ this is a directional bet, not a carry.
    expect(Math.abs(priceTerm)).toBeGreaterThan(Math.abs(fundingTerm) * 50);
    expect(honest).toBeLessThan(0);
  });

  it("the tight, single-name carry primitives stay positive where the loose basket fails (sanity contrast)", () => {
    // inter-exchange at a REAL spread is just uneconomic, not negative-on-price — both are 'do not run',
    // but for different honest reasons. This asserts the two rejection mechanisms are distinct.
    const looseNegative = xsectionPriceAwareReturn([leg(0.02, 0.10)], [leg(0, 0)]); // negative on price
    const xvenueUneconomic = interexchangeCarryEconomics(1.4, 3, 7);                 // positive-but-tiny
    expect(looseNegative).toBeLessThan(0);
    expect(xvenueUneconomic.grossAprPct).toBeGreaterThan(0); // gross IS positive
    expect(xvenueUneconomic.economic).toBe(false);           // but doesn't clear costs
  });
});
