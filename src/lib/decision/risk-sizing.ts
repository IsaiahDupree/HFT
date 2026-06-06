/**
 * risk-sizing — uncertainty-/risk-budget-adjusted SIZE SCALING the audit found missing (the system had fixed
 * caps + a pass-through riskGate, no continuous size scaling). This returns a multiplier ∈ [0,1] that shrinks a
 * base (fractional-Kelly) size as risk budget is consumed, instead of a binary reject/pass:
 *   • DRAWDOWN cushion — shrink toward 0 as today's losses approach the daily loss cap;
 *   • CORRELATION headroom — shrink as correlated exposure approaches its cap (don't pile into one bet);
 *   • LIQUIDITY — never be more than a small fraction of available depth (you can't fill/unwind otherwise).
 * Constraints COMPOUND (product). Pure: callers supply live state; missing inputs simply don't constrain.
 * Policy: NEVER martingale — this only ever REDUCES size as risk rises; it cannot scale up to recover losses.
 */

export type RiskState = {
  sizeUsd: number;
  dailyPnlUsd?: number;             // today's realized+unrealized P&L (negative = losing)
  dailyLossCapUsd?: number;         // the daily loss limit (from RiskBudget)
  correlatedExposureUsd?: number;   // current exposure correlated with this trade
  maxCorrelatedExposureUsd?: number;
  liquidityUsd?: number;            // available depth for the fill
  maxFracOfDepth?: number;          // cap size at this fraction of depth (default 10%)
};

export function riskAdjustedMultiplier(s: RiskState): { multiplier: number; reasons: string[] } {
  let m = 1; const reasons: string[] = [];
  if (s.dailyPnlUsd != null && s.dailyLossCapUsd && s.dailyLossCapUsd > 0) {
    const loss = Math.max(0, -s.dailyPnlUsd);
    const cushion = Math.max(0, 1 - loss / s.dailyLossCapUsd);
    m *= cushion; if (cushion < 1) reasons.push(`drawdown cushion ${(cushion * 100).toFixed(0)}% (lost $${loss.toFixed(0)} of $${s.dailyLossCapUsd} cap)`);
  }
  if (s.correlatedExposureUsd != null && s.maxCorrelatedExposureUsd && s.maxCorrelatedExposureUsd > 0) {
    const head = Math.max(0, 1 - s.correlatedExposureUsd / s.maxCorrelatedExposureUsd);
    m *= head; if (head < 1) reasons.push(`correlation headroom ${(head * 100).toFixed(0)}%`);
  }
  if (s.liquidityUsd != null && s.liquidityUsd > 0 && s.sizeUsd > 0) {
    const maxFrac = s.maxFracOfDepth ?? 0.1;
    const fit = Math.min(1, (maxFrac * s.liquidityUsd) / s.sizeUsd);
    m *= fit; if (fit < 1) reasons.push(`liquidity-capped to ${(maxFrac * 100).toFixed(0)}% of $${(s.liquidityUsd / 1000).toFixed(0)}k depth`);
  }
  return { multiplier: Math.max(0, Math.min(1, m)), reasons: reasons.length ? reasons : ["full risk budget available"] };
}

/** Apply the multiplier to a base size (rounded; never negative). */
export const applyRiskSizing = (baseSizeUsd: number, s: RiskState): number => Math.max(0, Math.round(baseSizeUsd * riskAdjustedMultiplier({ ...s, sizeUsd: s.sizeUsd || baseSizeUsd }).multiplier));
