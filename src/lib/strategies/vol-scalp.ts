/**
 * Volatility-scalp detector — Model B from selective-micro-edges PRD.
 *
 * Long-straddle profile on Polymarket binaries: buy BOTH Up and Down at
 * roughly even prices, then sell the winning side after a directional
 * move expands the price gap.
 *
 *   Buy Up at $0.49 + Down at $0.49 → cost $0.98
 *   BTC spikes up: Up → $0.70, Down → $0.28
 *   Sell Up at $0.70, hold or sell Down → realized depends on exit timing
 *
 * Profitable when REALIZED vol over the holding window exceeds IMPLIED
 * vol baked into the entry premium. This is the same logic as options
 * straddles — buy vol when implied < realized.
 *
 * v1 ships as RESEARCH-ONLY (no live execution). Signals get journaled
 * to evolution_log for operator review. Live execution deferred to v2
 * after backtest validates the thesis on real Polymarket historicals.
 *
 * Detector inputs:
 *   - Current Up + Down best-asks
 *   - Recent underlying-price ticks for realized vol estimation
 *   - Time remaining in the window
 *
 * Decision math:
 *   entry_premium  = up_ask + down_ask − $1     (the cost above guaranteed payout)
 *   sigma_per_min  = stdev(per-tick log returns) × sqrt(ticks_per_min)
 *   expected_move  = sigma_per_min × sqrt(remaining_min)
 *
 *   Fire when expected_move > entry_premium / sensitivity_factor
 *   (sensitivity_factor accounts for the fact that a 1σ move doesn't
 *   monetize 1:1 — much of the move shows up at resolution, not mid-window)
 *
 * Pure function. No I/O.
 */

export type ScalpTick = { ts: number; price: number };

export type VolScalpSnapshot = {
  conditionId: string;
  asset: string;
  windowCloseMs: number;
  nowMs: number;
  /** Best-ask on UP outcome (cost to BUY 1 UP share). */
  upBestAsk: number;
  /** Best-ask on DOWN outcome. */
  downBestAsk: number;
  /** Recent underlying-price ticks (used for realized vol estimation). */
  recentTicks: readonly ScalpTick[];
  /** Estimated round-trip fee bps applied to both legs. */
  feeBps?: number;
};

export type VolScalpOpportunity = {
  conditionId: string;
  asset: string;
  combined_cost: number;
  /** combined_cost − 1: the premium paid over the guaranteed-payout floor. */
  entry_premium: number;
  /** Estimated remaining-window vol in price units. */
  expected_underlying_move_pct: number;
  /**
   * Estimated EV from a vol-scalp scenario where the underlying moves
   * `expected_underlying_move_pct` and we exit the winning side at a
   * proportional price expansion. Rough — backtest will refine.
   */
  estimated_payoff_usd: number;
  /** payoff / cost. */
  estimated_roi: number;
  remaining_min: number;
  fee_adjustment: number;
  reason: string;
};

export type VolScalpOptions = {
  /** Minimum entry-premium to consider; below this it's nearer arb territory. Default 0.01. */
  minPremium?: number;
  /** Maximum entry-premium; above this the cost overwhelms even strong moves. Default 0.10. */
  maxPremium?: number;
  /** Minimum minutes remaining to enter. Default 2.0 (need time for vol to materialize). */
  minRemainingMin?: number;
  /** Maximum minutes remaining — past this the time-decay flips against us. Default 30.0. */
  maxRemainingMin?: number;
  /** Minimum ticks needed for vol estimation. Default 20. */
  minTicks?: number;
  /** Sensitivity factor — expected move must exceed premium / this to fire. Default 1.5. */
  sensitivityFactor?: number;
  /** Round-trip fee bps. Default 20. */
  feeBps?: number;
};

const D = {
  minPremium: 0.01,
  maxPremium: 0.10,
  minRemainingMin: 2.0,
  maxRemainingMin: 30.0,
  minTicks: 20,
  sensitivityFactor: 1.5,
  feeBps: 20,
};

