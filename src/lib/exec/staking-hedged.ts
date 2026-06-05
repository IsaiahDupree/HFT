/**
 * staking-hedged — the economics of a DELTA-NEUTRAL STAKING-YIELD CARRY, extracted as a pure lib.
 *
 * THE EDGE: stake spot (ETH ≈3.2%/yr, SOL ≈7%/yr) to earn the protocol yield, then DELTA-HEDGE that
 * long spot with a SHORT perp so the price legs cancel. What's left is the staking yield as a near-cash,
 * market-neutral return. BONUS: the short perp ALSO settles funding — when funding is POSITIVE the short
 * COLLECTS it (staking yield + funding tailwind); when funding is NEGATIVE the short PAYS it (a drag).
 *
 * NET (NO-LOOKAHEAD), per funding period i:
 *     net[i] = stakeYieldPerPeriod  +  fundingCollectedByShort[i]  −  feeDragPerPeriod  −  costPerPeriod  −  entry[i]
 * where fundingCollectedByShort[i] = +funding[i] (short receives positive funding, pays negative), and
 * funding[i] is the rate SETTLED at period i (known at i, applied over i — standard funding convention).
 * The two price legs cancel (that cancellation IS the hedge) so no price series is needed. Period i depends
 * ONLY on inputs ≤ i (the static hedge is decided ≤ i, funding[i] is i's own settled print) — strictly causal.
 *
 * THE HONEST OMISSIONS (this is a "near-cash" carry that has TAIL RISK the headline yield hides):
 *   • UNBOND-QUEUE ILLIQUIDITY — staked spot cannot be sold instantly; the validator exit queue (days→weeks)
 *     means the hedge can drift naked while you wait, an expected cost charged as `unbondBpsYr`.
 *   • SLASHING — a validator fault burns principal; charged as `slashingBpsYr` (expected annual loss).
 *   • LST DEPEG — the liquid-staking token (stETH/jitoSOL) can trade below the underlying, a mark-to-market
 *     loss on the hedge leg; charged as `depegBpsYr`.
 * These are EXPLICIT penalty params (default 0 — the script must opt INTO honesty), and applying any of them
 * can only LOWER the net yield. They are the difference between the marketed APR and the risk-adjusted APR.
 */

const PERIODS_PER_YEAR_DEFAULT = 365; // daily funding buckets (3× 8-hourly Binance prints summed per UTC day)
const BPS = 1e4;

const finite = (x: number | undefined): x is number => x != null && Number.isFinite(x);

/** The omitted-risk haircut, as explicit annualized penalties (bps/yr). All default to 0. */
export type RiskHaircut = {
  unbondBpsYr?: number;   // expected drag from being trapped in the unbond/exit queue (hedge can go naked)
  slashingBpsYr?: number; // expected annual loss from validator slashing
  depegBpsYr?: number;    // expected mark-to-market drag from LST depeg vs the underlying
};

export type StakingHedgedParams = {
  /** annualized protocol staking yield, e.g. 0.032 for ETH, 0.07 for SOL. */
  stakeApy: number;
  /** extra continuous hedge-carry drag in bps/yr (0: the short funding already IS the perp cost/credit). */
  hedgeBpsYr?: number;
  /** one-time round-trip ENTRY cost (two legs) in bps, charged ONCE on the first period only. */
  entryBps?: number;
  /** funding periods per year (365 for daily buckets). */
  periodsPerYear?: number;
  /** the omitted-risk haircut — default all-zero (no haircut). */
  risk?: RiskHaircut;
};

/** Total annualized risk haircut (bps/yr → fraction/yr). Non-finite or negative components are clamped to 0. */
export function totalRiskHaircutYr(risk: RiskHaircut = {}): number {
  const clamp = (x: number | undefined) => (finite(x) && x > 0 ? x : 0);
  return (clamp(risk.unbondBpsYr) + clamp(risk.slashingBpsYr) + clamp(risk.depegBpsYr)) / BPS;
}

