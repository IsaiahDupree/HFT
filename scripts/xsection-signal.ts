/**
 * xsection-signal — print TODAY's cross-sectional momentum basket (the OOS-robust
 * edge) from the live warehouse daily candles. The actionable form of the verified
 * signal: which coins to be long, which to be short, market-neutral — or FLAT when
 * the market isn't trending (the trend gate). Foundation for the arena portfolio-agent.
 *
 *   npm run xsection:signal [-- --lookback 20]
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { momentumSignal, type CoinCloses } from "../src/lib/strategies/xsection-momentum.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const lookback = arg("--lookback", 20);

const coins = await listProducts("ONE_DAY");
const bars: CoinCloses[] = [];
let btcCloses: number[] = [];
let asOf = 0;
for (const c of coins) {
  const candles = await getCandles(c, "ONE_DAY");
  const closes = candles.map((k) => k.close);
  bars.push({ coin: c, closes });
  if (candles.length) asOf = Math.max(asOf, candles[candles.length - 1].start_unix);
  if (c === "BTC-USD") btcCloses = closes;
}

const { trending, weights } = momentumSignal(bars, btcCloses, { lookback });
const asOfStr = asOf ? new Date(asOf * 1000).toISOString().slice(0, 10) : "?";

console.log(`\ncross-sectional momentum signal — as of ${asOfStr} · lookback ${lookback}d · ${coins.length} coins\n`);
console.log(`  market regime: ${trending ? "TRENDING → deploy momentum" : "CHOP → FLAT (no position)"}`);
if (!trending || Object.keys(weights).length === 0) {
  console.log(`  → recommended basket: FLAT (sit out)\n`);
} else {
  const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${"coin".padEnd(10)} ${"weight".padEnd(9)} side`);
  for (const [coin, w] of sorted) {
    if (Math.abs(w) < 1e-6) continue;
    console.log(`  ${coin.padEnd(10)} ${(w >= 0 ? "+" : "") + (w * 100).toFixed(1).padEnd(8)} ${w > 0 ? "LONG" : "SHORT"}`);
  }
  const gross = Object.values(weights).reduce((a, b) => a + Math.abs(b), 0);
  const net = Object.values(weights).reduce((a, b) => a + b, 0);
  console.log(`\n  market-neutral check: gross Σ|w|=${gross.toFixed(3)} (≈1), net Σw=${net.toFixed(4)} (≈0)\n`);
}
await closeTsdb();
