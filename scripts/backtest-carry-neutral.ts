/**
 * backtest-carry-neutral — the REAL funding carry: delta-neutral (short the high-funding perp,
 * long spot — or vice versa), harvest funding price-neutral. Uses real Binance 8-hourly funding
 * (data/funding/<COIN>.binance.jsonl via the proxy). Per coin: deltaNeutralCarryReturns over the
 * 8-hourly series, compounded to daily, equal-weighted into a portfolio, run through the gauntlet
 * + one-voice advisor vs CASH (0) — the correct benchmark for a market-neutral book.
 *
 * Model caveat: assumes negligible spot↔perp basis drift (the omitted risk); fees are charged on
 * both legs per entry/flip. So this is the funding-HARVEST upper bound net of cost, not basis risk.
 *
 *   npm run backtest:carry-neutral
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const dir = resolve(process.cwd(), "data", "funding");
const coins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
if (!coins.length) { console.log("\n  no data/funding/*.binance.jsonl — run: npm run fetch:funding:binance\n"); process.exit(0); }

function loadFunding(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { time: number; rate: number }).sort((a, b) => a.time - b.time);
}

const VARIANTS = [
  { label: "all@2bp", minF: 0, fee: 2 },
  { label: ">0.5bp@2bp", minF: 0.00005, fee: 2 },
  { label: ">1bp@2bp", minF: 0.0001, fee: 2 },
  { label: ">1bp@1bp", minF: 0.0001, fee: 1 },
  { label: ">2bp@1bp", minF: 0.0002, fee: 1 },
];

// Per coin + variant: 8-hourly carry → compound into daily, keyed by day-unix.
const perCoin = coins.map((coin) => {
  const fund = loadFunding(coin);
  const rates = fund.map((r) => r.rate);
  const dailyByVariant: Record<string, Map<number, number>> = {};
  for (const v of VARIANTS) {
    const carry8h = deltaNeutralCarryReturns(rates, { minFunding: v.minF, feeBps: v.fee });
    const byDay = new Map<number, number>(); // day → compounded (1+r) factor
    for (let i = 0; i < carry8h.length; i++) {
      const d = Math.floor(fund[i].time / DAY) * DAY;
      byDay.set(d, (byDay.get(d) ?? 1) * (1 + carry8h[i]));
    }
    dailyByVariant[v.label] = new Map([...byDay].map(([d, f]) => [d, f - 1])); // factor → daily return
  }
  return { coin, dailyByVariant };
}).filter((p) => p.dailyByVariant[VARIANTS[0].label].size > 30);

if (!perCoin.length) { console.log("\n  no coins with enough funding history\n"); process.exit(0); }

const allDays = [...new Set(perCoin.flatMap((p) => [...p.dailyByVariant[VARIANTS[0].label].keys()]))].sort((a, b) => a - b);
function portfolio(label: string): number[] {
  return allDays.map((d) => {
    let sum = 0, cnt = 0;
    for (const p of perCoin) { const r = p.dailyByVariant[label].get(d); if (r != null) { sum += r; cnt++; } }
    return cnt ? sum / cnt : 0;
  });
}
const series = VARIANTS.map((v) => portfolio(v.label));
const cash = allDays.map(() => 0); // market-neutral → benchmark is cash

const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const T = allDays.length;
const split = Math.floor(T * 0.7);
const fullSh = series.map((r) => sharpe(r));
const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const oosSh = sharpe(series[isBest].slice(split));
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(series[bestIdx], fullSh).dsr;
const oosHold = series.filter((r) => sharpe(r.slice(split)) > 0).length;

console.log(`\nbacktest-carry-neutral — DELTA-NEUTRAL funding harvest · ${perCoin.length} coins · ${T} days\n`);
console.log(`  ${"variant".padEnd(12)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ${"cum".padEnd(8)} ann.return`);
for (const { v, i, sh } of VARIANTS.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  const annRet = (Math.pow(1 + cum(series[i]), 365 / T) - 1) * 100;
  console.log(`  ${v.label.padEnd(12)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${`${(cum(series[i]) * 100).toFixed(1)}%`.padEnd(8)} ${annRet.toFixed(1)}%`);
}
console.log(`\n  best (full): ${VARIANTS[bestIdx].label} · walk-forward OOS ${ann(oosSh).toFixed(2)} ${oosSh > 0 ? "✓ HELD" : "✗ FADED"} · PBO ${PBO.toFixed(2)} · DSR ${dsr.toFixed(2)} · ${oosHold}/${VARIANTS.length} held OOS`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: `delta-neutral carry ${VARIANTS[isBest].label}`,
  strategyReturns: series[isBest], benchmarkReturns: cash,
  pbo: PBO, dsr, oosFrac: 0.3, betaAttractive: false, // cash is not "attractive beta"
})) + "\n");
