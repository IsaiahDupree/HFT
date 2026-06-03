/**
 * cross-venue-check — confirm warehouse (Coinbase) daily candles against a SECOND independent
 * source (Kraken, keyless). Prints the agreement report + worst-diverging bars so you can spot
 * single-source artifacts before they reach a backtest. The relstr audit lesson, operationalized.
 *
 *   npm run data:cross-venue -- --coins BTC-USD,ETH-USD,SOL-USD [--max-bps 50]
 */
import "./_env.ts";
import { getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { fetchKrakenOHLC } from "../src/lib/data/kraken.ts";
import { crossVenueAgreement } from "../src/lib/data/cross-venue.ts";

const argv = process.argv;
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const coins = (flag("--coins")?.split(",").map((s) => s.trim()).filter(Boolean)) ?? ["BTC-USD", "ETH-USD", "SOL-USD"];
const maxBps = Number(flag("--max-bps") ?? "50");

console.log(`\ncross-venue-check — Coinbase (warehouse) vs Kraken (live), ONE_DAY · tolerance ${maxBps}bps\n`);
console.log(`  ${"coin".padEnd(10)} ${"overlap".padEnd(8)} ${"med bps".padEnd(8)} ${"p95".padEnd(7)} ${"max".padEnd(8)} ${"only-CB/KR".padEnd(12)} verdict`);

for (const coin of coins) {
  try {
    const cb = await getCandles(coin, "ONE_DAY");
    const kr = await fetchKrakenOHLC(coin, "ONE_DAY");
    const rep = crossVenueAgreement(cb, kr, { maxBps });
    const mark = rep.verdict === "agree" ? "✓" : rep.verdict === "minor_drift" ? "~" : "✗";
    console.log(`  ${coin.padEnd(10)} ${String(rep.overlap).padEnd(8)} ${rep.medianBps.toFixed(1).padEnd(8)} ${rep.p95Bps.toFixed(1).padEnd(7)} ${rep.maxBps.toFixed(1).padEnd(8)} ${`${rep.onlyA}/${rep.onlyB}`.padEnd(12)} ${mark} ${rep.verdict}`);
    for (const d of rep.divergent.slice(0, 3)) {
      console.log(`      ⚠ ${new Date(d.start_unix * 1000).toISOString().slice(0, 10)}  CB ${d.a}  KR ${d.b}  → ${d.bps.toFixed(0)}bps apart`);
    }
  } catch (e) {
    console.log(`  ${coin.padEnd(10)} ERROR: ${(e as Error).message.slice(0, 80)}`);
  }
}
console.log("");
await closeTsdb();
