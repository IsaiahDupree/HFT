/**
 * Cross-asset strategies — trade coins RELATIVE to each other instead of in isolation.
 * Pure + NO-LOOKAHEAD (rank/regime at t uses data through t; the realized return is t→t+1).
 *
 *   relativeStrengthReturns — long the top-K strongest coins by trailing return (rotation).
 *   btcRegimeFilter         — gate any per-asset position to BTC's trend (only long alts
 *                             when BTC is bullish), aligning BTC by timestamp.
 */
import type { PriceSeries } from "./xsection";

const finite = (x: number | undefined): x is number => x != null && Number.isFinite(x);

export type RelStrengthVariant = { label: string; L: number; topK: number };

/**
 * Daily long-only TOP-K relative-strength momentum return series. Each rebalance: rank the
 * eligible coins by their L-bar return, hold the top-K equal-weight, realize t→t+1, charge
 * `feeBps` on turnover. "Trade the strongest coins, not each symbol in isolation."
 * Aligned to start at `startIndex` (default L) so variants share the same period index (PBO/DSR).
 */
export function relativeStrengthReturns(
  v: RelStrengthVariant,
  coins: readonly string[],
  data: PriceSeries,
  days: readonly number[],
  opts: { feeBps?: number; minCoins?: number; startIndex?: number } = {},
): number[] {
  const feeBps = opts.feeBps ?? 10;
  const minCoins = opts.minCoins ?? Math.max(2, v.topK + 1);
  const start = opts.startIndex ?? v.L;
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = start; i < days.length - 1; i++) {
    const t = days[i], tPrev = days[i - v.L], tNext = days[i + 1];
    const elig = coins.filter((c) => data[c].has(t) && data[c].has(tPrev) && data[c].has(tNext));
    if (elig.length < minCoins) { rets.push(0); prevW = {}; continue; }
    // rank by trailing L-bar return (strongest first) — uses only closes ≤ t
    const ranked = elig
      .map((c) => ({ c, m: data[c].get(t)! / data[c].get(tPrev)! - 1 }))
      .sort((a, b) => b.m - a.m);
    const k = Math.min(v.topK, ranked.length);
    const w = 1 / k;
    let pr = 0;
    const wMap: Record<string, number> = {};
    for (let j = 0; j < k; j++) {
      const c = ranked[j].c;
      pr += w * (data[c].get(tNext)! / data[c].get(t)! - 1); // realized t→t+1
      wMap[c] = w;
    }
    let turn = 0;
    for (const c of new Set([...Object.keys(prevW), ...Object.keys(wMap)])) turn += Math.abs((wMap[c] ?? 0) - (prevW[c] ?? 0));
    rets.push(pr - turn * feeBps / 1e4);
    prevW = wMap;
  }
  return rets;
}

/** The standard relative-strength variant grid: look-back × number held. */
export function defaultRelStrengthVariants(
  lookbacks: readonly number[] = [5, 10, 20, 30],
  tops: readonly number[] = [1, 2, 3],
): RelStrengthVariant[] {
  const out: RelStrengthVariant[] = [];
  for (const L of lookbacks) for (const topK of tops) out.push({ label: `rs${L}/top${topK}`, L, topK });
  return out;
}

/**
 * BTC-regime gate: keep a per-asset position only when BTC is in an uptrend (BTC close >
 * its SMA over `n`). "Only long alts when BTC trend is bullish; flat otherwise." `btcCloses`
 * must be aligned 1:1 to `positions` (same bar index) — a non-finite BTC close in the window
 * → flat (conservative). NO LOOKAHEAD (the SMA uses BTC closes ≤ i). Gate only SUBTRACTS.
 */
export function btcRegimeFilter(positions: number[], btcCloses: ReadonlyArray<number | undefined>, n: number): number[] {
  return positions.map((p, i) => {
    if (i + 1 < n || !finite(btcCloses[i])) return 0;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) {
      if (!finite(btcCloses[k])) return 0; // missing BTC history → can't judge regime → flat
      s += btcCloses[k] as number;
    }
    return (btcCloses[i] as number) > s / n ? p : 0;
  });
}

/** Align a benchmark's closes (by `start_unix`) to a target series' bars → benchmark close
 *  at each target bar's timestamp (undefined where the benchmark has no bar). Lets
 *  btcRegimeFilter gate a coin whose bar grid doesn't share BTC's array indices. */
export function alignClosesByTimestamp(
  targetBars: ReadonlyArray<{ start_unix: number }>,
  benchmarkBars: ReadonlyArray<{ start_unix: number; close: number }>,
): Array<number | undefined> {
  const byTs = new Map(benchmarkBars.map((b) => [b.start_unix, b.close]));
  return targetBars.map((b) => byTs.get(b.start_unix));
}