/**
 * Build the per-period delta-neutral STAKING-HEDGED net returns, NO-LOOKAHEAD.
 * @param dailyFunding the per-period SHORT-side funding cash flow: funding[i] is the rate the short collects
 *   over period i (positive = short receives, negative = short pays). Non-finite prints contribute 0 funding.
 * @returns one net-return value per input period (length-preserving).
 */
export function stakingHedgedReturns(dailyFunding: ReadonlyArray<number | undefined>, params: StakingHedgedParams): number[] {
  const periods = params.periodsPerYear ?? PERIODS_PER_YEAR_DEFAULT;
  const stakeYieldPerPeriod = params.stakeApy / periods;
  const feeDragPerPeriod = (params.hedgeBpsYr ?? 0) / BPS / periods;
  const haircutPerPeriod = totalRiskHaircutYr(params.risk) / periods;
  const entry = (params.entryBps ?? 0) / BPS;
  return dailyFunding.map((f, i) => {
    const fundingCollected = finite(f) ? f : 0;      // short receives +funding, pays −funding; bad print → 0
    const entryCost = i === 0 ? entry : 0;           // static hold ⇒ round-trip charged ONCE on entry
    return stakeYieldPerPeriod + fundingCollected - feeDragPerPeriod - haircutPerPeriod - entryCost;
  });
}

/**
 * CONTROL: plain funding carry — short-only funding cash flow, NO staking yield (same static hedge).
 * Used to answer "does the staking yield ADD to plain funding carry?". The risk haircut is staking-SPECIFIC
 * (unbond/slashing/depeg only exist because you staked), so the plain control carries NO haircut by default.
 */
export function plainFundingReturns(dailyFunding: ReadonlyArray<number | undefined>, params: Pick<StakingHedgedParams, "hedgeBpsYr" | "entryBps" | "periodsPerYear">): number[] {
  const periods = params.periodsPerYear ?? PERIODS_PER_YEAR_DEFAULT;
  const feeDragPerPeriod = (params.hedgeBpsYr ?? 0) / BPS / periods;
  const entry = (params.entryBps ?? 0) / BPS;
  return dailyFunding.map((f, i) => (finite(f) ? f : 0) - feeDragPerPeriod - (i === 0 ? entry : 0));
}

/** Annualized net APR of a per-period return series: mean per-period × periodsPerYear. */
export function annualizedApr(returns: readonly number[], periodsPerYear = PERIODS_PER_YEAR_DEFAULT): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, x) => a + x, 0) / returns.length;
  return mean * periodsPerYear;
}

export type FeeRobustness = {
  baseAprNet: number;        // net APR at the configured params
  stressAprNet: number;      // net APR after the extra stressBpsYr fee/cost is applied
  stressBpsYr: number;       // the stress applied
  minAprFloor: number;       // the floor it must stay above
  survives: boolean;         // stressAprNet ≥ minAprFloor
};

/**
 * FEE-ROBUSTNESS: does the carry still clear `minAprFloor` after an EXTRA `stressBpsYr` of annual cost?
 * (e.g. wider perp spreads, higher borrow, an unmodeled hedge slippage). Monotone: more stress ⇒ lower
 * stressAprNet ⇒ harder to survive.
 */
export function feeRobustness(
  dailyFunding: ReadonlyArray<number | undefined>,
  params: StakingHedgedParams,
  stressBpsYr: number,
  minAprFloor = 0,
): FeeRobustness {
  const periods = params.periodsPerYear ?? PERIODS_PER_YEAR_DEFAULT;
  const base = stakingHedgedReturns(dailyFunding, params);
  const stress = Math.max(0, finite(stressBpsYr) ? stressBpsYr : 0);
  // applying the stress as additional hedgeBpsYr on top of whatever drag is already configured
  const stressed = stakingHedgedReturns(dailyFunding, { ...params, hedgeBpsYr: (params.hedgeBpsYr ?? 0) + stress });
  const baseAprNet = annualizedApr(base, periods);
  const stressAprNet = annualizedApr(stressed, periods);
  return { baseAprNet, stressAprNet, stressBpsYr: stress, minAprFloor, survives: stressAprNet >= minAprFloor };
}
