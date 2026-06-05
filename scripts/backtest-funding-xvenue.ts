/**
 * backtest-funding-xvenue — CROSS-VENUE funding arbitrage. The funding DIFFERENCE between two
 * perp venues (Binance vs Hyperliquid) for the same coin is collectable delta-neutral: short the
 * higher-funding perp + long the lower-funding perp → collect |Δfunding| per interval, price-
 * neutral (both perps track the same spot). LOWER risk than absolute carry — the residual is the
 * perp-vs-perp basis, much tighter than perp-vs-spot. Reuses deltaNeutralCarryReturns on the
 * SPREAD series. Honest question: is the venue funding spread big/persistent enough to beat fees?
 *
 *   npm run backtest:funding-xvenue [-- --fee-bps 3]
 *   (needs both data/funding/<C>.binance.jsonl AND data/funding/<C>.jsonl — fetch:funding:binance + fetch:funding)
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const feeBps = arg("--fee-bps", 3); // per perp leg; cross-venue entry = 2 legs (one per venue)
const dir = resolve(process.cwd(), "data", "funding");

// coins that have BOTH venues' funding
const binance = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : []);
const hl = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".binance.jsonl")).map((f) => f.replace(".jsonl", "")) : []);
const coins = [...binance].filter((c) => hl.has(c));
if (!coins.length) { console.log("\n  no coins with BOTH venues — run fetch:funding:binance AND fetch:funding\n"); process.exit(0); }

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
function loadBinance(coin: string): Array<{ time: number; rate: number }> {
  return lines(resolve(dir, `${coin}.binance.jsonl`)).map((l) => JSON.parse(l) as { time: number; rate: number });
}
function loadHL(coin: string): Array<{ time: number; rate: number }> {
  // Hyperliquid jsonl: { time(ms), fundingRate, premium } → normalize to {time(s), rate}
  return lines(resolve(dir, `${coin}.jsonl`)).map((l) => { const r = JSON.parse(l) as { time: number; fundingRate: number }; return { time: Math.floor(r.time / 1000), rate: r.fundingRate }; });
}
function dailySum(rows: Array<{ time: number; rate: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) { const d = Math.floor(r.time / DAY) * DAY; m.set(d, (m.get(d) ?? 0) + r.rate); }
  return m;
}

const VARIANTS = [
  { label: ">0@3bp", minF: 0, fee: 3 },
  { label: ">1bp@3bp", minF: 0.0001, fee: 3 },
  { label: ">2bp@3bp", minF: 0.0002, fee: 3 },
  { label: ">2bp@1bp", minF: 0.0002, fee: 1 },
];

const perCoin = coins.map((coin) => {
  const binD = dailySum(loadBinance(coin)), hlD = dailySum(loadHL(coin));
  const days = [...binD.keys()].filter((d) => hlD.has(d)).sort((a, b) => a - b);
  const spread = days.map((d) => binD.get(d)! - hlD.get(d)!); // Binance − HL daily funding
  const byV: Record<string, Map<number, number>> = {};
  for (const v of VARIANTS) byV[v.label] = new Map(days.slice(0, -1).map((d, i) => [d, deltaNeutralCarryReturns(spread, { minFunding: v.minF, feeBps: v.fee })[i]]));
  const absMean = spread.reduce((a, x) => a + Math.abs(x), 0) / Math.max(1, spread.length);
  return { coin, days, byV, absMeanBps: absMean * 1e4, n: days.length };
}).filter((p) => p.n > 30);

if (!perCoin.length) { console.log("\n  no coins with ≥30 overlapping funding days\n"); process.exit(0); }

const allDays = [...new Set(perCoin.flatMap((p) => p.days.slice(0, -1)))].sort((a, b) => a - b);
function portfolio(label: string): number[] {
  return allDays.map((d) => { let s = 0, c = 0; for (const p of perCoin) { const r = p.byV[label].get(d); if (r != null) { s += r; c++; } } return c ? s / c : 0; });
}
const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const series = VARIANTS.map((v) => portfolio(v.label));
const T = allDays.length, split = Math.floor(T * 0.7);
const fullSh = series.map((r) => sharpe(r));
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(series[isBest], fullSh).dsr;
const avgSpread = perCoin.reduce((a, p) => a + p.absMeanBps, 0) / perCoin.length;

console.log(`\nbacktest-funding-xvenue — CROSS-VENUE funding arb (Binance − Hyperliquid) · ${perCoin.length} coins · ${T} days\n`);
console.log(`  avg |daily funding spread| ${avgSpread.toFixed(1)}bps  (coins: ${perCoin.map((p) => p.coin).join(",")})\n`);
console.log(`  ${"variant".padEnd(11)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ${"cum".padEnd(8)} ann.return`);
for (const { v, i, sh } of VARIANTS.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  const annRet = (Math.pow(1 + cum(series[i]), 365 / T) - 1) * 100;
  console.log(`  ${v.label.padEnd(11)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${`${(cum(series[i]) * 100).toFixed(1)}%`.padEnd(8)} ${annRet.toFixed(1)}%`);
}
console.log(`\n  best ${VARIANTS[isBest].label} · PBO ${PBO.toFixed(2)} · DSR ${dsr.toFixed(2)}`);
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `xvenue funding arb ${VARIANTS[isBest].label}`,
  strategyReturns: series[isBest], benchmarkReturns: allDays.map(() => 0),
  pbo: PBO, dsr, oosFrac: 0.3, betaAttractive: false,
})) + "\n");
console.log(`  NOTE: assumes perp-perp basis ≈ 0 (tighter than perp-spot but nonzero). Residual = the venue basis;\n  also needs simultaneous execution on BOTH venues. Lower-risk than single-venue carry IF the spread is real.\n`);
