/**
 * Meta-layer: strategy-of-strategies COMBINATION + DETECTION.
 *
 * The recurring lesson of this system is that independence is the scarcest
 * resource (the allocator's correlation veto, the signal-agreement gate's
 * unique-cluster counting, the Deflated-Sharpe's trial deflation all fight the
 * same enemy: being fooled by correlated copies of one bet). This module applies
 * that at the strategy level:
 *
 *   COMBINE  — de-correlated inverse-vol (risk-parity-lite) allocation across N
 *              strategies. A strategy correlated with the rest is down-weighted;
 *              an uncorrelated / anti-correlated one is boosted. Don't double-bet.
 *   DETECT   — per-strategy health: live Sharpe, trailing Sharpe, drawdown, and a
 *              decay flag (is this edge fading out-of-sample, right now?).
 *
 * Pure + deterministic. Feed it each strategy's live return series; get a
 * combined allocation + a health readout. Generalizes the portfolio-agent:
 * momentum, market-making, and any arena genome are just inputs.
 */

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const variance = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const std = (a: number[]) => Math.sqrt(variance(a));

/** Pearson correlation over the overlapping tail of two return series. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(a.length - n), y = b.slice(b.length - n);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export type StratReturns = { strategy: string; returns: number[] };

/**
 * DE-CORRELATED inverse-vol allocation. Base weight ∝ 1/σ (risk-parity-lite:
 * lower-vol strategies get more), scaled by a diversification factor
 * (1 − corrPenalty · avgCorrelationToOthers, floored) so strategies correlated
 * with the pack are penalized and uncorrelated ones boosted. Returns weights
 * summing to 1. Optionally drops strategies flagged `decaying`.
 */
export function metaAllocate(
  strats: StratReturns[],
  opts: { corrPenalty?: number; minVol?: number; dropDecaying?: boolean; periodsPerYear?: number } = {},
): Record<string, number> {
  let pool = strats.filter((s) => s.returns.length >= 2);
  if (opts.dropDecaying) pool = pool.filter((s) => !strategyHealth(s.returns, { periodsPerYear: opts.periodsPerYear }).decaying);
  const n = pool.length;
  if (n === 0) return {};
  if (n === 1) return { [pool[0].strategy]: 1 };
  const corrPenalty = opts.corrPenalty ?? 1;
  const minVol = opts.minVol ?? 1e-6;
  const raw = pool.map((s, i) => {
    const invVol = 1 / Math.max(minVol, std(s.returns));            // risk-parity-lite
    let sum = 0, cnt = 0;
    for (let j = 0; j < n; j++) if (j !== i) { sum += correlation(s.returns, pool[j].returns); cnt++; }
    const avgCorr = cnt ? sum / cnt : 0;
    const divFactor = Math.max(0.05, 1 - corrPenalty * avgCorr);    // penalize correlated, boost anti-correlated
    return invVol * divFactor;
  });
  const tot = raw.reduce((a, b) => a + b, 0) || 1;
  const out: Record<string, number> = {};
  pool.forEach((s, i) => { out[s.strategy] = raw[i] / tot; });
  return out;
}

export type Health = { n: number; annSharpe: number; trailingSharpe: number; maxDrawdown: number; decaying: boolean };

/**
 * DETECT: per-strategy health. `decaying` is true when the recent (trailing)
 * Sharpe has fallen below `decayRatio` × the full-sample Sharpe (a simple
 * edge-decay / change detector) — the signal to cut the strategy.
 */
export function strategyHealth(
  returns: number[],
  opts: { periodsPerYear?: number; trailingFrac?: number; decayRatio?: number; minN?: number } = {},
): Health {
  const ppy = opts.periodsPerYear ?? 365;
  const n = returns.length;
  const sharpe = (r: number[]) => { const sd = std(r); return sd > 0 ? (mean(r) / sd) * Math.sqrt(ppy) : 0; };
  const full = sharpe(returns);
  const tf = opts.trailingFrac ?? 0.33;
  const trailing = n >= 6 ? sharpe(returns.slice(Math.floor(n * (1 - tf)))) : full;
  let eq = 1, peak = 1, mdd = 0;
  for (const r of returns) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak > 0 ? (peak - eq) / peak : 0); }
  const decaying = n >= (opts.minN ?? 10) && full > 0 && trailing < full * (opts.decayRatio ?? 0.5);
  return { n, annSharpe: full, trailingSharpe: trailing, maxDrawdown: mdd, decaying };
}

/** The combined meta-portfolio return series, aligned to the overlapping tail. */
export function combinedSeries(strats: StratReturns[], weights: Record<string, number>): number[] {
  const active = strats.filter((s) => (weights[s.strategy] ?? 0) !== 0 && s.returns.length);
  if (!active.length) return [];
  const T = Math.min(...active.map((s) => s.returns.length));
  const out: number[] = [];
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (const s of active) r += (weights[s.strategy] ?? 0) * s.returns[s.returns.length - T + t];
    out.push(r);
  }
  return out;
}

/**
 * Diversification ratio = (Σ wᵢσᵢ) / σ_portfolio. > 1 ⇒ the combination has less
 * risk than the weighted average of its parts — the payoff of de-correlation.
 */
export function diversificationRatio(strats: StratReturns[], weights: Record<string, number>): number {
  const active = strats.filter((s) => (weights[s.strategy] ?? 0) !== 0 && s.returns.length >= 2);
  if (active.length < 2) return 1;
  const weightedAvgVol = active.reduce((acc, s) => acc + (weights[s.strategy] ?? 0) * std(s.returns), 0);
  const portVol = std(combinedSeries(strats, weights));
  return portVol > 0 ? weightedAvgVol / portVol : 1;
}
