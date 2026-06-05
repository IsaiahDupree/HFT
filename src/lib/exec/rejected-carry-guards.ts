/**
 * rejected-carry-guards — the executable WHY behind three carry candidates that were TESTED and
 * REJECTED (see docs/EDGES.md "Tested and rejected"). Each pure helper re-creates, in miniature, the
 * honest accounting that killed the candidate, so a future "fix" that silently un-rejects a dead edge
 * trips a regression guard instead of shipping.
 *
 * The unifying lesson (EDGES.md "carry is real only when the hedge is tight"):
 *   a "carry" hedged by a LOOSE basket (different coins / different venue / a timing overlay) is a
 *   directional bet in disguise. The funding-ONLY view shows a fat Sharpe; the PRICE-AWARE view that
 *   actually moves the legs shows the basket doesn't cancel and the income doesn't clear costs.
 *
 * All functions are pure, deterministic, and NO-LOOKAHEAD where they consume a time series (the value
 * at bar i depends only on inputs ≤ i; realized over i→i+1).
 */

const finite = (x: number | undefined): x is number => x != null && Number.isFinite(x);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// REJECTION #1 — cross-sectional funding "carry" (short top-funding / long bottom-funding basket).
// Funding-only model: BUY (Sharpe ~8.9). Price-aware model (real long/short basket P&L): −65%,
// STAND_ASIDE. The baskets DON'T cancel — shorting pumped high-funding alts loses more on PRICE than
// the funding pays. We expose BOTH views so a guard can assert the honest one is strictly worse, and
// negative on the very fixture (high funding ↔ price pump) that defines the trap.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** One bar of a cross-sectional book: the SHORT basket (top funding) and LONG basket (bottom funding). */
export type XsectionLeg = {
  /** funding ACCRUED over the realized day on this leg (signed; SHORT collects +f, LONG pays it). */
  funding: number;
  /** simple PRICE return of the coin over the realized day (e.g. +0.08 = +8%). */
  priceRet: number;
};

/**
 * FUNDING-ONLY cross-sectional carry return for one bar — the OPTIMISTIC model that got the BUY.
 * Equal-weight, notional-balanced: you collect the shorts' funding and pay the longs' funding, and
 * the price legs are ASSUMED to cancel (they are simply ignored here — that omission is the trap).
 *   ret = mean(shortFunding) − mean(longFunding) − fee·turnover
 */
export function xsectionFundingOnlyReturn(
  shortBasket: readonly XsectionLeg[],
  longBasket: readonly XsectionLeg[],
  feeBps = 0,
  turnover = 0,
): number {
  const mean = (a: readonly XsectionLeg[], f: (l: XsectionLeg) => number) =>
    a.length ? a.reduce((s, l) => s + f(l), 0) / a.length : 0;
  const income = mean(shortBasket, (l) => l.funding) - mean(longBasket, (l) => l.funding);
  return income - turnover * (feeBps / 1e4);
}

/**
 * PRICE-AWARE cross-sectional carry return for one bar — the HONEST model. Same funding income, but
 * now the directional price legs are actually realized: a SHORT loses when its coin rises, a LONG
 * gains when its coin rises. net = fundingIncome + priceP&L − fee·turnover, where
 *   priceP&L = −mean(shortPriceRet) + mean(longPriceRet)   (short loses on a pump, long gains)
 * This is the version that came out −65%: high-funding coins are high BECAUSE they're being bid up,
 * so the short leg's price loss swamps the funding it collects.
 */
