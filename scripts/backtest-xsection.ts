/**
 * backtest-xsection — cross-sectional (market-neutral long/short) reversal &
 * momentum across the warehouse coins. This is the single most publicly-confirmed
 * Renaissance/Medallion pattern (Simons' 2008 testimony: balanced long/short,
 * "buy recently out-of-favor, sell recently in-favor"). We have never tested the
 * CROSS-sectional version — only single-asset — so this is a genuinely new edge,
 * run through the same honest gauntlet (Sharpe → walk-forward → PBO/Deflated-Sharpe)
 * that failed single-asset momentum 0/12.
 *
 * Each rebalance day: rank the eligible coins by their L-day return, z-score the
 * cross-section, weight ∝ −z (reversal) or +z (momentum), dollar-neutral & gross-
 * normalized (Σ|w|=1), hold 1 day, charge feeBps on turnover. Long-only nothing —
 * it's market-neutral by construction.
 *
 *   npm run backtest:xsection [-- --fee-bps 10 --min-coins 4]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo, median } from "../src/lib/backtest/candle/stats.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = arg("--fee-bps", 10);
const minCoins = arg("--min-coins", 4);
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const coins = await listProducts("ONE_DAY");
const data: Record<string, Map<number, number>> = {};
const allDays = new Set<number>();
for (const c of coins) {
  const candles = await getCandles(c, "ONE_DAY");
  const m = new Map<number, number>();
  for (const k of candles) { m.set(k.start_unix, k.close); allDays.add(k.start_unix); }
  data[c] = m;
}
const days = [...allDays].sort((a, b) => a - b);

// Market trend regime: BTC efficiency ratio (Mandelbrot, scale-invariant) over a
// trailing window. The cross-sectional MOMENTUM edge is regime-dependent — deploy
// it only when the market is TRENDING; go flat in chop. (Uses the same efficiency
// signal as the decision-pipeline regime gate, applied at the daily/market level.)
const TREND_W = arg("--trend-w", 20);
const TREND_THR = arg("--trend-thr", 0.30);
const btc = days.map((d) => data["BTC-USD"]?.get(d));
function trendingAt(i: number): boolean {
  if (i < TREND_W) return false;
  const a = btc[i], b = btc[i - TREND_W];
  if (a == null || b == null) return false;
  let path = 0;
  for (let k = i - TREND_W + 1; k <= i; k++) { const x = btc[k], y = btc[k - 1]; if (x == null || y == null) return false; path += Math.abs(x - y); }
  return path > 0 && Math.abs(a - b) / path >= TREND_THR; // efficiency ≥ threshold
}

type Variant = { label: string; L: number; sign: number; trendOnly?: boolean }; // sign +1 = reversal, -1 = momentum
const LBs = [1, 2, 3, 5, 10, 20];
const variants: Variant[] = [];
for (const L of LBs) { variants.push({ label: `rev-${L}d`, L, sign: 1 }); variants.push({ label: `mom-${L}d`, L, sign: -1 }); }
for (const L of [5, 10, 20]) variants.push({ label: `momT-${L}d`, L, sign: -1, trendOnly: true }); // trend-gated momentum
const maxL = Math.max(...LBs);

/** Daily long-short portfolio return series for a variant, aligned to start at
 *  index `maxL` so every variant shares the same period index (needed for PBO). */
