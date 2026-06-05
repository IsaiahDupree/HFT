/**
 * _discover-funding-as-return-signal — FUNDING AS A DIRECTIONAL (MEAN-REVERSION) SIGNAL.
 *
 * Hypothesis: extreme funding marks crowded positioning, which mean-reverts in PRICE.
 *   funding[i] > +thr  → crowded longs  → SHORT (or flat) over i→i+1
 *   funding[i] < -thr  → crowded shorts → LONG over i→i+1
 *   else                                → flat
 * Equal-weight across coins. Realize the PRICE return i→i+1 net of a turnover fee. This is a
 * DIRECTIONAL price bet (NOT the carry harvest) — so the per-bar return is pos*priceRet - fee,
 * NOT netFundingReturns (which would add the funding cash flow and conflate two edges).
 *
 * NO-LOOKAHEAD: position[i] is decided from funding known at candle i (the day's summed 8h rate,
 * which is observable by the day's close) and realized on the close[i]->close[i+1] move. Funding
 * file window clips the candles, so the sample is ~2025-01..2026-06 (avoids the 2024-12-31 USDT
 * splice). Gauntlet: sharpe + pbo + deflatedSharpe; verdict: adviseTrade vs equal-weight BH.
 * Control: a block-shuffle permutation test on the best variant's portfolio Sharpe.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_discover-funding-as-return-signal.ts
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";
import type { DailyCandle } from "../src/lib/backtest/candle/engine.ts";

const DAY = 86_400;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const feeBps = arg("--fee-bps", 5);

const dir = resolve(process.cwd(), "data", "funding");
const coins = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", ""))
  : [];
if (!coins.length) { console.log("no data/funding/*.binance.jsonl"); await closeTsdb(); process.exit(0); }

function loadFunding(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { time: number; rate: number }).sort((a, b) => a.time - b.time);
}

/** Sum the 8-hourly funding intervals inside each candle's day — the funding charged that day,
 *  observable by the day's close. NO-LOOKAHEAD: only intervals with time < d1 are summed. */
function dailyFunding(candles: DailyCandle[], funding: Array<{ time: number; rate: number }>): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(candles.length).fill(undefined);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    const d0 = candles[i].start_unix, d1 = d0 + DAY;
    while (j < funding.length && funding[j].time < d0) j++;
    let sum = 0, cnt = 0, k = j;
    while (k < funding.length && funding[k].time < d1) { sum += funding[k].rate; cnt++; k++; }
    out[i] = cnt > 0 ? sum : undefined;
    j = k;
  }
  return out;
}

/**
 * Directional mean-reversion position from funding. thr in DAILY funding units (sum of 3x 8h).
 *   f > +thr → -1 (fade crowded longs);  f < -thr → +1 (fade crowded shorts);  else 0.
 * NO-LOOKAHEAD: position[i] from funding[i]. `longOnly` collapses the short leg to flat
 * (the "go long or flat" variant the brief mentions, to isolate inverse-beta).
 */
function fadeFunding(funding: Array<number | undefined>, thr: number, longOnly = false): number[] {
  return funding.map((f) => {
    if (f == null || !Number.isFinite(f)) return 0;
    if (f > thr) return longOnly ? 0 : -1;
    if (f < -thr) return 1;
    return 0;
  });
}

/** Per-bar DIRECTIONAL price return of a position series: pos*priceRet - fee on |Δpos|. */
function priceReturns(candles: DailyCandle[], positions: number[], fee: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const pos = positions[i] ?? 0;
    const prev = i > 0 ? (positions[i - 1] ?? 0) : 0;
    const priceRet = candles[i + 1].close / candles[i].close - 1;
    out.push(pos * priceRet - Math.abs(pos - prev) * (fee / 1e4));
  }
  return out;
}

// Variants: a small threshold grid, both long/short (fade) and long-only (fade longs only).
// thresholds are DAILY funding (e.g. 0.0003 = 3bp/day ≈ 1bp per 8h interval).
const VARIANTS: Array<{ label: string; thr: number; longOnly: boolean }> = [
  { label: "fade@1bp", thr: 0.0001, longOnly: false },
  { label: "fade@3bp", thr: 0.0003, longOnly: false },
  { label: "fade@5bp", thr: 0.0005, longOnly: false },
  { label: "fade@10bp", thr: 0.0010, longOnly: false },
  { label: "long-only@3bp", thr: 0.0003, longOnly: true },
  { label: "long-only@5bp", thr: 0.0005, longOnly: true },
];

