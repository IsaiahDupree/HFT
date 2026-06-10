/**
 * walk-forward-copy — the gate that asks the only question that matters about the basket's +6.6% in-sample
 * alpha: is it a REGIME-INDEPENDENT edge, or did "short just work last month"? It slices the copy-vs-beta
 * return streams into rolling time windows, tags each window's market regime by the benchmark's own move
 * (up/down/flat), and measures the copy alpha SEPARATELY in each regime. A short-biased basket will show big
 * positive alpha in down windows and NEGATIVE alpha in up windows — that's a regime bet, not skill. Real edge
 * shows alpha that survives BOTH.
 *
 * IMPORTANT honesty boundary (the script states it too): this varies TIME, not basket MEMBERSHIP. The basket is
 * today's verified set, so this is a partial (time-only) walk-forward — it cannot undo the survivorship in WHO
 * is in the basket, only test whether that fixed basket's behavior generalizes across regimes. True membership
 * walk-forward needs historical verified status we don't have yet (the longitudinal store has ~1 day).
 *
 * Pure + deterministic.
 */
import { sharpe, deflatedSharpe } from "../backtest/candle/stats.ts";

export type RegimeLabel = "up" | "down" | "flat";
/** Tag a window's regime by the benchmark's cumulative move over it. */
export function classifyRegime(benchCumReturn: number, flatBand = 0.02): RegimeLabel {
  return benchCumReturn > flatBand ? "up" : benchCumReturn < -flatBand ? "down" : "flat";
}

export const cumReturn = (rets: readonly number[]): number => rets.reduce((acc, r) => (1 + acc) * (1 + r) - 1, 0);

/** Split a series into overlapping windows of `size`, advancing by `step`. Trailing partial window kept if ≥ size/2. */
export function rollingWindows<T>(series: readonly T[], size: number, step: number): Array<{ start: number; end: number; items: T[] }> {
  const out: Array<{ start: number; end: number; items: T[] }> = [];
  if (size <= 0 || step <= 0) return out;
  for (let s = 0; s + Math.ceil(size / 2) <= series.length; s += step) {
    const end = Math.min(s + size, series.length);
    out.push({ start: s, end, items: series.slice(s, end) });
    if (end >= series.length) break;
  }
  return out;
}

export type WindowResult = { index: number; regime: RegimeLabel; copyReturn: number; benchReturn: number; alpha: number; copySharpe: number; nPeriods: number };

export type RegimeAgg = { n: number; meanAlpha: number; winRate: number };
export type WalkForwardResult = {
  windows: WindowResult[];
  byRegime: Record<RegimeLabel, RegimeAgg>;
  nWindows: number; meanAlpha: number; alphaConsistency: number; // fraction of windows with positive alpha
  alphaUp: number; alphaDown: number; dsr: number;
  verdict: "regime-independent edge" | "regime-dependent (directional bet)" | "no edge" | "insufficient";
};

const agg = (xs: number[]): RegimeAgg => ({ n: xs.length, meanAlpha: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, winRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : 0 });

/**
 * Walk the copy/benchmark per-period return streams in rolling windows and judge whether the alpha is real.
 * Verdict is deliberately strict: an edge must average positive AND not be NEGATIVE in up regimes (a basket
 * that only wins when the market falls is a short bet wearing an alpha costume).
 */
export function walkForwardAnalysis(
  copyReturns: readonly number[], benchReturns: readonly number[],
  opts: { windowSize?: number; step?: number; flatBand?: number; minWindows?: number } = {},
): WalkForwardResult {
  const { windowSize = 14, step = 7, flatBand = 0.02, minWindows = 4 } = opts;
  const idx = copyReturns.map((_, i) => i);
  const wins = rollingWindows(idx, windowSize, step);
  const windows: WindowResult[] = wins.map((w, i) => {
    const cr = w.items.map((j) => copyReturns[j]);
    const br = w.items.map((j) => benchReturns[j]);
    const copyReturn = cumReturn(cr), benchReturn = cumReturn(br);
    return { index: i, regime: classifyRegime(benchReturn, flatBand), copyReturn, benchReturn, alpha: copyReturn - benchReturn, copySharpe: sharpe(cr), nPeriods: w.items.length };
  });

  const alphas = windows.map((w) => w.alpha);
  const byRegime: Record<RegimeLabel, RegimeAgg> = {
    up: agg(windows.filter((w) => w.regime === "up").map((w) => w.alpha)),
    down: agg(windows.filter((w) => w.regime === "down").map((w) => w.alpha)),
    flat: agg(windows.filter((w) => w.regime === "flat").map((w) => w.alpha)),
  };
  const meanAlpha = alphas.length ? alphas.reduce((a, b) => a + b, 0) / alphas.length : 0;
  // DSR on the window alphas, deflated by the spread of per-window copy Sharpes (multiple-testing aware)
  const dsr = windows.length >= 4 ? deflatedSharpe(alphas, windows.map((w) => w.copySharpe)).dsr : 0;

  let verdict: WalkForwardResult["verdict"];
  if (windows.length < minWindows) verdict = "insufficient";
  // directional-bet diagnosis takes precedence over a raw mean: wins in down, loses in up = a short bet, full stop
  else if (byRegime.up.n > 0 && byRegime.down.n > 0 && byRegime.up.meanAlpha < 0 && byRegime.down.meanAlpha > 0) verdict = "regime-dependent (directional bet)";
  else if (meanAlpha <= 0) verdict = "no edge";
  else verdict = "regime-independent edge";

  return { windows, byRegime, nWindows: windows.length, meanAlpha, alphaConsistency: alphas.length ? alphas.filter((a) => a > 0).length / alphas.length : 0, alphaUp: byRegime.up.meanAlpha, alphaDown: byRegime.down.meanAlpha, dsr, verdict };
}
