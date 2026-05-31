/**
 * harden-priors — stress-test the deep-history priors with the full overfit
 * battery (handbook §11): Probability of Backtest Overfit (combinatorial CV),
 * Deflated Sharpe Ratio (multiple-testing + non-normality), and multi-fold
 * walk-forward. A prior is HARDENED only if PBO < 0.3 AND DSR > 0.95 AND the
 * median multi-fold OOS Sharpe > 0.
 *
 *   npx tsx scripts/harden-priors.ts [--fee-bps 10] [--blocks 8] [--folds 4]
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { type DailyCandle } from "../src/lib/backtest/candle/engine.ts";
import { donchianBreakout, smaTrend, zMeanReversion } from "../src/lib/backtest/candle/strategies.ts";
import { deflatedSharpe, median, multiFoldWalkForward, pbo, sharpe, variantReturns, type Variant } from "../src/lib/backtest/candle/stats.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function loadDaily(product: string): DailyCandle[] {
  return db().prepare(
    `SELECT start_unix, open, high, low, close, volume FROM coinbase_candles
       WHERE product_id = ? AND granularity = 'ONE_DAY' ORDER BY start_unix ASC`,
  ).all(product) as DailyCandle[];
}
function allVariants(c: DailyCandle[]): Variant[] {
  const v: Variant[] = [];
  for (const n of [10, 20, 50, 100, 200]) v.push({ label: `sma${n}`, positions: smaTrend(c, n) });
  for (const n of [10, 20, 55, 100]) v.push({ label: `don${n}`, positions: donchianBreakout(c, n) });
  for (const n of [10, 20, 30]) for (const ze of [1, 1.5, 2]) for (const zx of [0, 0.5]) v.push({ label: `z${n}/${ze}/${zx}`, positions: zMeanReversion(c, n, ze, zx) });
  return v;
}

const feeBps = arg("--fee-bps", 10);
const nBlocks = arg("--blocks", 8);
const folds = arg("--folds", 4);
const coins = (db().prepare(`SELECT DISTINCT product_id FROM coinbase_candles WHERE granularity='ONE_DAY' ORDER BY product_id`).all() as Array<{ product_id: string }>).map((r) => r.product_id);

console.log(`\nharden-priors — PBO (C(${nBlocks},${nBlocks / 2})) + Deflated Sharpe + ${folds}-fold WF, ${feeBps}bps/turn\n`);
console.log(`  ${"coin".padEnd(10)} ${"IS-best".padEnd(14)} ${"PBO".padEnd(6)} ${"DSR".padEnd(6)} ${"medOOS-Sh".padEnd(10)} ${"folds".padEnd(22)} verdict`);

let hardened = 0, total = 0;
for (const coin of coins) {
  const c = loadDaily(coin);
  if (c.length < 600) continue;
  total++;
  const variants = allVariants(c);
  const vr = variants.map((v) => variantReturns(c, v.positions, feeBps));
  const T = vr[0].length;
  const M: number[][] = Array.from({ length: T }, (_, i) => vr.map((r) => r[i]));

  const PBO = pbo(M, nBlocks);
  const fullSh = vr.map((r) => sharpe(r));
  const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
  const dsr = deflatedSharpe(vr[bestIdx], fullSh); // cross-trial dispersion deflates the max
  const mwf = multiFoldWalkForward(c, variants, { folds, feeBps });
  const medOos = median(mwf.map((f) => f.oosSharpe));

  const ok = PBO < 0.3 && dsr.dsr > 0.95 && medOos > 0;
  if (ok) hardened++;
  const verdict = ok ? "HARDENED ✓" : medOos > 0 ? "partial" : "REJECT ✗";
  const foldStr = mwf.map((f) => f.oosSharpe.toFixed(1)).join("/");
  console.log(`  ${coin.padEnd(10)} ${variants[bestIdx].label.padEnd(14)} ${PBO.toFixed(2).padEnd(6)} ${dsr.dsr.toFixed(2).padEnd(6)} ${medOos.toFixed(3).padEnd(10)} ${foldStr.padEnd(22)} ${verdict}`);
}
console.log(`\n  HARDENED (PBO<0.3 & DSR>0.95 & medOOS>0): ${hardened}/${total} coins.`);
console.log(`  PBO = P(IS-best below median OOS); DSR = P(true Sharpe>0 after ${"deflation"}); folds = per-fold OOS Sharpe.\n`);
