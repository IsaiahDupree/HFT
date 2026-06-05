/**
 * calendar-plan — turn a dated-futures BASIS opportunity into a concrete, SAFE two-leg cash-and-carry plan.
 * A dated future trades at a premium (contango) or discount (backwardation) to spot, and that gap MUST go to
 * zero at delivery — so the basis convergence is the yield, and it is LOCKED by settlement (unlike funding,
 * which can flip). The trade is delta-neutral:
 *   • contango (future > spot)        → SHORT future (sell the premium) + LONG spot  (buy — NO borrow)
 *   • backwardation (future < spot)   → LONG future                    + SHORT spot (needs spot BORROW)
 * Pure + deterministic: computes legs + runs every safety check; places NO orders. The contrast with the
 * funding carry: NO persistence gate (convergence is guaranteed at expiry); instead we guard tenor (near-
 * expiry friction dominates), future liquidity, and the borrow requirement. The real residual risk is
 * INTERIM mark-to-market (the basis can widen before it converges) + capital lockup until delivery.
 */

export type FutureSide = "short" | "long";
export type SpotSide = "long" | "short";

export type CalendarOpp = {
  coin: string;
  futureSymbol: string;
  futurePrice: number;     // mark price of the dated future
  spotPrice: number;       // spot / index price
  dteDays: number;         // days to expiry/delivery
  futureOiUsd: number;     // open interest on the future (liquidity proxy)
  /** spot venues that LIST this asset for the hedge leg. Empty ⇒ unhedgeable. */
  spotVenues: string[];
};

export type Leg = { venue: string; instrument: string; action: "buy" | "sell"; positionSide: "short" | "long"; notionalUsd: number };

export type CalendarPlan = {
  coin: string;
  futureLeg: Leg;
  spotLeg: Leg | null;            // null ⇒ unhedgeable (blocked unless allowUnhedged)
  deltaNeutral: boolean;
  basisPct: number;               // raw (future/spot − 1) in %, signed (+ contango)
  annualizedBasisPct: number;     // basisPct × 365/dte, signed — the gross carry rate
  expectedNetBasisPct: number;    // convergence captured NET of all-in round-trip fees, over the hold
  expectedAprNet: number;         // net annualized
  dteDays: number;
  checks: string[];
  blockers: string[];
};

export type CalendarLimits = {
  maxNotionalPerName: number;
  maxTotalNotional: number;
  minNetApr: number;              // reject thin (after fees)
  minDteDays: number;             // reject near-expiry — friction dominates the tiny remaining basis
  maxDteDays: number;             // cap capital lockup
  feeBpsPerSide: number;          // per fill; cash-and-carry has ~4 fills (enter+exit, both legs)
  minFutureOiUsd: number;         // future liquidity floor
  allowUnhedged: boolean;         // never run naked by default
  allowSpotBorrow: boolean;       // backwardation needs short-spot/borrow; default false
};

export const DEFAULT_CAL_LIMITS: CalendarLimits = {
  maxNotionalPerName: 1_000, maxTotalNotional: 5_000, minNetApr: 6, minDteDays: 7, maxDteDays: 365,
  feeBpsPerSide: 5, minFutureOiUsd: 5_000_000, allowUnhedged: false, allowSpotBorrow: false,
};

