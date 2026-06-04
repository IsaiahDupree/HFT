/**
 * regime-analysis — the honest follow-up to the relstr beta-vs-alpha audit: is there a REGIME
 * in which a portfolio strategy beats equal-weight buy-and-hold OUT-OF-SAMPLE? Scans strategy ×
 * regime cells and reports candidates, with FULL multiple-testing disclosure (every cell is a
 * hypothesis; the more we scan, the higher the bar a survivor must clear).
 *
 *   npm run analyze:regime [-- --fee-bps 10 --oos 0.3 --min-oos 60 --min-excess 0.3]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import {
  relativeStrengthReturns, defaultRelStrengthVariants, equalWeightBuyHoldReturns, equalWeightTrendReturns,
} from "../src/lib/backtest/candle/cross-asset.ts";
import {
  volRegimeLabels, trendRegimeLabels, breadthRegimeLabels, combineLabels,
  regimeConditionalAlpha, candidateConditionalEdges, multipleTestingReport, type ConditionalAlpha,
} from "../src/lib/backtest/candle/regime.ts";
import { selectUniverse, universeHealth } from "../src/lib/backtest/candle/universe.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const num = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const str = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const feeBps = num("--fee-bps", 10);
const oosFrac = num("--oos", 0.3);
const minOos = num("--min-oos", 60);
const minExcess = num("--min-excess", 0.3);
const universe = str("--universe", "all") as "all" | "usd" | "usdt" | "alive";

const products = await listProducts("ONE_DAY");
const rawRows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rawRows[c] = await getCandles(c, "ONE_DAY");
const rows = selectUniverse(rawRows, universe);
const health = universeHealth(rows);
console.log(`\n  universe=${universe}: ${health.coins} coins, ${health.days} days, active ${health.minActive}–${health.maxActive}/day` +
  (health.spliceSuspected ? ` · ⚠ SPLICE: ${health.biggestDrop!.from}→${health.biggestDrop!.to} coins on ${new Date(health.biggestDrop!.atUnix * 1000).toISOString().slice(0, 10)}` : ` · no splice`));
const { coins, data, days } = buildPriceSeries(rows);

// Strategy series (portfolio-level, comparable to the beta benchmark). Align all at startIndex.
const relVariants = defaultRelStrengthVariants();
const maxL = Math.max(...relVariants.map((v) => v.L), 50); // 50 = max regime SMA warmup
const beta = equalWeightBuyHoldReturns(coins, data, days, maxL);

type Strat = { label: string; rets: number[] };
const strategies: Strat[] = [
  ...relVariants.map((v) => ({ label: v.label, rets: relativeStrengthReturns(v, coins, data, days, { feeBps, startIndex: maxL }) })),
  ...[20, 50, 100].map((n) => ({ label: `trend${n}`, rets: equalWeightTrendReturns(coins, data, days, n, { feeBps, startIndex: maxL }) })),
];

// Regimes over the universe / BTC, sliced to align with the strategy series [maxL, days.length-1).
const btcKey = coins.find((c) => /^BTC[-]?USD/i.test(c)) ?? coins[0];
const btc = days.map((d) => data[btcKey]?.get(d) ?? NaN);
const sliceTo = (a: string[]) => a.slice(maxL, days.length - 1);
const vol = sliceTo(volRegimeLabels(btc));
const trend = sliceTo(trendRegimeLabels(btc));
const breadth = sliceTo(breadthRegimeLabels(coins, data, days));
const dims: Array<{ name: string; labels: string[] }> = [
  { name: "vol", labels: vol },
  { name: "trend", labels: trend },
  { name: "breadth", labels: breadth },
  { name: "trend×vol", labels: combineLabels(trend, vol) },
];

console.log(`\nregime-analysis — does any strategy beat equal-weight buy-and-hold WITHIN a regime, OOS?`);
console.log(`  universe ${coins.length} coins · ${beta.length} bars · ${feeBps}bps · OOS=${oosFrac} · min-OOS-bars=${minOos} · min-excess-Sharpe=${minExcess}\n`);

const allCells: Array<ConditionalAlpha & { strat: string; dim: string }> = [];
for (const s of strategies) {
  for (const dim of dims) {
    for (const cell of regimeConditionalAlpha(s.rets, beta, dim.labels, { oosFrac })) {
      allCells.push({ ...cell, strat: s.label, dim: dim.name });
    }
  }
}

const leads = candidateConditionalEdges(allCells, { minExcessOos: minExcess, minOosBars: minOos })
  .map((c) => allCells.find((x) => x === c)!);
const report = multipleTestingReport(allCells, { alpha: 0.05, minOosBars: minOos });

console.log(`  scanned ${allCells.length} strategy×regime cells; ${report.nHypotheses} had ≥${minOos} OOS bars (the real hypothesis count).`);
console.log(`  ${leads.length} beat buy-and-hold OOS by ≥${minExcess} excess-Sharpe — but that's the WRONG bar (it ignores sample size + multiple testing).`);
console.log(`  Bonferroni at family-wise 0.05 over ${report.nHypotheses} tests → a cell must clear t > ${report.critT.toFixed(2)}.`);
console.log(`  (~${report.expectedFalse.toFixed(0)} of the ${leads.length} "leads" are expected by chance at uncorrected p<0.05.)\n`);

// (1) The honest verdict: how many survive multiple-testing correction?
if (!report.survivors.length) {
  console.log(`  ✗ STATISTICAL VERDICT: 0 / ${report.nHypotheses} cells survive Bonferroni. No single regime cell is a confirmed edge.`);
} else {
  console.log(`  ✓ ${report.survivors.length} cell(s) survive Bonferroni (t > ${report.critT.toFixed(2)}) — genuine leads to verify out-of-sample:`);
  for (const c of report.survivors as Array<ConditionalAlpha & { strat: string; dim: string }>) {
    console.log(`    ${c.strat} · ${c.dim}:${c.label} · t=${c.tStatOos.toFixed(2)} · OOSexcess Sharpe ${c.excessSharpeOos.toFixed(2)} · nOOS ${c.nOos}`);
  }
}

// (2) Top leads with their ACTUAL t-stats, so the reader sees why big Sharpes ≠ significance.
console.log(`\n  top leads by OOS excess Sharpe (note the t-stats — most don't clear ${report.critT.toFixed(2)}):`);
console.log(`  ${"strat".padEnd(11)} ${"regime".padEnd(20)} ${"OOSexc".padEnd(7)} ${"t".padEnd(6)} ${"nOOS".padEnd(6)} ${"stratOOS".padEnd(9)} betaOOS`);
for (const c of leads.slice(0, 12) as Array<ConditionalAlpha & { strat: string; dim: string }>) {
  console.log(`  ${c.strat.padEnd(11)} ${`${c.dim}:${c.label}`.padEnd(20)} ${c.excessSharpeOos.toFixed(2).padEnd(7)} ${c.tStatOos.toFixed(2).padEnd(6)} ${String(c.nOos).padEnd(6)} ${c.stratSharpeOos.toFixed(2).padEnd(9)} ${c.betaSharpeOos.toFixed(2)}`);
}

// (3) The ECONOMIC pattern that IS robust regardless of any single cell's significance:
//     defensive / crisis-alpha cells where the strategy is POSITIVE while buy-and-hold is NEGATIVE.
const defensive = (allCells as Array<ConditionalAlpha & { strat: string; dim: string }>)
  .filter((c) => c.nOos >= minOos && c.betaSharpeOos < 0 && c.stratSharpeOos > 0)
  .sort((a, b) => (b.stratSharpeOos - b.betaSharpeOos) - (a.stratSharpeOos - a.betaSharpeOos));
console.log(`\n  DEFENSIVE pattern — strategy POSITIVE while buy-and-hold NEGATIVE (crisis-alpha signature): ${defensive.length} cells.`);
for (const c of defensive.slice(0, 8)) {
  console.log(`    ${c.strat.padEnd(10)} ${`${c.dim}:${c.label}`.padEnd(22)} stratOOS ${c.stratSharpeOos.toFixed(2)} vs betaOOS ${c.betaSharpeOos.toFixed(2)} · nOOS ${c.nOos}`);
}
const trendDef = defensive.filter((c) => c.strat.startsWith("trend")).length;
console.log(`    (${trendDef}/${defensive.length} are the equal-weight TREND portfolios — trend-following's long-vol / go-to-cash property.)`);

console.log(`\n  BOTTOM LINE: ${report.survivors.length === 0 ? "no cell is individually significant after correction" : `${report.survivors.length} cell(s) survive correction`}; the robust, economically-sensible signal is`);
console.log(`  trend-following's DEFENSIVE behavior (positive when beta is negative), not a tradeable per-regime alpha. Next: pre-register ONE`);
console.log(`  hypothesis (trend portfolio as a beta-diversifier in bear/low-vol) and test it on a longer / out-of-universe sample — don't scan.`);

// One-voice verdict on the BEST strategy this scan surfaced — passing the REAL search width
// (hypotheses scanned + Bonferroni survivors) so a scanned "edge" is correctly downgraded.
const best = strategies.reduce((b, s) => (sharpe(s.rets) > sharpe(b.rets) ? s : b), strategies[0]);
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `${best.label} (best of scan)`,
  strategyReturns: best.rets, benchmarkReturns: beta, oosFrac,
  data: { spliceSuspected: health.spliceSuspected },
  search: { hypothesesScanned: report.nHypotheses, bonferroniSurvivors: report.survivors.length },
})) + "\n");
await closeTsdb();
