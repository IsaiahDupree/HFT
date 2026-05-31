/**
 * backtest-history — evaluate daily candle strategies over the DEEP history
 * ingested by ingest-history.ts. Per coin, grid-search SMA-trend / Donchian /
 * z-mean-reversion and report the best (by annualized Sharpe) vs buy-and-hold.
 * The honest readout: do these classic edges survive years + fees, or not?
 *
 *   npx tsx scripts/backtest-history.ts [--fee-bps 10]
 */
import "./_env.ts";
import { getCandles, listProducts, closeTsdb } from "../src/lib/db/candle-store.ts";
import { runCandleBacktest, type CandleResult, type DailyCandle } from "../src/lib/backtest/candle/engine.ts";
import { buyAndHold, donchianBreakout, smaTrend, zMeanReversion } from "../src/lib/backtest/candle/strategies.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const loadDaily = (product: string): Promise<DailyCandle[]> => getCandles(product, "ONE_DAY");

type Variant = { label: string; positions: number[] };
function best(candles: DailyCandle[], variants: Variant[], feeBps: number): { label: string; res: CandleResult } {
  let bestV = { label: variants[0].label, res: runCandleBacktest(candles, variants[0].positions, { feeBps }) };
  for (const v of variants.slice(1)) {
    const res = runCandleBacktest(candles, v.positions, { feeBps });
    if (res.sharpe > bestV.res.sharpe) bestV = { label: v.label, res };
  }
  return bestV;
}
const cell = (r: CandleResult) => `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(0)}% Sh${r.sharpe.toFixed(2)} dd${r.maxDdPct.toFixed(0)}% tr${r.trades}`;

const feeBps = arg("--fee-bps", 10);
const coins = await listProducts("ONE_DAY");

console.log(`\nbacktest-history — daily strategies vs buy-&-hold, ${feeBps}bps/turn, best-by-Sharpe\n`);
console.log(`  ${"coin".padEnd(10)} ${"years".padEnd(6)} ${"buy&hold".padEnd(22)} ${"SMA-trend".padEnd(26)} ${"Donchian".padEnd(26)} ${"z-mean-rev"}`);

const tally: Record<string, number> = { "buy&hold": 0, "SMA-trend": 0, Donchian: 0, "z-mean-rev": 0 };
for (const coin of coins) {
  const c = await loadDaily(coin);
  if (c.length < 250) continue;
  const years = (c[c.length - 1].start_unix - c[0].start_unix) / (365.25 * 86400);
  const bh = runCandleBacktest(c, buyAndHold(c), { feeBps });
  const sma = best(c, [10, 20, 50, 100, 200].map((n) => ({ label: `sma${n}`, positions: smaTrend(c, n) })), feeBps);
  const don = best(c, [10, 20, 55, 100].map((n) => ({ label: `don${n}`, positions: donchianBreakout(c, n) })), feeBps);
  const zv: Variant[] = [];
  for (const n of [10, 20, 30]) for (const ze of [1, 1.5, 2]) for (const zx of [0, 0.5]) zv.push({ label: `z${n}/${ze}/${zx}`, positions: zMeanReversion(c, n, ze, zx) });
  const z = best(c, zv, feeBps);

  // winner by Sharpe across the four
  const entrants: Array<[string, number]> = [["buy&hold", bh.sharpe], ["SMA-trend", sma.res.sharpe], ["Donchian", don.res.sharpe], ["z-mean-rev", z.res.sharpe]];
  entrants.sort((a, b) => b[1] - a[1]);
  tally[entrants[0][0]]++;

  console.log(`  ${coin.padEnd(10)} ${years.toFixed(1).padEnd(6)} ${cell(bh).padEnd(22)} ${(sma.label + " " + cell(sma.res)).padEnd(26)} ${(don.label + " " + cell(don.res)).padEnd(26)} ${z.label} ${cell(z.res)}`);
}
console.log(`\n  best-Sharpe winner by coin: ${Object.entries(tally).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join("  ")}`);
console.log(`  (Sharpe = annualized, after ${feeBps}bps/turn fees. Long-flat strategies; no shorting.)\n`);
await closeTsdb();
