/**
 * lookahead-detect — port of Freqtrade's two bias detectors, generalized to our pure strategy functions. They
 * catch the single most dangerous backtest lie: a "position" that secretly depends on FUTURE data.
 *
 *   • detectLookahead — the truncation test. A no-lookahead strategy satisfies positions(bars)[i] ===
 *     positions(bars[0..k])[i] for every i < k: cutting off future bars must NOT change any earlier position.
 *     If truncating the tail changes an earlier signal, the signal was peeking ahead. (Freqtrade's
 *     `lookahead-analysis`.)
 *   • detectRecursive — the warmup test. A recursive indicator (EMA, RSI, anything with infinite lookback)
 *     computed from too little startup data gives a DIFFERENT value than with full history. We vary the warmup
 *     and find where the value stabilizes; if it never does within the data, the backtest's startup is
 *     insufficient and its indicator values are biased. (Freqtrade's `recursive-analysis`.)
 *
 * Pure + deterministic. This is the front gate of the gauntlet — run it on every strategy before trusting a number.
 */

export type LookaheadResult = { biased: boolean; firstMismatchIndex: number | null; checkedTruncations: number; mismatches: number; detail: string };

/**
 * Truncation test for lookahead bias. `positionsFn(bars)` must return one position per bar, decided from data
 * ≤ that bar. We re-run it on truncated copies and require the overlapping prefix to be IDENTICAL.
 */
export function detectLookahead<T>(
  positionsFn: (bars: readonly T[]) => number[],
  bars: readonly T[],
  opts: { truncationFracs?: number[]; tol?: number } = {},
): LookaheadResult {
  const fracs = opts.truncationFracs ?? [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
  const tol = opts.tol ?? 1e-9;
  const full = positionsFn(bars);
  let mismatches = 0, first: number | null = null, checked = 0;
  for (const f of fracs) {
    const k = Math.floor(bars.length * f);
    if (k < 2 || k >= bars.length) continue;
    checked++;
    const trunc = positionsFn(bars.slice(0, k));
    for (let i = 0; i < k; i++) {
      if (Math.abs((full[i] ?? 0) - (trunc[i] ?? 0)) > tol) {
        mismatches++;
        if (first === null || i < first) first = i;
        break; // first offending index for this truncation
      }
    }
  }
  return {
    biased: mismatches > 0, firstMismatchIndex: first, checkedTruncations: checked, mismatches,
    detail: mismatches ? `position[${first}] changed when future bars were truncated → LOOKAHEAD BIAS` : `stable across ${checked} truncations → no lookahead`,
  };
}

export type RecursiveResult = { converged: boolean; warmupNeeded: number | null; values: Array<{ warmup: number; value: number }>; detail: string };

/**
 * Warmup test for recursive/lookback bias. `indicatorAt(window)` returns the indicator value at the LAST bar of
 * the window. We evaluate a FIXED anchor bar with growing warmup; a clean indicator stabilizes quickly, a
 * recursive one keeps drifting. Returns the warmup at which it converges (or null if it never does in-sample).
 */
export function detectRecursive<T>(
  indicatorAt: (window: readonly T[]) => number,
  bars: readonly T[],
  opts: { warmups?: number[]; tol?: number; anchorFromEnd?: number } = {},
): RecursiveResult {
  const warmups = (opts.warmups ?? [10, 25, 50, 100, 200, 400]).slice().sort((a, b) => a - b);
  const tol = opts.tol ?? 1e-6;
  const anchor = bars.length - 1 - (opts.anchorFromEnd ?? 0);
  const values: Array<{ warmup: number; value: number }> = [];
  for (const w of warmups) {
    const start = anchor - w;
    if (start < 0 || anchor >= bars.length) continue;
    values.push({ warmup: w, value: indicatorAt(bars.slice(start, anchor + 1)) });
  }
  let warmupNeeded: number | null = null;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i].value - values[i - 1].value) <= tol) { warmupNeeded = values[i - 1].warmup; break; }
  }
  return {
    converged: warmupNeeded !== null, warmupNeeded, values,
    detail: warmupNeeded !== null ? `stabilizes after ~${warmupNeeded} bars of warmup` : `does NOT converge within tested warmups → recursive/lookback dependency (give the backtest more startup)`,
  };
}