/** Build the cash-and-carry plan for one dated-future opportunity. Runs all safety checks. */
export function planCalendarLegs(opp: CalendarOpp, capitalUsd: number, limits: CalendarLimits = DEFAULT_CAL_LIMITS): CalendarPlan {
  const checks: string[] = [], blockers: string[] = [];
  const notional = Math.min(capitalUsd, limits.maxNotionalPerName);
  const basis = opp.spotPrice > 0 ? opp.futurePrice / opp.spotPrice - 1 : 0;
  const contango = basis >= 0;
  const futureSide: FutureSide = contango ? "short" : "long";   // sell the premium / buy the discount
  const spotSide: SpotSide = contango ? "long" : "short";       // opposite, to neutralize price

  const basisPct = basis * 100;
  const annualizedBasisPct = opp.dteDays > 0 ? basisPct * 365 / opp.dteDays : 0;
  // all-in round-trip ≈ 4 fills (enter+exit on BOTH legs). Captured ONCE over the hold (convergence is one-shot).
  const allInFeePct = (4 * limits.feeBpsPerSide) / 100;
  const netBasisPct = Math.abs(basisPct) - allInFeePct;          // net convergence actually pocketed
  const netApr = opp.dteDays > 0 ? netBasisPct * 365 / opp.dteDays : 0;

  // hedge leg
  const spotVenue = opp.spotVenues[0];
  let spotLeg: Leg | null = null;
  if (spotVenue) {
    spotLeg = { venue: spotVenue, instrument: `${opp.coin}-USD`, action: spotSide === "long" ? "buy" : "sell", positionSide: spotSide, notionalUsd: notional };
    checks.push(`hedge: ${spotSide} ${opp.coin} spot on ${spotVenue}`);
  }

  // ---- safety gates (note: NO persistence gate — convergence is locked at delivery) ----
  if (opp.dteDays < limits.minDteDays) blockers.push(`${opp.dteDays.toFixed(0)}d to expiry < ${limits.minDteDays}d — too near; friction dominates the residual basis`);
  else checks.push(`${opp.dteDays.toFixed(0)}d to delivery ✓ (convergence locked at expiry)`);
  if (opp.dteDays > limits.maxDteDays) blockers.push(`${opp.dteDays.toFixed(0)}d to expiry > ${limits.maxDteDays}d — capital locked too long`);
  if (netApr < limits.minNetApr) blockers.push(`net ${netApr.toFixed(1)}% APR < ${limits.minNetApr}% after ${limits.feeBpsPerSide}bp/side ×4 fills over ${opp.dteDays.toFixed(0)}d — uneconomic`);
  else checks.push(`net ${netApr.toFixed(1)}% APR ✓`);
  if (opp.futureOiUsd < limits.minFutureOiUsd) blockers.push(`future OI $${(opp.futureOiUsd / 1e6).toFixed(1)}M < $${(limits.minFutureOiUsd / 1e6).toFixed(0)}M — too illiquid`);
  if (notional > limits.maxNotionalPerName) blockers.push(`notional $${notional} > per-name cap $${limits.maxNotionalPerName}`);
  if (!spotLeg && !limits.allowUnhedged) blockers.push(`no spot venue lists ${opp.coin} — cannot hedge; refuse to run a basis trade NAKED (set allowUnhedged to override)`);
  if (spotSide === "short" && !limits.allowSpotBorrow) blockers.push(`backwardation → needs SPOT BORROW (short spot) — disabled (allowSpotBorrow=false); only contango/long-spot runs by default`);

  return {
    coin: opp.coin,
    futureLeg: { venue: "deribit", instrument: opp.futureSymbol, action: futureSide === "short" ? "sell" : "buy", positionSide: futureSide, notionalUsd: notional },
    spotLeg,
    deltaNeutral: !!spotLeg,
    basisPct: +basisPct.toFixed(3),
    annualizedBasisPct: +annualizedBasisPct.toFixed(1),
    expectedNetBasisPct: +netBasisPct.toFixed(3),
    expectedAprNet: +netApr.toFixed(1),
    dteDays: opp.dteDays,
    checks, blockers,
  };
}

/** Book-level safety: total notional across plans; only executable (no-blocker) plans count. */
export function calendarBookCheck(plans: readonly CalendarPlan[], limits: CalendarLimits = DEFAULT_CAL_LIMITS): { executable: CalendarPlan[]; totalNotional: number; bookBlockers: string[] } {
  const executable = plans.filter((p) => p.blockers.length === 0);
  const totalNotional = executable.reduce((a, p) => a + p.futureLeg.notionalUsd, 0);
  const bookBlockers: string[] = [];
  if (totalNotional > limits.maxTotalNotional) bookBlockers.push(`book notional $${totalNotional} > cap $${limits.maxTotalNotional}`);
  return { executable, totalNotional, bookBlockers };
}
