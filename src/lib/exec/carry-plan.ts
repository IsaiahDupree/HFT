/**
 * carry-plan — turn a funding-carry opportunity into a concrete, SAFE two-leg trade plan. The carry
 * is delta-neutral: collect funding on the PERP, neutralize price with a SPOT hedge of equal notional.
 *   • funding > 0 (longs pay)  → SHORT perp (collect) + LONG spot  (hedge by BUYING — no borrow needed)
 *   • funding < 0 (shorts pay) → LONG perp (collect)  + SHORT spot (needs spot BORROW — flagged harder)
 * Pure + deterministic: it computes legs + runs every safety check; it does NOT place orders (that's a
 * venue adapter, wired only after the operator confirms venue + goes live). Dry-run is the default
 * everywhere downstream.
 */

export type PerpVenue = "dydx" | "hyperliquid";
export type SpotVenue = "coinbase" | "binanceus";
export type Side = "short" | "long";

export type CarryOpp = {
  coin: string;
  fundingApr: number;      // signed annualized funding (positive = longs pay)
  persistence: number;     // 0.5..1, recent sign-stability
  perpVenue: PerpVenue;
  /** spot venues that LIST this asset (for the hedge leg). Empty ⇒ unhedgeable. */
  spotVenues: SpotVenue[];
};

export type Leg = { venue: string; instrument: string; action: "buy" | "sell"; positionSide: Side; notionalUsd: number };

export type CarryPlan = {
  coin: string;
  perpLeg: Leg;
  spotLeg: Leg | null;      // null ⇒ could not hedge (directional — blocked unless allowUnhedged)
  deltaNeutral: boolean;
  expectedDailyCarryBp: number;   // |funding|/365 in bps, NET of an amortized round-trip
  expectedAprNet: number;
  checks: string[];               // passed
  blockers: string[];             // must be empty to be executable
};

export type CarryLimits = {
  maxNotionalPerName: number;     // cap per coin
  maxTotalNotional: number;       // book cap
  minPersistence: number;         // reject transient funding
  minNetApr: number;              // reject after-fee-uneconomic
  feeBpsPerSide: number;          // round-trip = 2× this, amortized over holdDays
  holdDays: number;
  allowUnhedged: boolean;         // default false — never run a "carry" naked
  allowSpotBorrow: boolean;       // long-perp side needs spot borrow; default false
};

export const DEFAULT_LIMITS: CarryLimits = {
  maxNotionalPerName: 1_000, maxTotalNotional: 5_000, minPersistence: 0.7, minNetApr: 15,
  feeBpsPerSide: 5, holdDays: 14, allowUnhedged: false, allowSpotBorrow: false,
};

/** Build the two-leg plan for one opportunity at `capitalUsd` notional. Runs all safety checks. */
export function planCarryLegs(opp: CarryOpp, capitalUsd: number, limits: CarryLimits = DEFAULT_LIMITS): CarryPlan {
  const checks: string[] = [], blockers: string[] = [];
  const notional = Math.min(capitalUsd, limits.maxNotionalPerName);
  const longsPay = opp.fundingApr >= 0;
  const perpSide: Side = longsPay ? "short" : "long";   // take the funding-RECEIVING side
  const spotSide: Side = longsPay ? "long" : "short";   // opposite, to neutralize price

  const grossDailyBp = Math.abs(opp.fundingApr) / 365 * 100;
  const feeDragBp = (2 * limits.feeBpsPerSide) / limits.holdDays; // one round-trip amortized over the hold
  const netDailyBp = grossDailyBp - feeDragBp;
  const netApr = netDailyBp * 365 / 100;

  // hedge leg
  const spotVenue = opp.spotVenues[0];
  let spotLeg: Leg | null = null;
  if (spotVenue) {
    spotLeg = { venue: spotVenue, instrument: `${opp.coin}-USD`, action: spotSide === "long" ? "buy" : "sell", positionSide: spotSide, notionalUsd: notional };
    checks.push(`hedge: ${spotSide} ${opp.coin} spot on ${spotVenue}`);
  }

  // ---- safety gates ----
  if (opp.persistence < limits.minPersistence) blockers.push(`persistence ${(opp.persistence * 100).toFixed(0)}% < ${limits.minPersistence * 100}% — funding too transient (carry trap)`);
  else checks.push(`persistence ${(opp.persistence * 100).toFixed(0)}% ✓`);
  if (netApr < limits.minNetApr) blockers.push(`net ${netApr.toFixed(0)}% APR < ${limits.minNetApr}% after ${limits.feeBpsPerSide}bp/side over ${limits.holdDays}d — uneconomic`);
  else checks.push(`net ${netApr.toFixed(0)}% APR ✓`);
  if (notional > limits.maxNotionalPerName) blockers.push(`notional $${notional} > per-name cap $${limits.maxNotionalPerName}`);
  if (!spotLeg && !limits.allowUnhedged) blockers.push(`no spot venue lists ${opp.coin} — cannot hedge; refuse to run a carry NAKED (set allowUnhedged to override)`);
  if (spotSide === "short" && !limits.allowSpotBorrow) blockers.push(`this side needs SPOT BORROW (short spot) — disabled (allowSpotBorrow=false); only positive-funding/long-spot carries run by default`);

  return {
    coin: opp.coin,
    perpLeg: { venue: opp.perpVenue, instrument: `${opp.coin}-USD`, action: perpSide === "short" ? "sell" : "buy", positionSide: perpSide, notionalUsd: notional },
    spotLeg,
    deltaNeutral: !!spotLeg,
    expectedDailyCarryBp: +netDailyBp.toFixed(2), expectedAprNet: +netApr.toFixed(1),
    checks, blockers,
  };
}

/** Book-level safety: total notional across plans, and only executable (no-blocker) plans count. */
export function bookSafetyCheck(plans: readonly CarryPlan[], limits: CarryLimits = DEFAULT_LIMITS): { executable: CarryPlan[]; totalNotional: number; bookBlockers: string[] } {
  const executable = plans.filter((p) => p.blockers.length === 0);
  const totalNotional = executable.reduce((a, p) => a + p.perpLeg.notionalUsd, 0);
  const bookBlockers: string[] = [];
  if (totalNotional > limits.maxTotalNotional) bookBlockers.push(`book notional $${totalNotional} > cap $${limits.maxTotalNotional}`);
  return { executable, totalNotional, bookBlockers };
}
