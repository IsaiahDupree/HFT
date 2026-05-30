/**
 * Lightweight signal helpers: given a price-history series (newest last),
 * compute returns, realized vol, and a z-score vs. rolling mean.
 * No external deps — meant for the research loop and ad-hoc analysis.
 */

export type PricePoint = { t: number; p: number };

export function returnOver(series: PricePoint[], secondsAgo: number): number | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const targetT = latest.t - secondsAgo;
  // Pick the point closest to targetT
  let best = series[0];
  for (const pt of series) {
    if (Math.abs(pt.t - targetT) < Math.abs(best.t - targetT)) best = pt;
  }
  if (best.p === 0 || best === latest) return null;
  return (latest.p - best.p) / best.p;
}

export function realizedVol(series: PricePoint[]): number {
  if (series.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].p;
    if (prev === 0) continue;
    rets.push((series[i].p - prev) / prev);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

export function zScoreVsRollingMean(series: PricePoint[]): number {
  if (series.length < 4) return 0;
  const prices = series.map((p) => p.p);
  const latest = prices[prices.length - 1];
  const window = prices.slice(0, -1);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((acc, p) => acc + (p - mean) ** 2, 0) / Math.max(1, window.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (latest - mean) / std;
}

export type Signal = {
  tokenId: string;
  conditionId: string;
  question: string;
  midpoint: number;
  spread: number;
  ret1d: number | null;
  ret1w: number | null;
  realizedVol: number;
  zScore: number;
  samples: number;
};

export function summarize(label: string, values: number[]): { label: string; n: number; mean: number; std: number; min: number; max: number; p10: number; p90: number } {
  const n = values.length;
  if (n === 0) return { label, n, mean: 0, std: 0, min: 0, max: 0, p10: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return { label, n, mean, std: Math.sqrt(variance), min: sorted[0], max: sorted[n - 1], p10: q(0.1), p90: q(0.9) };
}