function portfolioReturns(v: Variant): number[] {
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = maxL; i < days.length - 1; i++) {
    if (v.trendOnly && !trendingAt(i)) { // chop → flat: close any position (turnover), earn 0
      let turn = 0; for (const c of Object.keys(prevW)) turn += Math.abs(prevW[c]);
      rets.push(-turn * feeBps / 1e4); prevW = {}; continue;
    }
    const t = days[i], tPrev = days[i - v.L], tNext = days[i + 1];
    const elig = coins.filter((c) => data[c].has(t) && data[c].has(tPrev) && data[c].has(tNext));
    if (elig.length < minCoins) { rets.push(0); prevW = {}; continue; }
    const lret = elig.map((c) => data[c].get(t)! / data[c].get(tPrev)! - 1);
    const m = avg(lret), sd = std(lret);
    if (sd <= 0) { rets.push(0); continue; }
    let w = lret.map((x) => -v.sign * (x - m) / sd);     // reversal: long low L-return
    const wMean = avg(w); w = w.map((x) => x - wMean);   // enforce dollar-neutral
    const gross = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
    w = w.map((x) => x / gross);                          // gross-normalize Σ|w| = 1
    const nret = elig.map((c) => data[c].get(tNext)! / data[c].get(t)! - 1);
    let pr = 0; for (let j = 0; j < elig.length; j++) pr += w[j] * nret[j];
    const wMap: Record<string, number> = {}; elig.forEach((c, j) => { wMap[c] = w[j]; });
    let turn = 0; for (const c of new Set([...Object.keys(prevW), ...elig])) turn += Math.abs((wMap[c] ?? 0) - (prevW[c] ?? 0));
    rets.push(pr - turn * feeBps / 1e4);
    prevW = wMap;
  }
  return rets;
}

const series = variants.map(portfolioReturns);
const T = series[0].length;
const fullSh = series.map((r) => sharpe(r));
const ann = (s: number) => s * Math.sqrt(365);
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);

// walk-forward: IS 70% picks the best variant; score it on OOS 30%.
const split = Math.floor(T * 0.7);
const isSh = series.map((r) => sharpe(r.slice(0, split)));
const isBest = isSh.reduce((bi, x, i) => (x > isSh[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));

// overfit battery
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 8);
const dsr = deflatedSharpe(series[bestIdx], fullSh);
// FAIR deflation: against the MOMENTUM family only (the plausible selection set).
// Including the sign-flipped reversal variants doubles the apparent trials with
// anti-correlated Sharpes, artificially inflating SR0 and crushing the DSR.
const momIdx = variants.map((_, i) => i).filter((i) => variants[i].sign === -1);
const momBest = momIdx.reduce((bi, i) => (fullSh[i] > fullSh[bi] ? i : bi), momIdx[0]);
const momDsr = deflatedSharpe(series[momBest], momIdx.map((i) => fullSh[i]));
const oosHold = momIdx.filter((i) => sharpe(series[i].slice(split)) > 0).length;
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;

console.log(`\nbacktest-xsection — cross-sectional long/short across ${coins.length} coins · ${feeBps}bps/turn · min ${minCoins} coins · ${T} days\n`);
console.log(`  ${"variant".padEnd(10)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh(30%)".padEnd(12)} ${"cum PnL".padEnd(10)} per-day-Sh`);
const ranked = variants.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh);
for (const { v, i, sh } of ranked) {
  const pnl = cum(series[i]) * 100;
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(10)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(12)} ${`${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}%`.padEnd(10)} ${sh.toFixed(4)}`);
}
console.log(`\n  best (full): ${variants[bestIdx].label}  ann.Sharpe ${ann(fullSh[bestIdx]).toFixed(2)}`);
console.log(`  walk-forward: IS-best ${variants[isBest].label} → OOS ann.Sharpe ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"}`);
console.log(`  overfit battery (all variants): PBO ${PBO.toFixed(2)}  Deflated-Sharpe ${dsr.dsr.toFixed(2)}`);
console.log(`  FAIR (momentum family only): best ${variants[momBest].label} ann.Sharpe ${ann(fullSh[momBest]).toFixed(2)} · Deflated-Sharpe ${momDsr.dsr.toFixed(2)} · ${oosHold}/${momIdx.length} momentum variants held OOS`);
console.log(`  → ${momDsr.dsr > 0.95 && oosHold > momIdx.length / 2 ? "the momentum edge is REAL (OOS-robust + deflation-clean)" : oosHold > momIdx.length / 2 ? "OOS-robust but DSR short of 0.95 — promising, arena-worthy" : "not robust"}`);
console.log(`  (market-neutral by construction: Σweights≈0, gross=1. Crypto = cross-sectional MOMENTUM, not reversal.)\n`);
await closeTsdb();
