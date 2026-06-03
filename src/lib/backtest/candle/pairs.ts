/**
 * Pairs / relative-value stat-arb — the pure, data-injected core of
 * scripts/backtest-pairs.ts (extracted so it is unit-testable + arena-reusable).
 *
 * Per pair (a,b): spread = log(close_a/close_b); rolling z over window W; enter at
 * |z| > entryZ (short the spread when z > 0), exit at |z| < exitZ; per-pair daily
 * return = pos·(retA − retB)/2 (dollar-neutral, gross 1) − fee on leg turnover.
 * NO LOOKAHEAD: z at day t uses the window ENDING at t; the realized return is over
 * t→t+1. A variant's daily series = equal-weight average over its active pairs.
 */
import type { PriceSeries } from "./xsection";

export type PairsVariant = { label: string; W: number; entryZ: number };
export type PairsOpts = { feeBps?: number; exitZ?: number };

const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/**
 * Position from a spread window: z = (last − mean)/std over the window (NO LOOKAHEAD —
 * the last point is "today"). Enter at |z| > entryZ (short the spread when z > 0, long
 * when z < 0), exit (flat) at |z| < exitZ, otherwise HOLD the previous position. Pure.
 */
export function pairPosition(spreadWindow: readonly number[], entryZ: number, exitZ: number, prevPos: number): number {
  const w = spreadWindow as number[];
  const m = avg(w), sd = std(w);
  const z = sd > 0 ? (w[w.length - 1] - m) / sd : 0;
  if (Math.abs(z) < exitZ) return 0;
  if (z > entryZ) return -1;
  if (z < -entryZ) return 1;
  return prevPos;
}

/** All unordered coin pairs (i < j). */
export function allPairs(coins: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < coins.length; i++) for (let j = i + 1; j < coins.length; j++) pairs.push([coins[i], coins[j]]);
  return pairs;
}

/**
 * Per-pair daily return series keyed by global day index (absent where the pair is
 * inactive — both coins must cover the full window [i−W..i] plus the next day).
 */
export function pairReturns(
  a: string,
  b: string,
  data: PriceSeries,
  days: readonly number[],
  W: number,
  entryZ: number,
  opts: PairsOpts = {},
): Map<number, number> {
  const feeBps = opts.feeBps ?? 10;
  const exitZ = opts.exitZ ?? 0.5;
  const out = new Map<number, number>();
  const ma = data[a], mb = data[b];
  if (!ma || !mb) return out;
  let pos = 0, prevPos = 0;
  for (let i = W; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    let ok = ma.has(tNext) && mb.has(tNext);
    const spreadWin: number[] = [];
    for (let k = i - W; k <= i && ok; k++) {
      const d = days[k];
      if (!ma.has(d) || !mb.has(d)) { ok = false; break; }
      spreadWin.push(Math.log(ma.get(d)! / mb.get(d)!));
    }
    if (!ok) { pos = 0; prevPos = 0; continue; }
    pos = pairPosition(spreadWin, entryZ, exitZ, pos);
    const retA = ma.get(tNext)! / ma.get(t)! - 1;
    const retB = mb.get(tNext)! / mb.get(t)! - 1;
    const fee = Math.abs(pos - prevPos) * 2 * (feeBps / 1e4); // two legs
    out.set(i, pos * (retA - retB) / 2 - fee);
    prevPos = pos;
  }
  return out;
}

/**
 * One variant's daily portfolio series = equal-weight average over its active pairs,
 * aligned to start at `startIndex` (default maxW across the variant set) so every
 * variant shares the same period index (required for PBO / DSR).
 */
export function pairsVariantSeries(
  v: PairsVariant,
  pairs: ReadonlyArray<[string, string]>,
  data: PriceSeries,
  days: readonly number[],
  opts: PairsOpts & { startIndex?: number } = {},
): number[] {
  const start = opts.startIndex ?? v.W;
  const perPair = pairs.map(([a, b]) => pairReturns(a, b, data, days, v.W, v.entryZ, opts));
  const out: number[] = [];
  for (let i = start; i < days.length - 1; i++) {
    const vals: number[] = [];
    for (const pr of perPair) { const r = pr.get(i); if (r !== undefined) vals.push(r); }
    out.push(vals.length ? avg(vals) : 0);
  }
  return out;
}

/** The standard variant grid: window × entry-z. */
export function defaultPairsVariants(
  windows: readonly number[] = [20, 40, 60],
  entryZs: readonly number[] = [1.5, 2, 2.5],
): PairsVariant[] {
  const variants: PairsVariant[] = [];
  for (const W of windows) for (const eZ of entryZs) variants.push({ label: `W${W}/z${eZ}`, W, entryZ: eZ });
  return variants;
}
