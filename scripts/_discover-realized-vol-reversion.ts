/**
 * _discover-realized-vol-reversion — VOLATILITY MEAN-REVERSION / VOL-TIMING.
 *
 * Hypothesis: realized vol clusters (positive autocorrelation) AND mean-reverts —
 * a high-vol STATE (top decile) predicts LOWER forward realized vol. If so, a
 * risk-management overlay that flattens buy-and-hold when realized vol is in its
 * top decile should cut drawdown and (maybe) improve risk-adjusted return.
 *
 * What it measures, all NO-LOOKAHEAD:
 *  (1) lag-1 autocorr of realized vol   — does vol cluster?
 *  (2) E[next-period vol | high-vol]  vs  E[next-period vol | not-high]
 *      — does a top-decile vol state forecast LOWER forward vol? (mean-reversion)
 *  (3) vol-gated buy-&-hold vs plain buy-&-hold (Sharpe + max DD), per coin and
 *      pooled equal-weight. Gate at i uses an EXPANDING decile threshold from
 *      vol values strictly ≤ i (no peeking). Position held i→i+1.
 *  (4) Gauntlet: annualized Sharpe, PBO (coins = config axis), Deflated Sharpe,
 *      adviseTrade one-voice verdict, + a block-shuffle permutation control on
 *      the pooled gated-minus-bh excess series.
 *
 *   cd HFT-work && npx tsx scripts/_discover-realized-vol-reversion.ts [--vol-n 20] [--fee-bps 10] [--universe usd]
 */
