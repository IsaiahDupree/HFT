import "./_env.ts";
/**
 * AGGREGATE-FUNDING MARKET TIMING (breadth funding overlay).
 *
 * Hypothesis: when AGGREGATE perp funding across the whole alt universe is very high
 * (everyone levered long / frothy) → forward market returns are LOWER → de-risk.
 * When aggregate funding is negative (capitulation) → forward returns HIGHER → add.
 *
 * Build:
 *   1. A daily AGGREGATE-FUNDING INDEX = cross-sectional mean of each coin's daily funding
 *      (sum of the 8-hourly Binance rates that fall in the UTC day), averaged across all 40
 *      data/funding/*.binance.jsonl coins that have data that day. Market-wide funding breadth.
 *   2. A NO-LOOKAHEAD trailing z-score of that index (window ending at day i, data ≤ i only).
 *   3. A market-timing OVERLAY on equal-weight buy-and-hold: exposure_i = clamp(1 − k·z_i),
 *      i.e. scale exposure by the INVERSE of the aggregate-funding z. Position uses data ≤ i;
 *      the basket return is realized i→i+1 (no lookahead).
 *
 * Compare Sharpe / max-drawdown of TIMED vs UNTIMED (plain equal-weight buy-and-hold) on the
 * SAME universe + window. Then run the overfit gauntlet (sharpe + PBO + Deflated-Sharpe across
 * the k/window variants), a block-shuffle control on the timing signal, and adviseTrade for the
 * one-voice verdict (benchmark = the untimed basket — so "alpha" = value the TIMING adds).
 *
 * Reuses tested + NO-LOOKAHEAD primitives only:
 *   candle-store.getCandles/listProducts, universe.selectUniverse,
 *   cross-asset.equalWeightBuyHoldReturns, stats.sharpe/pbo/deflatedSharpe,
 *   advisor.adviseTrade/renderTradeMemo, shuffle-control.blockShufflePermutation/permutationTest.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCandles, listProducts, closeTsdb } from "../src/lib/db/candle-store";
import { selectUniverse, universeHealth } from "../src/lib/backtest/candle/universe";
import { equalWeightBuyHoldReturns } from "../src/lib/backtest/candle/cross-asset";
import type { PriceSeries } from "../src/lib/backtest/candle/xsection";
import { sharpe, pbo, deflatedSharpe } from "../src/lib/backtest/candle/stats";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor";
import { blockShufflePermutation, applyPermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control";

const DAY = 86_400;
const ANN = Math.sqrt(365);
const GRAN = "ONE_DAY";

// ---------------------------------------------------------------------------
// 1. AGGREGATE-FUNDING INDEX from data/funding/*.binance.jsonl
// ---------------------------------------------------------------------------
const fundingDir = resolve(process.cwd(), "data/funding");
const files = readdirSync(fundingDir).filter((f) => f.endsWith(".binance.jsonl"));

/** coin -> Map(dayUnix -> daily funding = sum of the 8h rates in that UTC day). */
function loadDailyFunding(file: string): Map<number, number> {
  const m = new Map<number, number>();
  const raw = readFileSync(resolve(fundingDir, file), "utf8").trim();
  if (!raw) return m;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o: { time: number; rate: number };
    try { o = JSON.parse(line); } catch { continue; }
    if (!Number.isFinite(o.time) || !Number.isFinite(o.rate)) continue;
    const day = Math.floor(o.time / DAY) * DAY; // UTC-day bucket
    m.set(day, (m.get(day) ?? 0) + o.rate); // sum the (typically 3) 8-hourly prints
  }
  return m;
}

const perCoinFunding: Map<number, number>[] = files.map(loadDailyFunding);

