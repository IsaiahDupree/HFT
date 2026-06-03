/**
 * Market regimes + conditional-alpha analysis. The audit showed unconditional strategies are
 * just beta (a big ROI that underperforms buy-and-hold). The honest next question is whether a
 * strategy beats beta *inside a regime* (e.g. only when vol is high, or BTC is trending) — i.e.
 * is the edge conditional? These label each bar by regime (NO-LOOKAHEAD, self-calibrating) and
 * compute excess-over-beta out-of-sample WITHIN each regime, so a real conditional edge can be
 * separated from a beta that happens to show up in some slice.
 *
 * WARNING: slicing P&L by regime multiplies the number of hypotheses tested. A positive
 * conditional OOS alpha is a CANDIDATE, not a result — it must survive multiple-testing
 * correction + robustness (see scripts/regime-analysis.ts and its adversarial verification).
 */
import { realizedVol } from "./indicators";
import { sharpe, normalInv } from "./stats";
import type { PriceSeries } from "./xsection";

export type RegimeLabel = string;
export const UNKNOWN: RegimeLabel = "UNKNOWN";

const finite = (x: number): boolean => Number.isFinite(x);

/** Simple moving average; sma[i] = NaN until i ≥ n−1. No lookahead. */
function sma(values: readonly number[], n: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Trailing median of the last `lookback` FINITE values ending at i (inclusive). No lookahead. */
function trailingMedian(series: readonly number[], i: number, lookback: number): number {
  const w: number[] = [];
  for (let k = Math.max(0, i - lookback + 1); k <= i; k++) if (finite(series[k])) w.push(series[k]);
  if (!w.length) return NaN;
  w.sort((a, b) => a - b);
  const m = w.length >> 1;
  return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
}

/**
 * Volatility regime per bar: realized vol over `volN` bars vs its own TRAILING median over
 * `lookback` (self-calibrating, so it adapts across eras instead of a fixed vol threshold).
 * "HIGH_VOL" when current vol is above the trailing median, "LOW_VOL" at/below, "UNKNOWN" during
 * warmup. NO LOOKAHEAD (uses vols ≤ i only).
 */
export function volRegimeLabels(closes: readonly number[], volN = 14, lookback = 100): RegimeLabel[] {
  const rv = realizedVol([...closes], volN);
  return closes.map((_, i) => {
    if (!finite(rv[i])) return UNKNOWN;
    const med = trailingMedian(rv, i - 1, lookback); // strictly-prior median → today can't define its own bucket
    if (!finite(med)) return UNKNOWN;
    return rv[i] > med ? "HIGH_VOL" : "LOW_VOL";
  });
}

/**
 * Trend regime per bar from price vs its SMA(`n`) and the SMA slope: "BULL" (above & rising),
 * "BEAR" (below & falling), "CHOP" (mixed), "UNKNOWN" during warmup. NO LOOKAHEAD.
 */
export function trendRegimeLabels(closes: readonly number[], n = 50): RegimeLabel[] {
  const ma = sma(closes, n);
  return closes.map((c, i) => {
    if (i < n || !finite(ma[i]) || !finite(ma[i - 1])) return UNKNOWN;
    const above = c > ma[i], rising = ma[i] > ma[i - 1];
    if (above && rising) return "BULL";
    if (!above && !rising) return "BEAR";
    return "CHOP";
  });
}

/**
 * Market-breadth regime per DAY: fraction of eligible coins trading above their own SMA(`n`).
 * "RISK_ON" when breadth > 0.5, "RISK_OFF" at/below, "UNKNOWN" when too few coins are eligible.
 * NO LOOKAHEAD (each coin's SMA at day i uses that coin's closes ≤ day i). Aligned to `days`.
 */
export function breadthRegimeLabels(
  coins: readonly string[],
  data: PriceSeries,
  days: readonly number[],
  n = 50,
  minCoins = 5,
): RegimeLabel[] {
  // Per-coin close-over-days series + its SMA (NaN where the coin has no bar that day).
  const smaByCoin: Record<string, number[]> = {};
  const closeByCoin: Record<string, number[]> = {};
  for (const c of coins) {
    const series = days.map((d) => (data[c].has(d) ? data[c].get(d)! : NaN));
    closeByCoin[c] = series;
    // SMA over present bars only: a gap shouldn't smear; recompute a contiguous SMA treating
    // NaN as a break is overkill here — use a forward SMA that skips NaN in the window.
    smaByCoin[c] = series.map((_, i) => {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) if (finite(series[j])) { sum += series[j]; k++; }
      return k >= Math.max(2, Math.floor(n / 2)) ? sum / k : NaN; // need at least half the window present
    });
  }
  return days.map((_, i) => {
    let above = 0, elig = 0;
    for (const c of coins) {
      const px = closeByCoin[c][i], m = smaByCoin[c][i];
      if (!finite(px) || !finite(m)) continue;
      elig++;
      if (px > m) above++;
    }
    if (elig < minCoins) return UNKNOWN;
    return above / elig > 0.5 ? "RISK_ON" : "RISK_OFF";
  });
}

