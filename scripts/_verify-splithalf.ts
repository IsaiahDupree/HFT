/**
 * _verify-splithalf — SPLIT-HALF OOS STABILITY test of the DEFENSIVE-trend claim.
 *
 * The committed claim says the robust signal is trend-following's DEFENSIVE behavior:
 * 20 cells where stratSharpeOos>0 while betaSharpeOos<0 (crisis-alpha signature), with
 * nOos>=60. This script tests whether that defensive pattern is STABLE across time by
 * splitting the out-of-sample tail into two DISJOINT chronological sub-periods (first half
 * and second half of OOS) and counting defensive cells SEPARATELY in each half.
 *
 * The claim HOLDS only if the defensive pattern shows up in BOTH halves (not just one).
 *
 * Mirrors scripts/regime-analysis.ts exactly for series + regime construction; the ONLY
 * difference is the OOS window is split in two. Uses REAL warehouse data. No src/ edits.
 *
 *   npx tsx scripts/_verify-splithalf.ts
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import {
  relativeStrengthReturns, defaultRelStrengthVariants, equalWeightBuyHoldReturns, equalWeightTrendReturns,
} from "../src/lib/backtest/candle/cross-asset.ts";
import {
  volRegimeLabels, trendRegimeLabels, breadthRegimeLabels, combineLabels, type RegimeLabel,
} from "../src/lib/backtest/candle/regime.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";

const num = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = num("--fee-bps", 10);
const oosFrac = num("--oos", 0.3);
// Per-HALF minimum bars. Full-OOS uses 60; each half is ~half the bars, so a 60-bar full cell
// becomes ~30/half. Report at two thresholds so the verdict isn't an artifact of the cutoff:
//   strict = 60 (same bar as the headline; harsh on halves), lenient = 30 (per-half scaled).
const minHalfStrict = num("--min-half-strict", 60);
const minHalfLenient = num("--min-half-lenient", 30);

const ann = (s: number): number => s * Math.sqrt(365);

const products = await listProducts("ONE_DAY");
const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rows[c] = await getCandles(c, "ONE_DAY");
const { coins, data, days } = buildPriceSeries(rows);

// --- Build strategy + beta series EXACTLY as regime-analysis.ts ---
const relVariants = defaultRelStrengthVariants();
const maxL = Math.max(...relVariants.map((v) => v.L), 50);
const beta = equalWeightBuyHoldReturns(coins, data, days, maxL);

type Strat = { label: string; rets: number[] };
const strategies: Strat[] = [
  ...relVariants.map((v) => ({ label: v.label, rets: relativeStrengthReturns(v, coins, data, days, { feeBps, startIndex: maxL }) })),
  ...[20, 50, 100].map((n) => ({ label: `trend${n}`, rets: equalWeightTrendReturns(coins, data, days, n, { feeBps, startIndex: maxL }) })),
];

const btc = days.map((d) => data["BTC-USD"]?.get(d) ?? NaN);
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

const N = beta.length;                                   // total aligned bars
const split = Math.floor(N * (1 - oosFrac));             // start of OOS tail (same as lib)
const oosStart = split;
const oosEnd = N;                                        // exclusive
const oosMid = oosStart + Math.floor((oosEnd - oosStart) / 2); // disjoint halves: [start,mid) [mid,end)

console.log(`\nsplit-half OOS stability — is the DEFENSIVE pattern present in BOTH halves of OOS?`);
console.log(`  universe ${coins.length} coins · ${N} bars · ${feeBps}bps · OOS=${oosFrac}`);
console.log(`  full timeline bars [0,${N}); OOS tail [${oosStart},${oosEnd}) = ${oosEnd - oosStart} bars`);
console.log(`  H1 (first half OOS)  = [${oosStart},${oosMid})  ${oosMid - oosStart} bars`);
console.log(`  H2 (second half OOS) = [${oosMid},${oosEnd})  ${oosEnd - oosMid} bars\n`);

// --- Defensive-cell counter over an arbitrary [lo,hi) sub-window ---
type Cell = { strat: string; dim: string; label: RegimeLabel; nWin: number; stratSh: number; betaSh: number };
function defensiveCells(lo: number, hi: number, minBars: number): Cell[] {
  const out: Cell[] = [];
  for (const s of strategies) {
    for (const dim of dims) {
      const labelsSet = [...new Set(dim.labels)].filter((l) => l !== "UNKNOWN");
      for (const label of labelsSet) {
        const idx: number[] = [];
        for (let i = lo; i < hi; i++) if (dim.labels[i] === label) idx.push(i);
        if (idx.length < minBars) continue;
        const stratSh = ann(sharpe(idx.map((i) => s.rets[i])));
        const betaSh = ann(sharpe(idx.map((i) => beta[i])));
        if (stratSh > 0 && betaSh < 0) out.push({ strat: s.label, dim: dim.name, label, nWin: idx.length, stratSh, betaSh });
      }
    }
  }
  return out.sort((a, b) => (b.stratSh - b.betaSh) - (a.stratSh - a.betaSh));
}

function key(c: Cell): string { return `${c.strat}|${c.dim}:${c.label}`; }

for (const minBars of [minHalfStrict, minHalfLenient]) {
  const full = defensiveCells(oosStart, oosEnd, minBars); // sanity: full OOS at this threshold
  const h1 = defensiveCells(oosStart, oosMid, minBars);
  const h2 = defensiveCells(oosMid, oosEnd, minBars);
  const h1k = new Set(h1.map(key)), h2k = new Set(h2.map(key));
  const both = h1.filter((c) => h2k.has(key(c)));
  const h1Only = h1.filter((c) => !h2k.has(key(c)));
  const h2Only = h2.filter((c) => !h1k.has(key(c)));

  console.log(`=== min bars per window = ${minBars} ===`);
  console.log(`  full-OOS defensive cells: ${full.length}`);
  console.log(`  H1 defensive: ${h1.length}   H2 defensive: ${h2.length}`);
  console.log(`  in BOTH halves: ${both.length}   H1-only: ${h1Only.length}   H2-only: ${h2Only.length}`);
  // trend-family share in each half
  const tf = (cs: Cell[]) => cs.filter((c) => c.strat.startsWith("trend")).length;
  console.log(`  trend-family share — H1 ${tf(h1)}/${h1.length}, H2 ${tf(h2)}/${h2.length}, both ${tf(both)}/${both.length}`);
  if (both.length) {
    console.log(`  example cells present in BOTH halves (defensive in each):`);
    for (const c of both.slice(0, 6)) {
      const m1 = h1.find((x) => key(x) === key(c))!, m2 = h2.find((x) => key(x) === key(c))!;
      console.log(`    ${c.strat.padEnd(10)} ${`${c.dim}:${c.label}`.padEnd(22)} H1 strat ${m1.stratSh.toFixed(2)}/beta ${m1.betaSh.toFixed(2)} (n${m1.nWin}) · H2 strat ${m2.stratSh.toFixed(2)}/beta ${m2.betaSh.toFixed(2)} (n${m2.nWin})`);
    }
  }
  if (h1Only.length) {
    console.log(`  example H1-only (defensive in H1, NOT in H2):`);
    for (const c of h1Only.slice(0, 3)) console.log(`    ${c.strat.padEnd(10)} ${`${c.dim}:${c.label}`.padEnd(22)} H1 strat ${c.stratSh.toFixed(2)}/beta ${c.betaSh.toFixed(2)} (n${c.nWin})`);
  }
  if (h2Only.length) {
    console.log(`  example H2-only (defensive in H2, NOT in H1):`);
    for (const c of h2Only.slice(0, 3)) console.log(`    ${c.strat.padEnd(10)} ${`${c.dim}:${c.label}`.padEnd(22)} H2 strat ${c.stratSh.toFixed(2)}/beta ${c.betaSh.toFixed(2)} (n${c.nWin})`);
  }
  // Track the headline-claim cells specifically
  const headlines = [
    { strat: "trend100", dim: "trend×vol", label: "BEAR|LOW_VOL" },
    { strat: "rs30/top1", dim: "trend×vol", label: "BULL|LOW_VOL" },
  ];
  for (const hl of headlines) {
    const inH1 = h1.find((c) => c.strat === hl.strat && c.dim === hl.dim && c.label === hl.label);
    const inH2 = h2.find((c) => c.strat === hl.strat && c.dim === hl.dim && c.label === hl.label);
    console.log(`  headline ${hl.strat} ${hl.dim}:${hl.label} → H1 ${inH1 ? `DEF (strat ${inH1.stratSh.toFixed(2)}/beta ${inH1.betaSh.toFixed(2)})` : "no"}, H2 ${inH2 ? `DEF (strat ${inH2.stratSh.toFixed(2)}/beta ${inH2.betaSh.toFixed(2)})` : "no"}`);
  }
  console.log("");
}

await closeTsdb();