export function detectVolScalp(
  snap: VolScalpSnapshot,
  opts: VolScalpOptions = {},
): VolScalpOpportunity | null {
  const minPremium = opts.minPremium ?? D.minPremium;
  const maxPremium = opts.maxPremium ?? D.maxPremium;
  const minRemainingMin = opts.minRemainingMin ?? D.minRemainingMin;
  const maxRemainingMin = opts.maxRemainingMin ?? D.maxRemainingMin;
  const minTicks = opts.minTicks ?? D.minTicks;
  const sensitivity = opts.sensitivityFactor ?? D.sensitivityFactor;
  const feeBps = opts.feeBps ?? snap.feeBps ?? D.feeBps;

  // Price sanity
  if (!Number.isFinite(snap.upBestAsk) || !Number.isFinite(snap.downBestAsk)) return null;
  if (snap.upBestAsk <= 0 || snap.upBestAsk >= 1) return null;
  if (snap.downBestAsk <= 0 || snap.downBestAsk >= 1) return null;

  // Time gates
  const remainingMs = snap.windowCloseMs - snap.nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const remainingMin = remainingMs / 60_000;
  if (remainingMin < minRemainingMin || remainingMin > maxRemainingMin) return null;

  // Premium gates
  const combinedCost = snap.upBestAsk + snap.downBestAsk;
  const entryPremium = combinedCost - 1;
  if (entryPremium < minPremium || entryPremium > maxPremium) return null;

  // Vol estimation from underlying ticks
  if (snap.recentTicks.length < minTicks) return null;
  const ticks = snap.recentTicks;
  const logReturns: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1]!.price;
    const curr = ticks[i]!.price;
    if (prev <= 0 || curr <= 0 || !Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < minTicks - 1) return null;

  const meanRet = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance = logReturns.reduce((s, x) => s + (x - meanRet) ** 2, 0) / Math.max(1, logReturns.length - 1);
  const sigmaPerTick = Math.sqrt(variance);

  // Per-minute sigma — assume even tick spacing
  const tickSpanMs = ticks[ticks.length - 1]!.ts - ticks[0]!.ts;
  if (!Number.isFinite(tickSpanMs) || tickSpanMs <= 0) return null;
  const ticksPerMin = (ticks.length - 1) * 60_000 / tickSpanMs;
  const sigmaPerMin = sigmaPerTick * Math.sqrt(ticksPerMin);

  // Expected move % over remaining window (relative magnitude in log space ≈ pct)
  const expectedMovePct = sigmaPerMin * Math.sqrt(remainingMin);

  // Heuristic payoff: a 1σ underlying move tends to expand the winning
  // side's price by ~30% of the move size (rough), but we don't capture
  // the full $1 at resolution because we'd exit before then. So:
  //   estimated_payoff ≈ 0.3 × expected_move_pct − fees
  const feeAdjustment = (feeBps * 2) / 10_000; // round-trip on each leg
  const estimatedPayoff = 0.3 * expectedMovePct - feeAdjustment;

  // Fire only when payoff exceeds premium with a sensitivity buffer.
  // The factor accounts for the fact that we don't always nail the exit timing.
  if (estimatedPayoff < entryPremium * sensitivity) return null;

  const estimatedRoi = estimatedPayoff / combinedCost;

  return {
    conditionId: snap.conditionId,
    asset: snap.asset,
    combined_cost: combinedCost,
    entry_premium: entryPremium,
    expected_underlying_move_pct: expectedMovePct,
    estimated_payoff_usd: estimatedPayoff,
    estimated_roi: estimatedRoi,
    remaining_min: remainingMin,
    fee_adjustment: feeAdjustment,
    reason:
      `${snap.asset} vol-scalp: combined ${(combinedCost * 100).toFixed(1)}¢ (premium +${(entryPremium * 100).toFixed(1)}¢) ` +
      `expected vol ${(expectedMovePct * 100).toFixed(2)}% over ${remainingMin.toFixed(1)}m → est payoff $${estimatedPayoff.toFixed(3)} (sensitivity x${sensitivity})`,
  };
}
