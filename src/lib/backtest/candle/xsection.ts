/**
 * Cross-sectional (market-neutral long/short) reversal & momentum — the pure,
 * data-injected core of scripts/backtest-xsection.ts (extracted so it is unit-testable
 * + arena-reusable; the script is now a thin TSDB loader over this).
 *
 * Each rebalance day: rank eligible coins by their L-day return, z-score the
 * cross-section, weight ∝ −sign·z (sign +1 = reversal, −1 = momentum), enforce
 * dollar-neutral (Σw = 0) + gross-normalized (Σ|w| = 1), hold 1 day, charge feeBps on
 * turnover. NO LOOKAHEAD: weights at day t use returns through t; the realized return
 * is over t→t+1. Market-neutral by construction.
 */

/** coin → (day_unix → close). The shape backtest-xsection builds from the warehouse. */
export type PriceSeries = Record<string, Map<number, number>>;

export type XSectionVariant = {
  label: string;
  /** Look-back horizon in days for the ranking return. */
  L: number;
  /** +1 = reversal (long recent losers), −1 = momentum (long recent winners). */
  sign: number;
  /** Only hold when the benchmark is trending (chop → flat). */
  trendOnly?: boolean;
};

export type XSectionOpts = {
  feeBps?: number;
  /** Skip a rebalance day with fewer than this many eligible coins. */
  minCoins?: number;
  /** Trend gate: benchmark efficiency-ratio window + threshold. */
  trendWindow?: number;
  trendThreshold?: number;
};

const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/**
 * Mandelbrot efficiency ratio of `series` (benchmark close per day index) over the
 * trailing `window` ending at `i`: |net move| / Σ|step|. Trending ⇔ ratio ≥ threshold.
 * Returns false at the edges / on any missing value (never looks ahead of `i`).
 */
export function efficiencyTrending(
  series: ReadonlyArray<number | undefined>,
  i: number,
  window: number,
  threshold: number,
): boolean {
  if (i < window) return false;
  const a = series[i], b = series[i - window];
  if (a == null || b == null) return false;
  let path = 0;
  for (let k = i - window + 1; k <= i; k++) {
    const x = series[k], y = series[k - 1];
    if (x == null || y == null) return false;
    path += Math.abs(x - y);
  }
  return path > 0 && Math.abs(a - b) / path >= threshold;
}

/**
 * Cross-sectional weights from a vector of look-back returns: z-score the cross-section,
 * weight ∝ −sign·z (sign +1 = reversal, −1 = momentum), demean to dollar-neutral (Σw = 0),
 * then gross-normalize (Σ|w| = 1). Returns all-zero when there is no dispersion (sd = 0).
 * Pure + the load-bearing market-neutrality invariant — unit-tested directly.
 */
export function xsectionWeights(lookbackReturns: readonly number[], sign: number): number[] {
  const lr = lookbackReturns as number[];
  const m = avg(lr), sd = std(lr);
  if (sd <= 0) return lr.map(() => 0);
  let w = lr.map((x) => -sign * (x - m) / sd);
  const wMean = avg(w);
  w = w.map((x) => x - wMean);                                // dollar-neutral (Σw = 0)
  const gross = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
  return w.map((x) => x / gross);                            // gross-normalize (Σ|w| = 1)
}

/**
 * Daily long-short portfolio return series for one variant. `benchmark` is the
 * per-day-index close used by the trend gate (only consulted when v.trendOnly).
 * Series is aligned to start at `startIndex` (default = max look-back) so every
 * variant shares the same period index — required for PBO / DSR cross-trial stats.
 */
export function xsectionReturns(
  v: XSectionVariant,
  coins: readonly string[],
  data: PriceSeries,
  days: readonly number[],
  opts: XSectionOpts & { startIndex?: number; benchmark?: ReadonlyArray<number | undefined> } = {},
): number[] {
  const feeBps = opts.feeBps ?? 10;
  const minCoins = opts.minCoins ?? 4;
  const trendWindow = opts.trendWindow ?? 20;
  const trendThreshold = opts.trendThreshold ?? 0.3;
  const start = opts.startIndex ?? v.L;
  const benchmark = opts.benchmark ?? days.map(() => undefined);
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = start; i < days.length - 1; i++) {
    if (v.trendOnly && !efficiencyTrending(benchmark, i, trendWindow, trendThreshold)) {
      // chop → go flat: close any open position (pays turnover), earn 0 otherwise
      let turn = 0;
      for (const c of Object.keys(prevW)) turn += Math.abs(prevW[c]);
      rets.push(-turn * feeBps / 1e4);
      prevW = {};
      continue;
    }
    const t = days[i], tPrev = days[i - v.L], tNext = days[i + 1];
    const elig = coins.filter((c) => data[c].has(t) && data[c].has(tPrev) && data[c].has(tNext));
    if (elig.length < minCoins) { rets.push(0); prevW = {}; continue; }
    const lret = elig.map((c) => data[c].get(t)! / data[c].get(tPrev)! - 1);
    const w = xsectionWeights(lret, v.sign);
    if (w.every((x) => x === 0)) { rets.push(0); continue; }  // no dispersion → flat
    const nret = elig.map((c) => data[c].get(tNext)! / data[c].get(t)! - 1);
    let pr = 0;
    for (let j = 0; j < elig.length; j++) pr += w[j] * nret[j];
    const wMap: Record<string, number> = {};
    elig.forEach((c, j) => { wMap[c] = w[j]; });
    let turn = 0;
    for (const c of new Set([...Object.keys(prevW), ...elig])) turn += Math.abs((wMap[c] ?? 0) - (prevW[c] ?? 0));
    rets.push(pr - turn * feeBps / 1e4);
    prevW = wMap;
  }
  return rets;
}

/** The standard variant grid: reversal + momentum at each look-back, plus trend-gated
 *  momentum at the longer horizons. Shared by the script + tests. */
export function defaultXSectionVariants(
  lookbacks: readonly number[] = [1, 2, 3, 5, 10, 20],
  trendLookbacks: readonly number[] = [5, 10, 20],
): XSectionVariant[] {
  const variants: XSectionVariant[] = [];
  for (const L of lookbacks) {
    variants.push({ label: `rev-${L}d`, L, sign: 1 });
    variants.push({ label: `mom-${L}d`, L, sign: -1 });
  }
  for (const L of trendLookbacks) variants.push({ label: `momT-${L}d`, L, sign: -1, trendOnly: true });
  return variants;
}

/** Build the (coin → day → close) series + sorted day index from raw candle rows. */
export function buildPriceSeries(
  rows: Record<string, ReadonlyArray<{ start_unix: number; close: number }>>,
): { coins: string[]; data: PriceSeries; days: number[] } {
  const coins = Object.keys(rows);
  const data: PriceSeries = {};
  const allDays = new Set<number>();
  for (const c of coins) {
    const m = new Map<number, number>();
    for (const k of rows[c]) { m.set(k.start_unix, k.close); allDays.add(k.start_unix); }
    data[c] = m;
  }
  return { coins, data, days: [...allDays].sort((a, b) => a - b) };
}
