/**
 * backtest-xsection — cross-sectional (market-neutral long/short) reversal & momentum
 * across the warehouse coins. The single most publicly-confirmed Renaissance/Medallion
 * pattern (Simons 2008: balanced long/short, "buy out-of-favor, sell in-favor").
 * Thin TSDB loader over src/lib/backtest/candle/xsection.ts; run through the same honest
 * gauntlet (Sharpe → walk-forward → PBO/Deflated-Sharpe) that failed single-asset 0/12.
 *
 *   npm run backtest:xsection [-- --fee-bps 10 --min-coins 4 --benchmark BTC-USD]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { buildPriceSeries, defaultXSectionVariants, xsectionReturns } from "../src/lib/backtest/candle/xsection.ts";
import { proofCouncil, renderProofCouncil } from "../src/lib/backtest/proof-council.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const argS = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const feeBps = arg("--fee-bps", 10);
const minCoins = arg("--min-coins", 4);
const trendWindow = arg("--trend-w", 20);
const trendThreshold = arg("--trend-thr", 0.3);
const benchmarkCoin = argS("--benchmark", "BTC-USD");

const products = await listProducts("ONE_DAY");
const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rows[c] = await getCandles(c, "ONE_DAY");
const { coins, data, days } = buildPriceSeries(rows);

const variants = defaultXSectionVariants();
const maxL = Math.max(...variants.map((v) => v.L));
const benchmark = days.map((d) => data[benchmarkCoin]?.get(d));
const opts = { feeBps, minCoins, trendWindow, trendThreshold, startIndex: maxL, benchmark };
const series = variants.map((v) => xsectionReturns(v, coins, data, days, opts));

const T = series[0]?.length ?? 0;
const fullSh = series.map((r) => sharpe(r));
const ann = (s: number) => s * Math.sqrt(365);
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
const split = Math.floor(T * 0.7);
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, arr) => (x > arr[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 8);
const dsr = deflatedSharpe(series[bestIdx], fullSh);
// FAIR deflation against the momentum family only (the plausible selection set).
const momIdx = variants.map((_, i) => i).filter((i) => variants[i].sign === -1);
const momBest = momIdx.reduce((bi, i) => (fullSh[i] > fullSh[bi] ? i : bi), momIdx[0]);
const momDsr = deflatedSharpe(series[momBest], momIdx.map((i) => fullSh[i]));
const oosHold = momIdx.filter((i) => sharpe(series[i].slice(split)) > 0).length;
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;

console.log(`\nbacktest-xsection — cross-sectional long/short across ${coins.length} coins · ${feeBps}bps/turn · min ${minCoins} coins · ${T} days\n`);
console.log(`  ${"variant".padEnd(10)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh(30%)".padEnd(12)} ${"cum PnL".padEnd(10)} per-day-Sh`);
for (const { v, i, sh } of variants.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(10)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(12)} ${`${cum(series[i]) * 100 >= 0 ? "+" : ""}${(cum(series[i]) * 100).toFixed(0)}%`.padEnd(10)} ${sh.toFixed(4)}`);
}
console.log(`\n  best (full): ${variants[bestIdx].label}  ann.Sharpe ${ann(fullSh[bestIdx]).toFixed(2)}`);
console.log(`  walk-forward: IS-best ${variants[isBest].label} → OOS ann.Sharpe ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"}`);
console.log(`  overfit battery (all variants): PBO ${PBO.toFixed(2)}  Deflated-Sharpe ${dsr.dsr.toFixed(2)}`);
console.log(`  FAIR (momentum family only): best ${variants[momBest].label} ann.Sharpe ${ann(fullSh[momBest]).toFixed(2)} · Deflated-Sharpe ${momDsr.dsr.toFixed(2)} · ${oosHold}/${momIdx.length} momentum variants held OOS`);
console.log(`  → ${momDsr.dsr > 0.95 && oosHold > momIdx.length / 2 ? "the momentum edge is REAL (OOS-robust + deflation-clean)" : oosHold > momIdx.length / 2 ? "OOS-robust but DSR short of 0.95 — promising, arena-worthy" : "not robust"}`);

// Proof Council — advocate / skeptic / verdict over the FAIR (momentum-family) selection
console.log("\n" + renderProofCouncil(proofCouncil({
  label: variants[momBest].label, bars: T, feeBps,
  oosSharpeAnn: ann(sharpe(series[momBest].slice(split))), fullSharpeAnn: ann(fullSh[momBest]),
  oosHold, variants: momIdx.length, pbo: PBO, dsr: momDsr.dsr,
  cumPnlPct: cum(series[momBest]) * 100,
})) + "\n");
await closeTsdb();
