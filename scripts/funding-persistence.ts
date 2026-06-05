/**
 * funding-persistence — which coins are the BEST single-venue carry names? Not just "big funding"
 * (transient spikes get arbed) but PERSISTENT, one-sided funding: a coin whose funding is reliably
 * the same sign pays you steadily AND flips rarely (low turnover → fewer round-trip fees). Scores
 * each coin's Binance funding history by sign-stability × magnitude ÷ flip-frequency.
 *
 *   npm run discover:funding-persistence
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "data", "funding");
const coins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
if (!coins.length) { console.log("\n  no data/funding/*.binance.jsonl — run fetch:funding:binance\n"); process.exit(0); }

type Row = { coin: string; n: number; fracPos: number; persistence: number; meanAbsApr: number; flipsPerYr: number; score: number };
const rows: Row[] = [];
for (const coin of coins) {
  const rates = readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => (JSON.parse(l) as { rate: number }).rate);
  if (rates.length < 90) continue; // ≥ ~1 month of 8-hourly
  const pos = rates.filter((r) => r > 0).length;
  const fracPos = pos / rates.length;
  const persistence = Math.max(fracPos, 1 - fracPos);           // 0.5 = coin-flip, 1.0 = always one side
  const meanAbs = rates.reduce((a, r) => a + Math.abs(r), 0) / rates.length;
  const meanAbsApr = meanAbs * 3 * 365 * 100;                    // 3 funding/day
  let flips = 0;
  for (let i = 1; i < rates.length; i++) if (Math.sign(rates[i]) !== Math.sign(rates[i - 1]) && rates[i] !== 0 && rates[i - 1] !== 0) flips++;
  const years = rates.length / (3 * 365);
  const flipsPerYr = flips / Math.max(0.1, years);
  // carry score: steady (high persistence), fat (high APR), cheap to hold (few flips/yr).
  const score = persistence * meanAbsApr / (1 + flipsPerYr / 50);
  rows.push({ coin, n: rates.length, fracPos, persistence, meanAbsApr, flipsPerYr, score });
}
rows.sort((a, b) => b.score - a.score);

console.log(`\nfunding-persistence — best single-venue carry names (persistent + fat + low-turnover) · ${rows.length} coins\n`);
console.log(`  ${"coin".padEnd(11)} ${"score".padEnd(8)} ${"persist".padEnd(8)} ${"side".padEnd(7)} ${"meanAbs APR".padEnd(12)} ${"flips/yr".padEnd(9)} n`);
for (const r of rows.slice(0, 24)) {
  const side = r.fracPos > 0.55 ? "long-pay" : r.fracPos < 0.45 ? "short-pay" : "mixed";
  console.log(`  ${r.coin.padEnd(11)} ${r.score.toFixed(1).padEnd(8)} ${(r.persistence * 100).toFixed(0).padEnd(8)}% ${side.padEnd(7)} ${`${r.meanAbsApr.toFixed(0)}%`.padEnd(12)} ${r.flipsPerYr.toFixed(0).padEnd(9)} ${r.n}`);
}
console.log(`\n  side: "long-pay" = funding usually POSITIVE (longs pay → SHORT the perp to collect). "short-pay" = collect by going long.`);
console.log(`  Best carry names = high score: steady one-sided funding, fat APR, few sign flips (low turnover cost).`);
console.log(`  → use the top names as the universe for backtest:carry-neutral / backtest:basis.\n`);
