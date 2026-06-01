/**
 * backtest-pairs — pairs / relative-value stat-arb across the warehouse coins.
 * A DIFFERENT market-neutral structure than backtest-xsection's directional
 * cross-section: trade the mean-reversion of the log-price SPREAD between two
 * coins (long the cheap leg, short the rich leg when the spread z-score is
 * stretched, exit when it reverts). Run through the same honest gauntlet.
 *
 * Per pair (a,b): spread = log(close_a/close_b); rolling z over window W;
 * enter at |z|>entryZ (short spread if z>0), exit at |z|<exitZ; per-pair daily
 * return = pos·(retA−retB)/2 (dollar-neutral, gross 1) − fee on leg turnover.
 * A variant's series = equal-weight average over all active pairs each day.
 * No lookahead: z at day t uses the window ending at t; return is over t→t+1.
 *
 *   npm run backtest:pairs [-- --fee-bps 10]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo, median } from "../src/lib/backtest/candle/stats.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = arg("--fee-bps", 10);
const exitZ = 0.5;
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const coins = await listProducts("ONE_DAY");
const data: Record<string, Map<number, number>> = {};
const allDays = new Set<number>();
for (const c of coins) {
  const m = new Map<number, number>();
  for (const k of await getCandles(c, "ONE_DAY")) { m.set(k.start_unix, k.close); allDays.add(k.start_unix); }
  data[c] = m;
}
const days = [...allDays].sort((a, b) => a - b);
const dayIdx = new Map(days.map((d, i) => [d, i]));
const pairs: Array<[string, string]> = [];
for (let i = 0; i < coins.length; i++) for (let j = i + 1; j < coins.length; j++) pairs.push([coins[i], coins[j]]);

/** Per-pair daily return series indexed by global day index (NaN where inactive). */
function pairReturns(a: string, b: string, W: number, entryZ: number): Map<number, number> {
  const out = new Map<number, number>();
  const ma = data[a], mb = data[b];
  let pos = 0, prevPos = 0;
  for (let i = W; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    // need both coins for the full window [i-W..i] + next day
    let ok = ma.has(tNext) && mb.has(tNext);
    const spreadWin: number[] = [];
    for (let k = i - W; k <= i && ok; k++) {
      const d = days[k];
      if (!ma.has(d) || !mb.has(d)) { ok = false; break; }
      spreadWin.push(Math.log(ma.get(d)! / mb.get(d)!));
    }
    if (!ok) { pos = 0; prevPos = 0; continue; }
    const m = avg(spreadWin), sd = std(spreadWin);
    const z = sd > 0 ? (spreadWin[spreadWin.length - 1] - m) / sd : 0;
    if (Math.abs(z) < exitZ) pos = 0;
    else if (z > entryZ) pos = -1;       // spread rich → short spread (short a, long b)
    else if (z < -entryZ) pos = 1;       // spread cheap → long spread
    const retA = ma.get(tNext)! / ma.get(t)! - 1;
    const retB = mb.get(tNext)! / mb.get(t)! - 1;
    const fee = Math.abs(pos - prevPos) * 2 * (feeBps / 1e4); // two legs
    out.set(i, pos * (retA - retB) / 2 - fee);
    prevPos = pos;
  }
  return out;
}

type Variant = { label: string; W: number; entryZ: number };
const variants: Variant[] = [];
for (const W of [20, 40, 60]) for (const eZ of [1.5, 2, 2.5]) variants.push({ label: `W${W}/z${eZ}`, W, entryZ: eZ });

// Each variant's daily series = equal-weight average over active pairs, aligned to
// the back portion all variants share (start at maxW so the period index lines up).
const maxW = Math.max(...variants.map((v) => v.W));
const series = variants.map((v) => {
  const perPair = pairs.map(([a, b]) => pairReturns(a, b, v.W, v.entryZ));
  const out: number[] = [];
  for (let i = maxW; i < days.length - 1; i++) {
    const vals: number[] = [];
    for (const pr of perPair) { const r = pr.get(i); if (r !== undefined) vals.push(r); }
    out.push(vals.length ? avg(vals) : 0);
  }
  return out;
});
const T = series[0].length;
const fullSh = series.map((r) => sharpe(r));
const ann = (s: number) => s * Math.sqrt(365);
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
const split = Math.floor(T * 0.7);
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, arr) => (x > arr[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 8);
const dsr = deflatedSharpe(series[bestIdx], fullSh);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const oosHold = series.filter((r) => sharpe(r.slice(split)) > 0).length;

console.log(`\nbacktest-pairs — relative-value stat-arb · ${pairs.length} pairs · ${feeBps}bps/turn · ${T} days\n`);
console.log(`  ${"variant".padEnd(10)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} cum PnL`);
for (const { v, i, sh } of variants.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(10)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${(cum(series[i]) * 100).toFixed(0)}%`);
}
console.log(`\n  best (full): ${variants[bestIdx].label} ann.Sharpe ${ann(fullSh[bestIdx]).toFixed(2)}`);
console.log(`  walk-forward: IS-best ${variants[isBest].label} → OOS ann.Sharpe ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"}`);
console.log(`  overfit battery: PBO ${PBO.toFixed(2)}  Deflated-Sharpe ${dsr.dsr.toFixed(2)}  · ${oosHold}/${variants.length} variants held OOS`);
console.log(`  → ${PBO < 0.3 && dsr.dsr > 0.95 && oosSh > 0 ? "HARDENED ✓" : oosHold > variants.length / 2 && oosSh > 0 ? "OOS-robust but not strict-hardened — arena-worthy" : "not robust"}\n`);
await closeTsdb();