// Cross-sectional MEAN daily funding across all coins present that day → the breadth index.
const aggByDay = new Map<number, { sum: number; n: number }>();
for (const m of perCoinFunding) {
  for (const [day, r] of m) {
    const a = aggByDay.get(day) ?? { sum: 0, n: 0 };
    a.sum += r; a.n += 1; aggByDay.set(day, a);
  }
}
const fundingDays = [...aggByDay.keys()].sort((a, b) => a - b);
const aggFundingIndex = new Map<number, number>(); // day -> mean daily funding (breadth)
const aggBreadth = new Map<number, number>(); // day -> fraction of coins with positive funding
for (const day of fundingDays) {
  const a = aggByDay.get(day)!;
  aggFundingIndex.set(day, a.sum / a.n);
}
// breadth = share of coins with positive daily funding (alternative frothiness gauge)
for (const day of fundingDays) {
  let pos = 0, n = 0;
  for (const m of perCoinFunding) { const v = m.get(day); if (v != null) { n++; if (v > 0) pos++; } }
  if (n) aggBreadth.set(day, pos / n);
}

console.log(`Funding files: ${files.length}. Index days: ${fundingDays.length} ` +
  `(${new Date(fundingDays[0] * 1000).toISOString().slice(0, 10)} → ${new Date(fundingDays.at(-1)! * 1000).toISOString().slice(0, 10)}).`);
const fvals = fundingDays.map((d) => aggFundingIndex.get(d)!);
const fmean = fvals.reduce((s, x) => s + x, 0) / fvals.length;
console.log(`Aggregate daily-funding index: mean=${(fmean * 100).toFixed(4)}%/day, ` +
  `min=${(Math.min(...fvals) * 100).toFixed(4)}%, max=${(Math.max(...fvals) * 100).toFixed(4)}%`);

// ---------------------------------------------------------------------------
// 2. UNIVERSE + EQUAL-WEIGHT BUY-AND-HOLD over the funding window
// ---------------------------------------------------------------------------
// Use a single time-stable cohort to avoid the splice. We try USDT (matches funding's perp
// convention) first; if it doesn't overlap the funding window, fall back to USD (Coinbase).
async function buildUniverse(mode: "usdt" | "usd") {
  const products = (await listProducts(GRAN)).filter((p) => (mode === "usdt" ? /USDT$/i.test(p) : /-USD$/i.test(p)));
  const rows: Record<string, { start_unix: number; close: number }[]> = {};
  for (const p of products) {
    const c = await getCandles(p, GRAN);
    if (c.length) rows[p] = c.map((x) => ({ start_unix: x.start_unix, close: x.close }));
  }
  const cohort = selectUniverse(rows, mode); // restrict to convention (stable membership)
  return cohort;
}

const fundStart = fundingDays[0], fundEnd = fundingDays.at(-1)!;

let universeMode: "usdt" | "usd" = "usdt";
let cohort = await buildUniverse("usdt");
// keep only days inside the funding window
function clipCohort(cohort: Record<string, { start_unix: number; close: number }[]>) {
  const out: Record<string, { start_unix: number; close: number }[]> = {};
  for (const [c, arr] of Object.entries(cohort)) {
    const f = arr.filter((x) => x.start_unix >= fundStart && x.start_unix <= fundEnd + DAY);
    if (f.length > 50) out[c] = f;
  }
  return out;
}
let clipped = clipCohort(cohort);
if (Object.keys(clipped).length < 5) { universeMode = "usd"; cohort = await buildUniverse("usd"); clipped = clipCohort(cohort); }

const health = universeHealth(clipped, { dropThreshold: 10 });
console.log(`Universe=${universeMode}: ${Object.keys(clipped).length} coins, ${health.days} days, ` +
  `active ${health.minActive}-${health.maxActive}, spliceSuspected=${health.spliceSuspected}`);

