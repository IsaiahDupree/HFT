/**
 * backtest-pairs — pairs / relative-value stat-arb across the warehouse coins. A
 * DIFFERENT market-neutral structure than the directional cross-section: trade the
 * mean-reversion of the log-price SPREAD between two coins. Thin TSDB loader over
 * src/lib/backtest/candle/pairs.ts; run through the same honest gauntlet.
 *
 *   npm run backtest:pairs [-- --fee-bps 10]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import { allPairs, defaultPairsVariants, pairsVariantSeries } from "../src/lib/backtest/candle/pairs.ts";
import { equalWeightBuyHoldReturns } from "../src/lib/backtest/candle/cross-asset.ts";
import { proofCouncil, renderProofCouncil } from "../src/lib/backtest/proof-council.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = arg("--fee-bps", 10);

const products = await listProducts("ONE_DAY");
const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rows[c] = await getCandles(c, "ONE_DAY");
const { coins, data, days } = buildPriceSeries(rows);

const pairs = allPairs(coins);
const variants = defaultPairsVariants();
const maxW = Math.max(...variants.map((v) => v.W));
const series = variants.map((v) => pairsVariantSeries(v, pairs, data, days, { feeBps, startIndex: maxW }));

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
console.log(`  → ${PBO < 0.3 && dsr.dsr > 0.95 && oosSh > 0 ? "HARDENED ✓" : oosHold > variants.length / 2 && oosSh > 0 ? "OOS-robust but not strict-hardened — arena-worthy" : "not robust"}`);

// Proof Council — advocate / skeptic / verdict over the walk-forward-selected variant
console.log("\n" + renderProofCouncil(proofCouncil({
  label: variants[isBest].label, bars: T, feeBps,
  oosSharpeAnn: ann(oosSh), fullSharpeAnn: ann(fullSh[isBest]),
  oosHold, variants: variants.length, pbo: PBO, dsr: deflatedSharpe(series[isBest], fullSh).dsr,
  cumPnlPct: cum(series[isBest]) * 100,
})) + "\n");

// One voice — the market-neutral spread book vs equal-weight buy-and-hold (does mean-reversion
// add alpha over owning the basket?).
const beta = equalWeightBuyHoldReturns(coins, data, days, maxW);
const L = Math.min(series[isBest].length, beta.length);
console.log(renderTradeMemo(adviseTrade({
  label: `pairs ${variants[isBest].label}`,
  strategyReturns: series[isBest].slice(0, L), benchmarkReturns: beta.slice(0, L),
  pbo: PBO, dsr: deflatedSharpe(series[isBest], fullSh).dsr, oosFrac: 0.3,
  search: { hypothesesScanned: variants.length, bonferroniSurvivors: 0 },
})) + "\n");
await closeTsdb();
