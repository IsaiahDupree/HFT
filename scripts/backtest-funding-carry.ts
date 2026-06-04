/**
 * backtest-funding-carry — does timing perp exposure by FUNDING beat just holding? Uses REAL
 * Binance funding (data/funding/<COIN>.binance.jsonl, fetched via the proxy) — the payoff of the
 * geo-block unlock; the funding-carry strategy was previously stuck on Hyperliquid.
 *
 * Per coin: align 8-hourly funding into a daily cost (sum of the day's 3 intervals), then build
 * funding-aware position variants and price-the-perp net of funding (netFundingReturns). Equal-
 * weight the per-coin returns into a portfolio, run the honest gauntlet, and end in one voice
 * vs the BUY-AND-HOLD-NET-OF-FUNDING benchmark (always long, pays funding).
 *
 *   npm run backtest:funding-carry [-- --fee-bps 5]
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { fundingCarrySignal, fundingGate, netFundingReturns } from "../src/lib/backtest/candle/funding.ts";
import { smaTrend } from "../src/lib/backtest/candle/strategies.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import type { DailyCandle } from "../src/lib/backtest/candle/engine.ts";

const DAY = 86_400;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const feeBps = arg("--fee-bps", 5);

const dir = resolve(process.cwd(), "data", "funding");
const coins = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", ""))
  : [];
if (!coins.length) { console.log("\n  no data/funding/*.binance.jsonl — run: npm run fetch:funding:binance\n"); await closeTsdb(); process.exit(0); }

function loadFunding(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { time: number; rate: number }).sort((a, b) => a.time - b.time);
}

/** Sum the 8-hourly funding intervals that fall inside each candle's day [d0, d0+1d). */
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

// Funding-aware position variants (each a fn of candles + dailyFunding → long-flat positions).
const VARIANTS: Array<{ label: string; pos: (c: DailyCandle[], f: Array<number | undefined>) => number[] }> = [
  { label: "carry@0", pos: (_c, f) => fundingCarrySignal(f, { enter: 0, exit: 0 }) },                         // long only when paid (f≤0)
  { label: "carry@-1bp", pos: (_c, f) => fundingCarrySignal(f, { enter: -0.0001, exit: 0 }) },                // stricter
  { label: "carry@+5bp", pos: (_c, f) => fundingCarrySignal(f, { enter: 0.0005, exit: 0.0008 }) },            // hold unless funding very high
  { label: "mom20+gate", pos: (c, f) => fundingGate(smaTrend(c, 20), f, { maxFunding: 0.0003 }) },            // momentum, skip when funding punitive
];
const BENCH = { label: "BH net funding", pos: (c: DailyCandle[]) => new Array(c.length).fill(1) }; // always long, pays funding

// Per coin: candles ∩ funding window, then per-variant net returns keyed by day.
const perCoin: Array<{ coin: string; days: number[]; retByVariant: Record<string, number[]>; bench: number[] }> = [];
for (const coin of coins) {
  const candles = await getCandles(`${coin}-USDT`.replace("-USDT", "USDT"), "ONE_DAY");
  const funding = loadFunding(coin);
  if (candles.length < 60 || !funding.length) continue;
  // clip candles to the funding-covered window
  const f0 = funding[0].time, f1 = funding[funding.length - 1].time;
  const cl = candles.filter((c) => c.start_unix >= f0 && c.start_unix <= f1);
  if (cl.length < 60) continue;
  const df = dailyFunding(cl, funding);
  const days = cl.slice(0, cl.length - 1).map((c) => c.start_unix); // netFundingReturns yields length n-1
  const retByVariant: Record<string, number[]> = {};
  for (const v of VARIANTS) retByVariant[v.label] = netFundingReturns(cl, v.pos(cl, df), df, feeBps);
  const bench = netFundingReturns(cl, BENCH.pos(cl), df, feeBps);
  perCoin.push({ coin, days, retByVariant, bench });
}
if (!perCoin.length) { console.log("\n  no coins with overlapping candles+funding\n"); await closeTsdb(); process.exit(0); }

// Equal-weight portfolio: for each variant + bench, mean across coins present per day.
const allDays = [...new Set(perCoin.flatMap((p) => p.days))].sort((a, b) => a - b);
const idxByCoin = perCoin.map((p) => new Map(p.days.map((d, i) => [d, i])));
function portfolio(pick: (p: typeof perCoin[number], i: number) => number): number[] {
  return allDays.map((d) => {
    let sum = 0, cnt = 0;
    perCoin.forEach((p, ci) => { const i = idxByCoin[ci].get(d); if (i != null) { sum += pick(p, i); cnt++; } });
    return cnt ? sum / cnt : 0;
  });
}
const series = VARIANTS.map((v) => portfolio((p, i) => p.retByVariant[v.label][i]));
const beta = portfolio((p, i) => p.bench[i]);

const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const T = beta.length;
const split = Math.floor(T * 0.7);
const fullSh = series.map((r) => sharpe(r));
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(series[bestIdx], fullSh).dsr;
const oosHold = series.filter((r) => sharpe(r.slice(split)) > 0).length;

console.log(`\nbacktest-funding-carry — REAL Binance funding · ${perCoin.length} coins · ${T} days · ${feeBps}bps/turn\n`);
console.log(`  ${"variant".padEnd(12)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} cum PnL`);
for (const { v, i, sh } of VARIANTS.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  console.log(`  ${v.label.padEnd(12)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${(cum(series[i]) * 100 >= 0 ? "+" : "")}${(cum(series[i]) * 100).toFixed(0)}%`);
}
console.log(`  ${"BH(net fund)".padEnd(12)} ${ann(sharpe(beta)).toFixed(2).padEnd(11)} ${`${ann(sharpe(beta.slice(split))).toFixed(2)}`.padEnd(9)} ${(cum(beta) * 100 >= 0 ? "+" : "")}${(cum(beta) * 100).toFixed(0)}%`);
console.log(`\n  best (full): ${VARIANTS[bestIdx].label} · walk-forward OOS ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"} · PBO ${PBO.toFixed(2)} · DSR ${dsr.toFixed(2)} · ${oosHold}/${VARIANTS.length} held OOS`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: `funding-carry ${VARIANTS[isBest].label}`,
  strategyReturns: series[isBest], benchmarkReturns: beta,
  pbo: PBO, dsr, oosFrac: 0.3,
})) + "\n");
await closeTsdb();
