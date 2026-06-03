/**
 * Edge-decay change-point detection — the meta-layer's "detect when a strategy
 * STOPS working" (the research's biggest confirmed gap: no change-point detector
 * existed anywhere in src). Streaming Page-Hinkley + two-sided CUSUM on a
 * per-strategy realized-PnL-per-trade (or per-period return) series. Catches the
 * decay AT the change-point — before a lagging "Sharpe < x for N days" rule fires,
 * so capital can be pulled at the regime shift, not after the strategy has bled out.
 *
 * Pure + deterministic (unit-testable like the decision gates). Feed it the PnL
 * stream; it returns whether the edge is decaying and the index where it broke.
 */

export type DecayResult = {
  /** A downward shift in the mean was detected. */
  decaying: boolean;
  /** Index of the FIRST observation where the Page-Hinkley statistic crossed λ
   *  (≈ where the edge broke), or null. */
  changePointIndex: number | null;
  /** Page-Hinkley statistic at the end (how far past the threshold). */
  phStatistic: number;
  /** Negative-side CUSUM at the end (corroborating downward drift). */
  cusumDown: number;
};

/**
 * Page-Hinkley test for a DOWNWARD shift in the mean of `x`, with a corroborating
 * negative CUSUM. `delta` = tolerance (ignore drops smaller than this), `lambda` =
 * detection threshold (scale with the magnitude of x: for ~1% per-trade returns,
 * λ ≈ 0.05–0.1). Both default conservatively; tune per series scale.
 */
export function detectEdgeDecay(x: number[], opts: { delta?: number; lambda?: number; minN?: number } = {}): DecayResult {
  const delta = opts.delta ?? 0;
  const lambda = opts.lambda ?? 0.05;
  const minN = opts.minN ?? 8;
  if (x.length < minN) return { decaying: false, changePointIndex: null, phStatistic: 0, cusumDown: 0 };

  // Page-Hinkley (decrease): accumulate (xₜ − running_mean + δ); track its running
  // MAX; the statistic is MAX − current. A sustained drop makes the current fall
  // below the prior max → statistic grows → alarm when it exceeds λ.
  let runMean = 0, mt = 0, maxMt = -Infinity;
  let cp: number | null = null;
  // One-sided NEGATIVE CUSUM: accumulates shortfalls vs the running mean, floored
  // at 0 (resets on recovery). Grows while the strategy underperforms its own history.
  let sNeg = 0;
  for (let t = 0; t < x.length; t++) {
    runMean = runMean + (x[t] - runMean) / (t + 1);
    mt += x[t] - runMean + delta;
    maxMt = Math.max(maxMt, mt);
    const ph = maxMt - mt;
    if (cp === null && ph > lambda) cp = t;
    sNeg = Math.max(0, sNeg - (x[t] - runMean));
  }
  return { decaying: cp !== null, changePointIndex: cp, phStatistic: maxMt - mt, cusumDown: sNeg };
}
