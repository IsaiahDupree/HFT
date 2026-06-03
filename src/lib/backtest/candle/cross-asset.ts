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

/**
 * Equal-weight buy-and-hold of the whole universe — the BETA benchmark a relative-strength
 * (or any long-only) strategy must BEAT to claim alpha. Each bar holds every eligible coin
 * equal-weight and realizes t→t+1; no ranking, no turnover fee (it's the "do nothing but hold"
 * yardstick). Aligned 1:1 to `relativeStrengthReturns(..., { startIndex })` so you can subtract
 * the two series bar-for-bar to get excess-over-beta. NO LOOKAHEAD (return uses closes ≤ t+1).
 */
export function equalWeightBuyHoldReturns(
  coins: readonly string[],
  data: PriceSeries,
  days: readonly number[],
  startIndex: number,
): number[] {
  const rets: number[] = [];
  for (let i = startIndex; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    const elig = coins.filter((c) => data[c].has(t) && data[c].has(tNext));
    if (!elig.length) { rets.push(0); continue; }
    let pr = 0;
    for (const c of elig) pr += (data[c].get(tNext)! / data[c].get(t)! - 1) / elig.length;
    rets.push(pr);
  }
  return rets;
}

/**
 * Equal-weight TREND portfolio — each bar, hold every coin trading above its own SMA(`smaN`)
 * equal-weight, realize t→t+1, charge `feeBps` on turnover. A long-flat momentum portfolio
 * (vs relativeStrengthReturns' top-K rotation): "own the coins that are trending, skip the
 * rest." Aligned to start at `startIndex`. NO LOOKAHEAD (SMA at t uses closes ≤ t). A second
 * strategy family for the regime-conditional analysis, directly comparable to the beta benchmark.
 */
export function equalWeightTrendReturns(
  coins: readonly string[],
  data: PriceSeries,
  days: readonly number[],
  smaN: number,
  opts: { feeBps?: number; startIndex?: number } = {},
): number[] {
  const feeBps = opts.feeBps ?? 10;
  const start = opts.startIndex ?? smaN;
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = start; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    // a coin is "trending" if its close at t exceeds its trailing SMA over the last smaN bars
    // that it actually has (≥ half present), using only closes ≤ t.
    const longs: string[] = [];
    for (const c of coins) {
      if (!data[c].has(t) || !data[c].has(tNext)) continue;
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - smaN + 1); j <= i; j++) { const p = data[c].get(days[j]); if (p != null && Number.isFinite(p)) { sum += p; k++; } }
      if (k < Math.max(2, Math.floor(smaN / 2))) continue;
      if (data[c].get(t)! > sum / k) longs.push(c);
    }
    const wMap: Record<string, number> = {};
    let pr = 0;
    if (longs.length) {
      const w = 1 / longs.length;
      for (const c of longs) { pr += w * (data[c].get(tNext)! / data[c].get(t)! - 1); wMap[c] = w; }
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