type CoinData = { coin: string; days: number[]; retByVariant: Record<string, number[]>; bh: number[] };
const perCoin: CoinData[] = [];
for (const coin of coins) {
  const candles = await getCandles(`${coin}USDT`, "ONE_DAY");
  if (candles.length < 60) continue;
  const funding = loadFunding(coin);
  if (!funding.length) continue;
  const f0 = funding[0].time, f1 = funding[funding.length - 1].time;
  const cl = candles.filter((c) => c.start_unix >= f0 && c.start_unix <= f1);
  if (cl.length < 60) continue;
  const df = dailyFunding(cl, funding);
  const days = cl.slice(0, cl.length - 1).map((c) => c.start_unix); // length n-1
  const retByVariant: Record<string, number[]> = {};
  for (const v of VARIANTS) retByVariant[v.label] = priceReturns(cl, fadeFunding(df, v.thr, v.longOnly), feeBps);
  // equal-weight buy-and-hold leg for THIS coin: always long, no turnover fee
  const bh: number[] = [];
  for (let i = 0; i < cl.length - 1; i++) bh.push(cl[i + 1].close / cl[i].close - 1);
  perCoin.push({ coin, days, retByVariant, bh });
}
if (!perCoin.length) { console.log("no coins with overlapping candles+funding"); await closeTsdb(); process.exit(0); }

// Equal-weight portfolio: mean across coins present on each day.
const allDays = [...new Set(perCoin.flatMap((p) => p.days))].sort((a, b) => a - b);
const idxByCoin = perCoin.map((p) => new Map(p.days.map((d, i) => [d, i])));
function portfolio(pick: (p: CoinData, i: number) => number): number[] {
  return allDays.map((d) => {
    let sum = 0, cnt = 0;
    perCoin.forEach((p, ci) => { const i = idxByCoin[ci].get(d); if (i != null) { sum += pick(p, i); cnt++; } });
    return cnt ? sum / cnt : 0;
  });
}

const series = VARIANTS.map((v) => portfolio((p, i) => p.retByVariant[v.label][i]));
const beta = portfolio((p, i) => p.bh[i]); // equal-weight buy-and-hold benchmark

const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const T = beta.length;
const split = Math.floor(T * 0.7);

const fullSh = series.map((r) => sharpe(r));
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
// pick best IN-SAMPLE for the honest OOS check
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(series[bestIdx], fullSh).dsr;
const oosHold = series.filter((r) => sharpe(r.slice(split)) > 0).length;

// correlation of the best variant vs the equal-weight basket (inverse-beta detector)
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
const betaCorr = corr(series[bestIdx], beta);

console.log(`\n_discover-funding-as-return-signal — REAL Binance funding · ${perCoin.length} coins · ${T} days · ${feeBps}bps/turn`);
console.log(`coins: ${perCoin.map((p) => p.coin).join(", ")}`);
console.log(`window: ${new Date(allDays[0]*1000).toISOString().slice(0,10)} -> ${new Date(allDays[allDays.length-1]*1000).toISOString().slice(0,10)}\n`);
console.log(`  ${"variant".padEnd(15)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(10)} cum PnL`);
for (const { v, i, sh } of VARIANTS.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(15)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(10)} ${(cum(series[i]) * 100 >= 0 ? "+" : "")}${(cum(series[i]) * 100).toFixed(0)}%`);
}
console.log(`  ${"EW buy&hold".padEnd(15)} ${ann(sharpe(beta)).toFixed(2).padEnd(11)} ${`${ann(sharpe(beta.slice(split))).toFixed(2)}`.padEnd(10)} ${(cum(beta) * 100 >= 0 ? "+" : "")}${(cum(beta) * 100).toFixed(0)}%`);

console.log(`\n  best(full): ${VARIANTS[bestIdx].label} ann ${ann(fullSh[bestIdx]).toFixed(2)} · IS-best ${VARIANTS[isBest].label} walk-fwd OOS ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"}`);
console.log(`  PBO ${PBO.toFixed(2)} · DSR ${dsr.toFixed(2)} · ${oosHold}/${VARIANTS.length} held OOS · corr(best, EW-BH) ${betaCorr.toFixed(2)}`);

// ---- CONTROL: block-shuffle permutation test on the best variant's portfolio Sharpe ----
// Shuffle the best variant's per-bar returns in blocks (preserves autocorrelation structure)
// and recompute Sharpe; if the real Sharpe isn't extreme vs the null, the "edge" is noise.
const best = series[bestIdx];
const rng = lcgRng(12345);
const NULL = 1000, BLOCK = 5;
const obs = sharpe(best);
const nullSh: number[] = [];
for (let k = 0; k < NULL; k++) {
  const perm = blockShufflePermutation(best.length, BLOCK, rng);
  nullSh.push(sharpe(applyPermutation(best, perm)));
}
const permGreater = permutationTest(obs, nullSh, "greater"); // edge if obs in the right tail
console.log(`\n  CONTROL block-shuffle (${NULL} perms, block ${BLOCK}): observed Sharpe ${obs.toFixed(4)} · p(greater) ${permGreater.pValue.toFixed(3)}`);
console.log(`  ${permGreater.pValue < 0.05 ? "→ survives the shuffle control" : "→ does NOT survive (consistent with noise/structure-free)"}`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: `funding-fade ${VARIANTS[isBest].label}`,
  strategyReturns: series[isBest], benchmarkReturns: beta,
  pbo: PBO, dsr, oosFrac: 0.3,
  search: { hypothesesScanned: VARIANTS.length, bonferroniSurvivors: 0 },
})) + "\n");

await closeTsdb();