// Build PriceSeries + the day axis (union of all coin days in the window)
const coins = Object.keys(clipped);
const data: PriceSeries = {};
const daySet = new Set<number>();
for (const c of coins) {
  const m = new Map<number, number>();
  for (const r of clipped[c]) { m.set(r.start_unix, r.close); daySet.add(r.start_unix); }
  data[c] = m;
}
const days = [...daySet].sort((a, b) => a - b);
console.log(`Trading day axis: ${days.length} days ` +
  `(${new Date(days[0] * 1000).toISOString().slice(0, 10)} → ${new Date(days.at(-1)! * 1000).toISOString().slice(0, 10)})`);

// UNTIMED benchmark: plain equal-weight buy-and-hold (start at index 1 so timed/untimed align)
const START = 1;
const baseRets = equalWeightBuyHoldReturns(coins, data, days, START); // length days.length-1-START

// ---------------------------------------------------------------------------
// 3. NO-LOOKAHEAD trailing-z of the aggregate-funding index, aligned to the day axis
// ---------------------------------------------------------------------------
// For each trading day index i, z_i uses the aggregate-funding values for funding-days ≤ days[i]
// over a trailing window. The exposure applied to the i→i+1 basket return uses ONLY z_i (≤ i).
function trailingZSeries(window: number): (number | undefined)[] {
  // value at each trading day = aggregate-funding index on the most recent funding-day ≤ that day
  const idxVals: (number | undefined)[] = days.map((t) => {
    // most recent funding day ≤ t
    let v: number | undefined;
    for (let k = fundingDays.length - 1; k >= 0; k--) { if (fundingDays[k] <= t) { v = aggFundingIndex.get(fundingDays[k]); break; } }
    return v;
  });
  const z: (number | undefined)[] = new Array(days.length).fill(undefined);
  for (let i = 0; i < days.length; i++) {
    const lo = Math.max(0, i - window + 1);
    const win: number[] = [];
    for (let k = lo; k <= i; k++) { const x = idxVals[k]; if (x != null && Number.isFinite(x)) win.push(x); }
    if (win.length < Math.min(20, window)) continue; // need enough history (no lookahead, trailing only)
    const m = win.reduce((s, x) => s + x, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1));
    const cur = idxVals[i];
    if (cur != null && sd > 0) z[i] = (cur - m) / sd;
  }
  return z;
}