export function xsectionPriceAwareReturn(
  shortBasket: readonly XsectionLeg[],
  longBasket: readonly XsectionLeg[],
  feeBps = 0,
  turnover = 0,
): number {
  const mean = (a: readonly XsectionLeg[], f: (l: XsectionLeg) => number) =>
    a.length ? a.reduce((s, l) => s + f(l), 0) / a.length : 0;
  const fundingIncome = mean(shortBasket, (l) => l.funding) - mean(longBasket, (l) => l.funding);
  const pricePnL = -mean(shortBasket, (l) => l.priceRet) + mean(longBasket, (l) => l.priceRet);
  return fundingIncome + pricePnL - turnover * (feeBps / 1e4);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// REJECTION #2 — inter-exchange funding carry (Binance − OKX). The venue funding SPREAD is small
// (~1.4 bp/day, mostly arbed away) → ~0.6% APR, uneconomic once you pay BOTH perp legs. Below is the
// break-even economics: collect |spread| per interval, pay a round-trip on the two perp legs, hold.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type InterexchangeEconomics = {
  grossAprPct: number;   // |spread|/day × 365, in %
  feeDragAprPct: number; // amortized round-trip (2 venues × 2 sides ÷ holdDays), in %/yr
  netAprPct: number;
  economic: boolean;     // netApr ≥ minNetAprPct
};

/**
 * Inter-exchange (perp-vs-perp) funding-arb economics for ONE name.
 * @param spreadBpPerDay  observed |Binance − OKX| daily funding spread, in bps/day
 * @param feeBpsPerSide   per-leg taker fee, bps; a cross-venue entry+exit touches 4 legs total
 *                        (long one venue + short the other, then unwind both)
 * @param holdDays        how long the spread is collected before the round-trip is amortized over
 * @param minNetAprPct    the economic bar (default 3% — below this it isn't worth the operational risk)
 */
export function interexchangeCarryEconomics(
  spreadBpPerDay: number,
  feeBpsPerSide: number,
  holdDays: number,
  minNetAprPct = 3,
): InterexchangeEconomics {
  const grossAprPct = Math.abs(spreadBpPerDay) / 1e4 * 365 * 100;
  // cross-venue round-trip = 4 leg-fills (2 venues × open+close), amortized over the hold.
  const feeDragAprPct = (4 * feeBpsPerSide) / 1e4 * (365 / Math.max(holdDays, 1)) * 100;
  const netAprPct = grossAprPct - feeDragAprPct;
  return {
    grossAprPct: +grossAprPct.toFixed(4),
    feeDragAprPct: +feeDragAprPct.toFixed(4),
    netAprPct: +netAprPct.toFixed(4),
    economic: netAprPct >= minNetAprPct,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// REJECTION #3 — basis roll-down TIMING. The textbook claim: enter only in the "fat" days-to-expiry
// band (where annualized basis is larger) to earn more carry/day. FALSIFIED: holding the FULL contract
// life is best; the band gate just sheds days-at-risk without improving Sharpe. We expose a pure
// dte-band gate over an already-realized full-life carry stream so a guard can assert the timing
// overlay adds no edge on a fixture where carry is uniform across dte (the honest null).
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply a days-to-expiry band gate to a realized full-life carry stream: keep bar i's return only when
 * the dte OBSERVED at entry of bar i is inside [lo, hi]; otherwise the book is flat that bar (0).
 * NO-LOOKAHEAD: the gate reads only dte[i] (known at entry), never anything from i+1.
 * @param fullLifeRets  per-bar returns of the full-life book (rets[i] earned over bar i→i+1)
 * @param dteAtEntry    days-to-expiry observed at the ENTRY of each bar (same length as fullLifeRets)
 */
export function dteBandGatedReturns(
  fullLifeRets: readonly number[],
  dteAtEntry: readonly number[],
  band: { lo: number; hi: number },
): number[] {
  const n = Math.min(fullLifeRets.length, dteAtEntry.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dteAtEntry[i];
    const inBand = finite(d) && d >= band.lo && d <= band.hi;
    out.push(inBand ? fullLifeRets[i] : 0);
  }
  return out;
}

/** Mean return per day AT RISK (nonzero bars only) — the honest carry/day denominator. */
export function carryPerDayAtRisk(rets: readonly number[]): number {
  const atRisk = rets.filter((x) => x !== 0);
  return atRisk.length ? atRisk.reduce((s, x) => s + x, 0) / atRisk.length : 0;
}