import "./_env.ts";
import { getCandles, listProducts, closeTsdb } from "../src/lib/db/candle-store.ts";
import { type DailyCandle } from "../src/lib/backtest/candle/engine.ts";
import { realizedVol } from "../src/lib/backtest/candle/indicators.ts";
import { sharpe, pbo, deflatedSharpe, median } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { selectUniverse, universeHealth } from "../src/lib/backtest/candle/universe.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const VOL_N = arg("--vol-n", 20);
const FEE_BPS = arg("--fee-bps", 10);
const UNIVERSE = argStr("--universe", "usd") as "all" | "usd" | "usdt" | "alive";
const TOP_DECILE = 0.90;     // flatten when vol is at/above the 90th pctile of its own expanding history
const WARMUP = 120;          // bars before the expanding decile threshold is allowed to act (stable quantile)
const PER_YEAR = 365;
const annualize = (s: number) => s * Math.sqrt(PER_YEAR);

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function maxDrawdown(rets: number[]): number {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); if (peak > 0) mdd = Math.max(mdd, (peak - eq) / peak); }
  return mdd;
}
/** lag-1 autocorrelation of a finite-only series. */
function autocorr1(x: number[]): number {
  const v = x.filter((y) => Number.isFinite(y));
  if (v.length < 3) return NaN;
  const m = mean(v);
  let num = 0, den = 0;
  for (let i = 0; i < v.length; i++) den += (v[i] - m) ** 2;
  for (let i = 1; i < v.length; i++) num += (v[i] - m) * (v[i - 1] - m);
  return den > 0 ? num / den : NaN;
}
/** p-th quantile of a copy-sorted array (finite only). */
function quantile(arr: number[], p: number): number {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/**
 * NO-LOOKAHEAD vol gate: at bar i, "high vol" if vol[i] >= the TOP_DECILE quantile
 * of {vol[k] : k <= i, finite}. Returns a boolean mask aligned to candles.
 * The threshold at i uses ONLY vol values through i (expanding window).
 */
function highVolMaskExpanding(vol: number[]): boolean[] {
  const mask = new Array(vol.length).fill(false);
  const hist: number[] = [];
  for (let i = 0; i < vol.length; i++) {
    if (Number.isFinite(vol[i])) {
      // decide using history INCLUDING i (the value is known at close i)
      hist.push(vol[i]);
      if (i >= WARMUP && hist.length >= 30) {
        const thr = quantile(hist, TOP_DECILE);
        mask[i] = vol[i] >= thr;
      }
    }
  }
  return mask;
}

/** per-bar buy-&-hold return realized i->i+1 (no fee; it's "always long 1"). */
function bhReturns(c: DailyCandle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length - 1; i++) out.push(c[i + 1].close / c[i].close - 1);
  return out;
}
/** per-bar GATED buy-&-hold: position 1 unless high-vol at i (then 0). Fee on |Δpos|. */
function gatedReturns(c: DailyCandle[], mask: boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length - 1; i++) {
    const pos = mask[i] ? 0 : 1;
    const prev = i > 0 ? (mask[i - 1] ? 0 : 1) : 0;
    const gross = pos * (c[i + 1].close / c[i].close - 1);
    out.push(gross - Math.abs(pos - prev) * (FEE_BPS / 1e4));
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log(`\n=== VOL MEAN-REVERSION / VOL-TIMING DISCOVERY ===`);
console.log(`vol-n=${VOL_N}  topDecile=${TOP_DECILE}  warmup=${WARMUP}  fee=${FEE_BPS}bps  universe=${UNIVERSE}\n`);

const allProducts = await listProducts("ONE_DAY");
// Build a row map for universe selection (need start_unix-bearing rows).
const rowMap: Record<string, DailyCandle[]> = {};
for (const p of allProducts) {
  const c = await getCandles(p, "ONE_DAY");
  if (c.length > WARMUP + VOL_N + 40) rowMap[p] = c.map((x) => ({ ...x }));
}
const selected = selectUniverse(rowMap, UNIVERSE);
const health = universeHealth(selected as any);
const coins = Object.keys(selected).sort();
console.log(`Universe '${UNIVERSE}': ${coins.length} coins. spliceSuspected=${health.spliceSuspected} (biggestDrop lost=${health.biggestDrop?.lost ?? 0}). coins=${coins.join(",")}\n`);

if (!coins.length) {
  console.log("No coins in universe — abort.");
  await closeTsdb();
  process.exit(0);
}

// ---------- (1)+(2) autocorr + conditional forward-vol ----------
let acSum = 0, acN = 0;
let fwdHiSum = 0, fwdHiN = 0, fwdLoSum = 0, fwdLoN = 0; // forward vol conditional on high/not-high state
const perCoinAC: Array<{ coin: string; ac: number; fwdHi: number; fwdLo: number }> = [];

for (const coin of coins) {
  const c = selected[coin];
  const closes = c.map((x) => x.close);
  const vol = realizedVol(closes, VOL_N);
  const ac = autocorr1(vol);
  if (Number.isFinite(ac)) { acSum += ac; acN++; }

  // conditional forward vol: state at i (high-vol via expanding decile) vs vol[i+1]
  const mask = highVolMaskExpanding(vol);
  let hS = 0, hN = 0, lS = 0, lN = 0;
  for (let i = WARMUP; i < vol.length - 1; i++) {
    if (!Number.isFinite(vol[i]) || !Number.isFinite(vol[i + 1])) continue;
    if (mask[i]) { hS += vol[i + 1]; hN++; } else { lS += vol[i + 1]; lN++; }
  }
  const fwdHi = hN ? hS / hN : NaN, fwdLo = lN ? lS / lN : NaN;
  if (Number.isFinite(fwdHi)) { fwdHiSum += hS; fwdHiN += hN; }
  if (Number.isFinite(fwdLo)) { fwdLoSum += lS; fwdLoN += lN; }
  perCoinAC.push({ coin, ac, fwdHi, fwdLo });
}
const avgAC = acN ? acSum / acN : NaN;
const poolFwdHi = fwdHiN ? fwdHiSum / fwdHiN : NaN;
const poolFwdLo = fwdLoN ? fwdLoSum / fwdLoN : NaN;

console.log(`(1) Realized-vol lag-1 autocorrelation (clustering): avg across coins = ${avgAC.toFixed(3)}`);
console.log(`(2) Forward (next-bar) realized vol conditional on state:`);
console.log(`    after HIGH-vol (top decile): E[vol_{i+1}] = ${(poolFwdHi).toFixed(5)}  (n=${fwdHiN})`);
console.log(`    after NOT-high vol:          E[vol_{i+1}] = ${(poolFwdLo).toFixed(5)}  (n=${fwdLoN})`);
console.log(`    ratio hi/lo = ${(poolFwdHi / poolFwdLo).toFixed(2)}  -> ${poolFwdHi > poolFwdLo ? "forward vol is HIGHER after a spike (persistence dominates) " : "forward vol LOWER after spike (reversion)"}\n`);

// ---------- (3) per-coin gated vs plain B&H ----------
console.log(`(3) Vol-gated B&H vs plain B&H (annualized Sharpe / max DD):`);
console.log(`    ${"coin".padEnd(10)} ${"bh Sh".padEnd(8)} ${"gate Sh".padEnd(8)} ${"bh DD%".padEnd(8)} ${"gate DD%".padEnd(9)} ${"flat%"}`);

// Align all coins to a common bar index by date so we can pool / run PBO.
// Collect per-coin gated & bh & excess series keyed on shared trading days.
type Series = { gate: number[]; bh: number[]; excess: number[]; days: number[] };
const coinSeries: Record<string, Series> = {};
let gateWins = 0, bhWins = 0;

for (const coin of coins) {
  const c = selected[coin];
  const closes = c.map((x) => x.close);
  const vol = realizedVol(closes, VOL_N);
  const mask = highVolMaskExpanding(vol);
  const bh = bhReturns(c);
  const gate = gatedReturns(c, mask);
  const excess = gate.map((g, i) => g - bh[i]);
  const days = c.slice(0, c.length - 1).map((x) => x.start_unix);
  coinSeries[coin] = { gate, bh, excess, days };

  // restrict the comparison to the active window (after warmup) for a fair Sharpe
  const w = WARMUP;
  const bhSh = annualize(sharpe(bh.slice(w)));
  const gateSh = annualize(sharpe(gate.slice(w)));
  const bhDD = maxDrawdown(bh.slice(w)) * 100;
  const gateDD = maxDrawdown(gate.slice(w)) * 100;
  const flatPct = (mask.slice(w, c.length - 1).filter(Boolean).length / Math.max(1, c.length - 1 - w)) * 100;
  if (gateSh > bhSh) gateWins++; else bhWins++;
  console.log(`    ${coin.padEnd(10)} ${bhSh.toFixed(2).padEnd(8)} ${gateSh.toFixed(2).padEnd(8)} ${bhDD.toFixed(1).padEnd(8)} ${gateDD.toFixed(1).padEnd(9)} ${flatPct.toFixed(0)}%`);
}
console.log(`    gate-better-Sharpe on ${gateWins}/${coins.length} coins\n`);

// ---------- pooled equal-weight (align by day) ----------
// Build a master day axis (union), then equal-weight across coins present each day.
const allDays = new Set<number>();
for (const coin of coins) for (const d of coinSeries[coin].days) allDays.add(d);
const dayAxis = [...allDays].sort((a, b) => a - b);
const dayIdx = new Map(dayAxis.map((d, i) => [d, i]));

// per-coin day->return maps
const gateByDay: Array<Map<number, number>> = coins.map((coin) => {
  const m = new Map<number, number>();
  const s = coinSeries[coin];
  for (let i = 0; i < s.days.length; i++) m.set(s.days[i], s.gate[i]);
  return m;
});
const bhByDay: Array<Map<number, number>> = coins.map((coin) => {
  const m = new Map<number, number>();
  const s = coinSeries[coin];
  for (let i = 0; i < s.days.length; i++) m.set(s.days[i], s.bh[i]);
  return m;
});

const pooledGate: number[] = [];
const pooledBh: number[] = [];
const pooledExcess: number[] = [];
for (const d of dayAxis) {
  let gSum = 0, bSum = 0, n = 0;
  for (let k = 0; k < coins.length; k++) {
    const g = gateByDay[k].get(d), b = bhByDay[k].get(d);
    if (g != null && b != null && Number.isFinite(g) && Number.isFinite(b)) { gSum += g; bSum += b; n++; }
  }
  if (n > 0) { pooledGate.push(gSum / n); pooledBh.push(bSum / n); pooledExcess.push((gSum - bSum) / n); }
}

const poolBhSh = annualize(sharpe(pooledBh));
const poolGateSh = annualize(sharpe(pooledGate));
const poolBhDD = maxDrawdown(pooledBh) * 100;
const poolGateDD = maxDrawdown(pooledBh.length ? pooledGate : []) * 100;
const poolBhCum = (pooledBh.reduce((e, r) => e * (1 + r), 1) - 1) * 100;
const poolGateCum = (pooledGate.reduce((e, r) => e * (1 + r), 1) - 1) * 100;

console.log(`POOLED equal-weight (${pooledBh.length} bars):`);
console.log(`    plain B&H : Sharpe ${poolBhSh.toFixed(2)}  cum ${poolBhCum.toFixed(0)}%  maxDD ${poolBhDD.toFixed(1)}%`);
console.log(`    vol-gated : Sharpe ${poolGateSh.toFixed(2)}  cum ${poolGateCum.toFixed(0)}%  maxDD ${poolGateDD.toFixed(1)}%`);
console.log(`    excess(gate-bh): annSharpe ${annualize(sharpe(pooledExcess)).toFixed(2)}  mean/bar ${(mean(pooledExcess) * 1e4).toFixed(2)}bps\n`);

// ---------- (4) GAUNTLET ----------
// PBO/DSR over the CONFIG axis = coins (each coin's gated series is a "config").
// Build M[t][c] = coin c's gated return on day t (0 where absent) so configs share a time grid.
const T = dayAxis.length;
const N = coins.length;
const M: number[][] = [];
for (let t = 0; t < T; t++) {
  const d = dayAxis[t];
  const row: number[] = [];
  for (let k = 0; k < N; k++) { const g = gateByDay[k].get(d); row.push(g != null && Number.isFinite(g) ? g : 0); }
  M.push(row);
}
const pboVal = N >= 2 ? pbo(M, 8) : 1;

// Deflated Sharpe on the BEST coin's gated series, deflated by the cross-coin trial Sharpes.
const trialSharpes = coins.map((coin) => sharpe(coinSeries[coin].gate.slice(WARMUP)));
let bestCoin = coins[0], bestSh = -Infinity;
for (const coin of coins) { const s = sharpe(coinSeries[coin].gate.slice(WARMUP)); if (s > bestSh) { bestSh = s; bestCoin = coin; } }
const bestReturns = coinSeries[bestCoin].gate.slice(WARMUP);
const dsr = deflatedSharpe(bestReturns, trialSharpes);

console.log(`(4) GAUNTLET (config axis = ${N} coins):`);
console.log(`    PBO (8 blocks) = ${pboVal.toFixed(3)}  ${pboVal < 0.3 ? "(robust)" : "(overfit-prone)"}`);
console.log(`    best gated coin = ${bestCoin}  per-bar Sharpe ${dsr.sr.toFixed(3)}  DSR = ${dsr.dsr.toFixed(3)}  (sr0=${dsr.sr0.toFixed(3)})\n`);

// ---------- permutation control on the pooled EXCESS series ----------
// Block-shuffle the gate MASK timing destroys vol->forward structure; here we
// permute the pooled excess series blockwise and ask whether the real ordering's
// Sharpe is special (it should NOT be, since excess of a defensive overlay is
// largely order-independent — a useful sanity check that we're not finding magic).
const rng = lcgRng(12345);
const obsExcessSh = sharpe(pooledExcess);
const nullExcess: number[] = [];
for (let s = 0; s < 500; s++) {
  const perm = blockShufflePermutation(pooledExcess.length, 5, rng);
  nullExcess.push(sharpe(applyPermutation(pooledExcess, perm)));
}
const permRes = permutationTest(obsExcessSh, nullExcess, "greater");
console.log(`    block-shuffle control on pooled excess: observed Sharpe ${obsExcessSh.toFixed(4)}  p=${permRes.pValue.toFixed(3)}  (timing-dependence ${permRes.pValue < 0.05 ? "YES" : "weak/none"})\n`);

// ---------- ADVISOR one-voice verdict ----------
// Directional overlay -> benchmark is plain equal-weight buy-&-hold (the beta).
const memo = adviseTrade({
  label: `vol-gated B&H (top-decile flatten, vol${VOL_N})`,
  strategyReturns: pooledGate,
  benchmarkReturns: pooledBh,
  pbo: pboVal,
  dsr: dsr.dsr,
  oosFrac: 0.4,
  search: { hypothesesScanned: N, bonferroniSurvivors: 0 },
});
console.log(renderTradeMemo(memo));

console.log(`\n=== SUMMARY ===`);
console.log(`pooled B&H Sharpe=${poolGateSh && poolBhSh ? poolBhSh.toFixed(2) : "n/a"}  gated Sharpe=${poolGateSh.toFixed(2)}  ddB&H=${poolBhDD.toFixed(1)}%  ddGate=${poolGateDD.toFixed(1)}%`);
console.log(`avg vol AC=${avgAC.toFixed(3)}  fwdVol hi/lo ratio=${(poolFwdHi / poolFwdLo).toFixed(2)}  PBO=${pboVal.toFixed(3)}  DSR=${dsr.dsr.toFixed(3)}`);
console.log(`ADVISOR: ${memo.recommendation} / roiVerdict=${memo.advice.roiVerdict} (conviction ${memo.conviction})`);

// machine-readable line for the harness
console.log(`\nRESULT_JSON ${JSON.stringify({
  bestVariantAnnSharpe: Math.round(poolGateSh * 1000) / 1000,
  bhAnnSharpe: Math.round(poolBhSh * 1000) / 1000,
  gateAnnSharpe: Math.round(poolGateSh * 1000) / 1000,
  excessAnnSharpe: Math.round(annualize(sharpe(pooledExcess)) * 1000) / 1000,
  ddBhPct: Math.round(poolBhDD * 10) / 10,
  ddGatePct: Math.round(poolGateDD * 10) / 10,
  avgVolAutocorr: Math.round(avgAC * 1000) / 1000,
  fwdVolHiLoRatio: Math.round((poolFwdHi / poolFwdLo) * 100) / 100,
  pbo: Math.round(pboVal * 1000) / 1000,
  dsr: Math.round(dsr.dsr * 1000) / 1000,
  permP: permRes.pValue,
  recommendation: memo.recommendation,
  roiVerdict: memo.advice.roiVerdict,
  coins: N,
})}`);

await closeTsdb();