// Exposure overlay: e_i = clamp(1 − k·z_i, [eMin, eMax]). High funding (z>0) → de-risk; z<0 → add.
function timedReturns(z: (number | undefined)[], k: number, eMin: number, eMax: number): number[] {
  const out: number[] = [];
  for (let i = START; i < days.length - 1; i++) {
    const zi = z[i]; // signal known at day i (≤ i), applied to the i→i+1 basket return
    const exp = zi == null ? 1 : Math.max(eMin, Math.min(eMax, 1 - k * zi));
    out.push(exp * baseRets[i - START]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. GAUNTLET over a small grid of (window, k), benchmark = untimed basket
// ---------------------------------------------------------------------------
const maxDD = (rets: number[]) => {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; if (eq > peak) peak = eq; dd = Math.min(dd, eq / peak - 1); }
  return dd;
};
const cum = (a: number[]) => a.reduce((e, x) => e * (1 + x), 1) - 1;

const windows = [30, 45, 60, 90];
const ks = [0.25, 0.5, 0.75, 1.0];
type Cell = { label: string; window: number; k: number; rets: number[]; z: (number | undefined)[] };
const cells: Cell[] = [];
for (const w of windows) {
  const z = trailingZSeries(w);
  for (const k of ks) cells.push({ label: `w${w}_k${k}`, window: w, k, rets: timedReturns(z, k, 0, 2), z });
}

// PBO matrix: M[t][c] = cell c's return at bar t
const T = cells[0].rets.length;
const M: number[][] = [];
for (let t = 0; t < T; t++) M.push(cells.map((c) => c.rets[t]));

const trialSharpes = cells.map((c) => sharpe(c.rets));
// best variant by ann. Sharpe (the thing we'd actually deploy)
let best = cells[0], bestSh = sharpe(cells[0].rets);
for (const c of cells) { const s = sharpe(c.rets); if (s > bestSh) { bestSh = s; best = c; } }

const baseSharpeAnn = sharpe(baseRets) * ANN;
const bestSharpeAnn = sharpe(best.rets) * ANN;
const ds = deflatedSharpe(best.rets, trialSharpes);
const pboVal = pbo(M, 8);

console.log("\n=== TIMED vs UNTIMED (per cell) ===");
console.log("cell        annSharpe   cum%     maxDD%");
for (const c of cells) {
  console.log(`${c.label.padEnd(11)} ${(sharpe(c.rets) * ANN).toFixed(3).padStart(8)}  ${(cum(c.rets) * 100).toFixed(1).padStart(7)}  ${(maxDD(c.rets) * 100).toFixed(1).padStart(7)}`);
}
console.log(`\nUNTIMED basket: annSharpe=${baseSharpeAnn.toFixed(3)}  cum%=${(cum(baseRets) * 100).toFixed(1)}  maxDD%=${(maxDD(baseRets) * 100).toFixed(1)}`);
console.log(`BEST timed (${best.label}): annSharpe=${bestSharpeAnn.toFixed(3)}  cum%=${(cum(best.rets) * 100).toFixed(1)}  maxDD%=${(maxDD(best.rets) * 100).toFixed(1)}`);
console.log(`Gauntlet: PBO=${pboVal.toFixed(3)}  DSR=${ds.dsr.toFixed(3)}  SR0(deflate)=${ds.sr0.toFixed(3)}  bars=${T}`);

// excess = timed − untimed (value the timing adds); correlation of z with fwd return
const excess = best.rets.map((r, i) => r - baseRets[i]);
console.log(`Excess (best timed − untimed): annSharpe=${(sharpe(excess) * ANN).toFixed(3)}  cum%=${(cum(excess) * 100).toFixed(1)}`);

// Direct hypothesis test: does HIGH funding-z predict LOW next-day basket return?
// corr(z_i, baseRet_{i→i+1}). Hypothesis says NEGATIVE.
{
  const xs: number[] = [], ys: number[] = [];
  const z = best.z;
  for (let i = START; i < days.length - 1; i++) { if (z[i] != null) { xs.push(z[i]!); ys.push(baseRets[i - START]); } }
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const corr = num / Math.sqrt(dx * dy);
  console.log(`corr(funding-z_i, next-day basket return) = ${corr.toFixed(4)} (n=${xs.length}; hypothesis predicts NEGATIVE)`);
}

// ---------------------------------------------------------------------------
// 5. SHUFFLE CONTROL — block-shuffle the timing exposure vs the basket returns.
// If the funding signal carries real timing information, the REAL alignment should
// beat shuffled alignments. Null statistic = ann. Sharpe of the timed series when the
// per-day exposure multiplier is block-shuffled (temporal link to returns destroyed).
// ---------------------------------------------------------------------------
const exposures = best.rets.map((r, i) => (baseRets[i] !== 0 ? r / baseRets[i] : 1)); // recovered exposure per bar
const rng = lcgRng(12345);
const nPerm = 1000;
const blockSize = 5;
const nullSharpes: number[] = [];
const nullExcess: number[] = [];
for (let p = 0; p < nPerm; p++) {
  const perm = blockShufflePermutation(exposures.length, blockSize, rng);
  const shExp = applyPermutation(exposures, perm);
  const shTimed = baseRets.map((r, i) => shExp[i] * r);
  nullSharpes.push(sharpe(shTimed) * ANN);
  nullExcess.push(sharpe(shTimed.map((r, i) => r - baseRets[i])) * ANN);
}
const pSharpe = permutationTest(bestSharpeAnn, nullSharpes, "greater");
const pExcess = permutationTest(sharpe(excess) * ANN, nullExcess, "greater");
console.log(`\n=== SHUFFLE CONTROL (n=${nPerm}, block=${blockSize}) ===`);
console.log(`timed annSharpe vs shuffled-exposure null: observed=${bestSharpeAnn.toFixed(3)}, p=${pSharpe.pValue.toFixed(3)} (exceed ${pSharpe.exceed}/${nPerm})`);
console.log(`excess annSharpe vs shuffled-exposure null: observed=${(sharpe(excess) * ANN).toFixed(3)}, p=${pExcess.pValue.toFixed(3)} (exceed ${pExcess.exceed}/${nPerm})`);

// ---------------------------------------------------------------------------
// 6. ONE-VOICE VERDICT (advisor) — benchmark = untimed basket → "alpha" = timing value
// ---------------------------------------------------------------------------
const memo = adviseTrade({
  label: `aggregate-funding timing (${best.label}, ${universeMode})`,
  strategyReturns: best.rets,
  benchmarkReturns: baseRets,
  pbo: pboVal,
  dsr: ds.dsr,
  oosFrac: 0.3,
  data: { spliceSuspected: health.spliceSuspected },
  search: { hypothesesScanned: cells.length, bonferroniSurvivors: 0 },
});
console.log("\n" + renderTradeMemo(memo));

console.log("\n=== SUMMARY (machine) ===");
console.log(JSON.stringify({
  universe: universeMode, coins: coins.length, bars: T,
  baseSharpeAnn: +baseSharpeAnn.toFixed(3), bestSharpeAnn: +bestSharpeAnn.toFixed(3),
  excessSharpeAnn: +(sharpe(excess) * ANN).toFixed(3),
  bestCell: best.label, pbo: +pboVal.toFixed(3), dsr: +ds.dsr.toFixed(3),
  pShuffleSharpe: +pSharpe.pValue.toFixed(3), pShuffleExcess: +pExcess.pValue.toFixed(3),
  baseMaxDD: +(maxDD(baseRets) * 100).toFixed(1), bestMaxDD: +(maxDD(best.rets) * 100).toFixed(1),
  recommendation: memo.recommendation, roiVerdict: memo.advice.roiVerdict, conviction: memo.conviction,
}));

await closeTsdb();

// ---------------------------------------------------------------------------
// 7. CONFOUND CHECK — strip the "lower average gross" effect. In a one-way bear
// market ANY de-grossing improves Sharpe. Re-normalize the best exposure to the
// SAME mean gross as untimed (=1), so only the TIMING (when it leans in/out) can
// help. If excess-Sharpe collapses to ~0 here, the "edge" was just lower beta.
// ---------------------------------------------------------------------------
{
  const exp = best.rets.map((r, i) => (baseRets[i] !== 0 ? r / baseRets[i] : 1));
  const meanExp = exp.reduce((s, x) => s + x, 0) / exp.length;
  const normExp = exp.map((x) => (meanExp > 0 ? x / meanExp : 1)); // mean gross = 1, same as untimed
  const normTimed = baseRets.map((r, i) => normExp[i] * r);
  const normExcess = normTimed.map((r, i) => r - baseRets[i]);
  const rng2 = lcgRng(999);
  const nullNorm: number[] = [];
  for (let p = 0; p < 1000; p++) {
    const perm = blockShufflePermutation(normExp.length, 5, rng2);
    const sh = applyPermutation(normExp, perm);
    nullNorm.push(sharpe(baseRets.map((r, i) => sh[i] * r).map((r, i) => r - baseRets[i])) * ANN);
  }
  const pNorm = permutationTest(sharpe(normExcess) * ANN, nullNorm, "greater");
  console.log(`\n=== CONFOUND CHECK (mean-gross normalized to 1) ===`);
  console.log(`avg exposure of best cell = ${meanExp.toFixed(3)} (untimed = 1.000) — lower means the win is partly just LESS BETA`);
  console.log(`pure-timing (gross-normalized) excess annSharpe = ${(sharpe(normExcess) * ANN).toFixed(3)}, shuffle p = ${pNorm.pValue.toFixed(3)}`);
}
