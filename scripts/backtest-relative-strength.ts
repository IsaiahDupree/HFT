/**
 * backtest-relative-strength — cross-asset relative-strength momentum: each rebalance, long
 * the top-K strongest warehouse coins by trailing return (rotation), not each symbol in
 * isolation. Thin TSDB loader over src/lib/backtest/candle/cross-asset.ts; run through the
 * same honest gauntlet (Sharpe → walk-forward → PBO/Deflated-Sharpe) + a Proof Council.
 *
 *   npm run backtest:relstr [-- --fee-bps 10]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import { relativeStrengthReturns, defaultRelStrengthVariants, equalWeightBuyHoldReturns } from "../src/lib/backtest/candle/cross-asset.ts";
import { proofCouncil, renderProofCouncil } from "../src/lib/backtest/proof-council.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { selectUniverse, universeHealth } from "../src/lib/backtest/candle/universe.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = arg("--fee-bps", 10);
const uniIdx = process.argv.indexOf("--universe");
const universe = (uniIdx >= 0 && process.argv[uniIdx + 1] ? process.argv[uniIdx + 1] : "all") as "all" | "usd" | "usdt" | "alive";

const products = await listProducts("ONE_DAY");
const rawRows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rawRows[c] = await getCandles(c, "ONE_DAY");
const rows = selectUniverse(rawRows, universe);
const health = universeHealth(rows);
console.log(`\n  universe=${universe}: ${health.coins} coins, ${health.days} days, active ${health.minActive}–${health.maxActive}/day` +
  (health.spliceSuspected ? ` · ⚠ SPLICE ${health.biggestDrop!.from}→${health.biggestDrop!.to} on ${new Date(health.biggestDrop!.atUnix * 1000).toISOString().slice(0, 10)}` : ` · no splice`));
const { coins, data, days } = buildPriceSeries(rows);

const variants = defaultRelStrengthVariants();
const maxL = Math.max(...variants.map((v) => v.L));
const series = variants.map((v) => relativeStrengthReturns(v, coins, data, days, { feeBps, startIndex: maxL }));

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

console.log(`\nbacktest-relative-strength — long top-K strongest of ${coins.length} coins · ${feeBps}bps/turn · ${T} days\n`);
console.log(`  ${"variant".padEnd(12)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} cum PnL`);
for (const { v, i, sh } of variants.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(12)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${(cum(series[i]) * 100).toFixed(0)}%`);
}
console.log(`\n  best (full): ${variants[bestIdx].label} ann.Sharpe ${ann(fullSh[bestIdx]).toFixed(2)}`);
console.log(`  walk-forward: IS-best ${variants[isBest].label} → OOS ann.Sharpe ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"}`);
console.log(`  overfit battery: PBO ${PBO.toFixed(2)}  Deflated-Sharpe ${dsr.dsr.toFixed(2)}  · ${oosHold}/${variants.length} variants held OOS`);

console.log("\n" + renderProofCouncil(proofCouncil({
  label: variants[isBest].label, bars: T, feeBps,
  oosSharpeAnn: ann(oosSh), fullSharpeAnn: ann(fullSh[isBest]),
  oosHold, variants: variants.length, pbo: PBO, dsr: deflatedSharpe(series[isBest], fullSh).dsr,
  cumPnlPct: cum(series[isBest]) * 100,
})) + "\n");

// Advisor — bull (why buy/trade) + bear (why not) under ONE VOICE. Folds in beta-vs-alpha,
// the overfit gauntlet, AND the data-integrity signal (a universe splice makes the benchmark
// untrustworthy → STAND_ASIDE).
const beta = equalWeightBuyHoldReturns(coins, data, days, maxL);
console.log(renderTradeMemo(adviseTrade({
  label: variants[isBest].label,
  strategyReturns: series[isBest], benchmarkReturns: beta,
  pbo: PBO, dsr: deflatedSharpe(series[isBest], fullSh).dsr, oosFrac: 0.3,
  data: { spliceSuspected: health.spliceSuspected },
})) + "\n");
await closeTsdb();