/** Combine two per-bar label arrays into a composite "A|B" label; UNKNOWN if either is UNKNOWN. */
export function combineLabels(a: readonly RegimeLabel[], b: readonly RegimeLabel[]): RegimeLabel[] {
  return a.map((x, i) => (x === UNKNOWN || b[i] === UNKNOWN ? UNKNOWN : `${x}|${b[i]}`));
}

const ann = (s: number): number => s * Math.sqrt(365);
const cum = (a: number[]): number => a.reduce((e, x) => e * (1 + x), 1) - 1;

export type ConditionalAlpha = {
  label: RegimeLabel;
  nFull: number; nOos: number;
  excessSharpeFull: number;  // ann. excess-over-beta Sharpe on ALL bars in this regime
  excessSharpeOos: number;   // ann. excess-over-beta Sharpe on OOS bars in this regime  ← the headline
  tStatOos: number;          // t-stat of the OOS mean excess (= per-bar Sharpe · √nOos) — the HONEST one
  stratSharpeOos: number; betaSharpeOos: number;
  stratCumOos: number; betaCumOos: number;
};

/**
 * For each regime label: the strategy's excess-over-beta Sharpe within that regime, full-sample
 * and (the honest one) out-of-sample. `labels` must align 1:1 with `strat`/`bench` (same bar
 * grid). OOS = the last `oosFrac` of the WHOLE timeline (so a regime's OOS bars are genuinely
 * later in time, not cherry-picked). UNKNOWN is skipped.
 */
export function regimeConditionalAlpha(
  strat: readonly number[],
  bench: readonly number[],
  labels: readonly RegimeLabel[],
  opts: { oosFrac?: number } = {},
): ConditionalAlpha[] {
  const oosFrac = opts.oosFrac ?? 0.3;
  const n = strat.length;
  const split = Math.floor(n * (1 - oosFrac));
  const out: ConditionalAlpha[] = [];
  for (const label of [...new Set(labels)].filter((l) => l !== UNKNOWN).sort()) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === label) idx.push(i);
    const oosIdx = idx.filter((i) => i >= split);
    const ex = idx.map((i) => strat[i] - bench[i]);
    const exOos = oosIdx.map((i) => strat[i] - bench[i]);
    out.push({
      label, nFull: idx.length, nOos: oosIdx.length,
      excessSharpeFull: ann(sharpe(ex)), excessSharpeOos: ann(sharpe(exOos)),
      tStatOos: sharpe(exOos) * Math.sqrt(oosIdx.length), // per-bar Sharpe · √n = t-stat of the mean
      stratSharpeOos: ann(sharpe(oosIdx.map((i) => strat[i]))),
      betaSharpeOos: ann(sharpe(oosIdx.map((i) => bench[i]))),
      stratCumOos: cum(oosIdx.map((i) => strat[i])),
      betaCumOos: cum(oosIdx.map((i) => bench[i])),
    });
  }
  return out;
}

/**
 * Multiple-testing-aware filter: a conditional edge is a CANDIDATE only if its OOS excess
 * Sharpe clears `minExcessOos` AND it has at least `minOosBars` out-of-sample observations.
 * (A weak pre-filter that produces leads; significance is judged separately below.)
 */
export function candidateConditionalEdges(
  cells: ConditionalAlpha[],
  opts: { minExcessOos?: number; minOosBars?: number } = {},
): ConditionalAlpha[] {
  const minExcess = opts.minExcessOos ?? 0.3, minBars = opts.minOosBars ?? 60;
  return cells
    .filter((c) => c.nOos >= minBars && c.excessSharpeOos > minExcess)
    .sort((a, b) => b.excessSharpeOos - a.excessSharpeOos);
}

export type MultipleTestingReport = {
  nHypotheses: number;   // cells with enough OOS bars to count as a test
  alpha: number;         // family-wise error target
  critT: number;         // one-sided Bonferroni critical t (normal approx): z_{1 - alpha/m}
  expectedFalse: number; // ≈ alpha · nHypotheses false positives expected at uncorrected alpha
  survivors: ConditionalAlpha[]; // cells whose tStatOos clears the Bonferroni critical value
};

/**
 * Honest multiple-testing verdict over a scanned set of cells. A scan of `m` regime cells is
 * `m` hypotheses; to control the family-wise error at `alpha` a single cell must clear the
 * Bonferroni one-sided critical t (normal approx z at 1 − alpha/m). This is what separates a
 * real conditional edge from "we sliced the data until something looked good". Cells without
 * `minOosBars` OOS observations don't count as a test (too few points to reject anything).
 */
export function multipleTestingReport(
  cells: ConditionalAlpha[],
  opts: { alpha?: number; minOosBars?: number } = {},
): MultipleTestingReport {
  const alpha = opts.alpha ?? 0.05, minBars = opts.minOosBars ?? 60;
  const tested = cells.filter((c) => c.nOos >= minBars);
  const m = Math.max(1, tested.length);
  const critT = normalInv(1 - alpha / m); // one-sided Bonferroni
  const survivors = tested.filter((c) => c.tStatOos > critT).sort((a, b) => b.tStatOos - a.tStatOos);
  return { nHypotheses: tested.length, alpha, critT, expectedFalse: alpha * tested.length, survivors };
}
