/**
 * validate-history — OUT-OF-SAMPLE validation of the deep-history backtest.
 * Per coin, pick the best params for each strategy family on the in-sample 70%,
 * then score those params on the held-out 30%. The honest question: does the
 * trend edge survive out-of-sample, or was it grid-overfit?
 *
 *   npx tsx scripts/validate-history.ts [--is-frac 0.7] [--fee-bps 10]
 */
import "./_env.ts";
import { getCandles, listProducts, closeTsdb } from "../src/lib/db/candle-store.ts";
import { runCandleBacktest, type DailyCandle } from "../src/lib/backtest/candle/engine.ts";
import { buyAndHold, donchianBreakout, smaTrend, zMeanReversion } from "../src/lib/backtest/candle/strategies.ts";
import { walkForward, type Variant } from "../src/lib/backtest/candle/walkforward.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const loadDaily = (product: string): Promise<DailyCandle[]> => getCandles(product, "ONE_DAY");

const isFrac = arg("--is-frac", 0.7);
const feeBps = arg("--fee-bps", 10);
const coins = await listProducts("ONE_DAY");

console.log(`\nvalidate-history — walk-forward (IS ${Math.round(isFrac * 100)}% → OOS ${Math.round((1 - isFrac) * 100)}%), ${feeBps}bps/turn\n`);
console.log(`  ${"coin".padEnd(10)} ${"best (IS-picked)".padEnd(14)} ${"IS Sh".padEnd(7)} ${"OOS Sh".padEnd(7)} ${"OOS pnl".padEnd(9)} ${"OOS b&h".padEnd(9)} verdict`);

let held = 0, total = 0, beatBH = 0;
for (const coin of coins) {
  const c = await loadDaily(coin);
  if (c.length < 600) continue; // need enough for a 70/30 split with lookback
  const split = Math.floor(c.length * isFrac);
  const families: Array<{ name: string; variants: Variant[] }> = [
    { name: "SMA", variants: [10, 20, 50, 100, 200].map((n) => ({ label: `sma${n}`, positions: smaTrend(c, n) })) },
    { name: "Donchian", variants: [10, 20, 55, 100].map((n) => ({ label: `don${n}`, positions: donchianBreakout(c, n) })) },
  ];
  const zv: Variant[] = [];
  for (const n of [10, 20, 30]) for (const ze of [1, 1.5, 2]) for (const zx of [0, 0.5]) zv.push({ label: `z${n}/${ze}/${zx}`, positions: zMeanReversion(c, n, ze, zx) });
  families.push({ name: "z-rev", variants: zv });

  // pick the family whose IS-best has the highest IS Sharpe (what we'd deploy)
  let chosen = walkForward(c, families[0].variants, { isFrac, feeBps });
  let chosenName = families[0].name;
  for (const f of families.slice(1)) {
    const wf = walkForward(c, f.variants, { isFrac, feeBps });
    if (wf.is.sharpe > chosen.is.sharpe) { chosen = wf; chosenName = f.name; }
  }
  const bhOos = runCandleBacktest(c.slice(split), buyAndHold(c.slice(split)), { feeBps });

  total++;
  const heldUp = chosen.oos.sharpe > 0;
  const beatsBh = chosen.oos.sharpe > bhOos.sharpe;
  if (heldUp) held++;
  if (beatsBh) beatBH++;
  const verdict = heldUp ? (beatsBh ? "HELD ✓ (beats b&h)" : "held (under b&h)") : "FADED ✗";
  console.log(`  ${coin.padEnd(10)} ${(chosenName + ":" + chosen.label).padEnd(14)} ${chosen.is.sharpe.toFixed(2).padEnd(7)} ${chosen.oos.sharpe.toFixed(2).padEnd(7)} ${((chosen.oos.pnlPct >= 0 ? "+" : "") + chosen.oos.pnlPct.toFixed(0) + "%").padEnd(9)} ${((bhOos.pnlPct >= 0 ? "+" : "") + bhOos.pnlPct.toFixed(0) + "%").padEnd(9)} ${verdict}`);
}
console.log(`\n  VERDICT: OOS Sharpe stayed positive on ${held}/${total} coins; beat buy&hold OOS on ${beatBH}/${total}.`);
console.log(`  (IS-picked params, scored on untouched OOS. Held = the trend edge is real, not grid-overfit.)\n`);
await closeTsdb();
