/**
 * Complement-sum arbitrage detector (Phase 12 of selective-micro-edges PRD).
 *
 * Polymarket binary markets pay $1 to the winning side and $0 to the loser.
 * When `Up_ask + Down_ask < $1`, buying ONE share of each side guarantees a
 * positive payout at resolution — regardless of which side actually wins.
 *
 *   profit_per_pair = $1 − (Up_ask + Down_ask) − fees − slippage
 *   roi             = profit_per_pair / (Up_ask + Down_ask)
 *
 * This is mechanical arbitrage. It does NOT require any predictive model
 * for direction. The only risks are:
 *   - Resolution risk (market resolves invalid / ambiguous)
 *   - Partial fill risk (one leg fills, the other doesn't → unhedged
 *     directional exposure)
 *   - Fee miscalibration (real settlement fees > what the detector assumed)
 *   - Slippage on either leg
 *
 * Pure function. The detector takes a market book snapshot and returns
 * a `ComplementArbOpportunity | null`. The scanner script + executor wrap
 * this; this module is the decision logic.
 *
 * Filters:
 *   - combined_cost ≤ max_combined (default 0.97 = 3pp gross profit floor)
 *   - net_profit_per_pair ≥ min_profit_usd (default $0.02 after fees)
 *   - time_to_resolve ≥ min_hold_min (default 1 — give settlement time)
 *   - max_pairs ≥ 1 (need enough depth to fill at least one pair)
 *   - Both asks > 0 AND < 1 (sanity)
 *
 * Safety: defaults are conservative. Operator can tighten via env (smaller
 * max_combined / larger min_profit) but loosening below the defaults is
 * not recommended without a real-fees audit first.
 */

export type BinaryBookSnapshot = {
  conditionId: string;
  title?: string;
  asset: string;
  /** Epoch ms when this market resolves. */
  windowCloseMs: number;
  /** Current epoch ms — must be < windowCloseMs. */
  nowMs: number;
  /** Best ask on the UP outcome (cost to BUY one UP share). */
  upBestAsk: number;
  /** Best ask on the DOWN outcome. */
  downBestAsk: number;
  /** USD-denominated depth at the best UP ask. */
  upDepthUsd: number;
  /** USD-denominated depth at the best DOWN ask. */
  downDepthUsd: number;
  /** Optional: round-trip fee in basis points. Used if opts.feeBps not supplied. */
  feeBps?: number;
};

export type ComplementArbOpportunity = {
  conditionId: string;
  title?: string;
  asset: string;
  /** upBestAsk + downBestAsk. */
  combined_cost: number;
  /** Gross profit per $1 winning payout = 1 − combined_cost. */
  gross_profit_per_pair: number;
  /** gross − fees. */
  net_profit_per_pair: number;
  /** net_profit / combined_cost. */
  roi: number;
  /** floor(min(upDepth, downDepth) / combined_cost). */
  max_pairs: number;
  /** Total USD capital required to take `max_pairs` pairs. */
  capital_required_usd: number;
  /** Total realized USD profit if all `max_pairs` settle. */
  total_profit_usd: number;
  /** Minutes until market resolves. */
  time_to_resolve_min: number;
  /** Fee adjustment used in calculation. */
  fee_adjustment: number;
  reason: string;
};

export type ComplementArbOptions = {
  /** Maximum combined cost to qualify. Default 0.97. */
  maxCombinedCost?: number;
  /** Minimum net profit per pair in USD. Default 0.02. */
  minProfitPerPair?: number;
  /** Minimum minutes to resolve. Default 1.0 (gives settlement time). */
  minHoldMinutes?: number;
  /** Round-trip fee in basis points, applied as a $-per-pair penalty. Default 20. */
  feeBps?: number;
};

const DEFAULTS = {
  maxCombinedCost: 0.97,
  minProfitPerPair: 0.02,
  minHoldMinutes: 1.0,
  feeBps: 20,
};

export function detectComplementSumArb(
  market: BinaryBookSnapshot,
  opts: ComplementArbOptions = {},
): ComplementArbOpportunity | null {
  const maxCombined = opts.maxCombinedCost ?? DEFAULTS.maxCombinedCost;
  const minProfit = opts.minProfitPerPair ?? DEFAULTS.minProfitPerPair;
  const minHoldMin = opts.minHoldMinutes ?? DEFAULTS.minHoldMinutes;
  const feeBps = opts.feeBps ?? market.feeBps ?? DEFAULTS.feeBps;

  // Sanity gates
  if (!Number.isFinite(market.upBestAsk) || !Number.isFinite(market.downBestAsk)) return null;
  if (market.upBestAsk <= 0 || market.upBestAsk >= 1) return null;
  if (market.downBestAsk <= 0 || market.downBestAsk >= 1) return null;
  if (!Number.isFinite(market.upDepthUsd) || !Number.isFinite(market.downDepthUsd)) return null;
  if (market.upDepthUsd <= 0 || market.downDepthUsd <= 0) return null;

  const remainingMs = market.windowCloseMs - market.nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const timeToResolveMin = remainingMs / 60_000;
  if (timeToResolveMin < minHoldMin) return null;

  const combinedCost = market.upBestAsk + market.downBestAsk;
  if (combinedCost > maxCombined) return null;
  if (combinedCost >= 1) return null;

  // Fee adjustment: round-trip fee on $1 nominal exposure per pair.
  const feeAdjustment = feeBps / 10_000;
  const grossProfit = 1 - combinedCost;
  const netProfit = grossProfit - feeAdjustment;
  if (netProfit < minProfit) return null;

  // Depth-constrained pair count. Use the SHALLOWER side as the binding
  // constraint — both legs must fill for the arbitrage to hold.
  const minSideDepth = Math.min(market.upDepthUsd, market.downDepthUsd);
  // Each pair requires combinedCost USD across both sides. The min-side
  // depth bounds the number of pairs because both legs are filled per pair.
  // The depth on one side bounds the asks-filled on that side; conservative
  // assumption is depth represents USD notional at best ask on that side.
  const maxPairs = Math.floor(minSideDepth / Math.max(market.upBestAsk, market.downBestAsk));
  if (maxPairs < 1) return null;

  const capitalRequired = maxPairs * combinedCost;
  const totalProfit = maxPairs * netProfit;
  const roi = netProfit / combinedCost;

  return {
    conditionId: market.conditionId,
    title: market.title,
    asset: market.asset,
    combined_cost: combinedCost,
    gross_profit_per_pair: grossProfit,
    net_profit_per_pair: netProfit,
    roi,
    max_pairs: maxPairs,
    capital_required_usd: capitalRequired,
    total_profit_usd: totalProfit,
    time_to_resolve_min: timeToResolveMin,
    fee_adjustment: feeAdjustment,
    reason:
      `${market.asset} combined ${(combinedCost * 100).toFixed(2)}¢ ` +
      `(Up ${(market.upBestAsk * 100).toFixed(1)}¢ + Down ${(market.downBestAsk * 100).toFixed(1)}¢) ` +
      `→ net profit $${netProfit.toFixed(3)}/pair · max ${maxPairs} pairs ($${capitalRequired.toFixed(2)} → $${totalProfit.toFixed(2)}) · ` +
      `${timeToResolveMin.toFixed(1)}m to resolve`,
  };
}
