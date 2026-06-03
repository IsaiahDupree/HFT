/**
 * harden-priors — stress-test the deep-history priors with the full overfit
 * battery (handbook §11): Probability of Backtest Overfit (combinatorial CV),
 * Deflated Sharpe Ratio (multiple-testing + non-normality), and multi-fold
 * walk-forward. A prior is HARDENED only if PBO < 0.3 AND DSR > 0.95 AND the
 * median multi-fold OOS Sharpe > 0.
 *
 *   npx tsx scripts/harden-priors.ts [--granularity ONE_DAY|ONE_HOUR]
 *       [--sized] [--fee-bps 10] [--blocks 8] [--folds 4] [--coins BTC-USD,...]
 *
 * --granularity ONE_HOUR loads hourly bars and scales trend windows ×24 so the
 *   SAME slow-trend edge is tested at finer entry resolution.
 * --sized adds an inverse-vol position-sizing overlay (sizing.ts) on top of every
 *   raw variant. The sized variants are registered as ADDITIONAL TRIALS in the
 *   Deflated-Sharpe pool, so SR0 is deflated honestly across every config tried —
 *   crossing DSR 0.95 by silently grid-searching the overlay is exactly the
 *   overfit this gate exists to catch.
 */
import "./_env.ts";
import { getCandles, listProducts, closeTsdb } from "../src/lib/db/candle-store.ts";
import { type DailyCandle } from "../src/lib/backtest/candle/engine.ts";
import {
  donchianBreakout, smaTrend, zMeanReversion,
  emaMomentum, macdTrend, rsiMomentum, atrBreakout, supertrend, volRegimeFilter,
} from "../src/lib/backtest/candle/strategies.ts";
import { applySizing, turnover } from "../src/lib/backtest/candle/sizing.ts";
import { deflatedSharpe, median, multiFoldWalkForward, pbo, sharpe, variantReturns } from "../src/lib/backtest/candle/stats.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(name);

const GRAN = argStr("--granularity", "ONE_DAY").toUpperCase();
const GRAN_SECONDS: Record<string, number> = { ONE_HOUR: 3600, SIX_HOUR: 21600, ONE_DAY: 86400 };
if (!GRAN_SECONDS[GRAN]) { console.error(`unknown --granularity ${GRAN}`); process.exit(1); }
const barsPerDay = 86400 / GRAN_SECONDS[GRAN];      // daily=1, hourly=24
const periodsPerYear = 365 * barsPerDay;            // daily=365, hourly=8760
const sizeWindow = Math.round(7 * barsPerDay);      // 1-week vol window: 7 daily / 168 hourly
const sized = flag("--sized");

const loadCandles = (product: string): Promise<DailyCandle[]> => getCandles(product, GRAN);

type V = { label: string; positions: number[]; raw?: string };

/** Raw trend/mean-rev grid, windows scaled to the bar size (×barsPerDay). When
 *  --sized, append the inverse-vol overlay of each as an extra registered trial. */
function allVariants(c: DailyCandle[]): V[] {
  const W = (days: number) => Math.max(2, Math.round(days * barsPerDay));
  const raw: V[] = [];
  for (const d of [10, 20, 50, 100, 200]) raw.push({ label: `sma${d}d`, positions: smaTrend(c, W(d)) });
  for (const d of [10, 20, 55, 100]) raw.push({ label: `don${d}d`, positions: donchianBreakout(c, W(d)) });
  for (const d of [10, 20, 30]) for (const ze of [1, 1.5, 2]) for (const zx of [0, 0.5]) raw.push({ label: `z${d}d/${ze}/${zx}`, positions: zMeanReversion(c, W(d), ze, zx) });
  // momentum-biased families (EMA/MACD/RSI-momentum/ATR-breakout/Supertrend) + a vol-regime gate.
  for (const [f, s] of [[10, 30], [20, 50], [12, 26]] as [number, number][]) raw.push({ label: `ema${f}/${s}`, positions: emaMomentum(c, W(f), W(s)) });
  raw.push({ label: "macd12/26/9", positions: macdTrend(c, W(12), W(26), W(9)) });
  for (const d of [14, 21]) raw.push({ label: `rsimom${d}`, positions: rsiMomentum(c, W(d), 55, 45) });
  for (const d of [20, 55]) for (const m of [0.5, 1]) raw.push({ label: `atrbo${d}/${m}`, positions: atrBreakout(c, W(d), m) });
  for (const d of [10, 14]) for (const m of [2, 3]) raw.push({ label: `super${d}/${m}`, positions: supertrend(c, W(d), m) });
  raw.push({ label: "ema20/50@hivol", positions: volRegimeFilter(c, emaMomentum(c, W(20), W(50)), W(14), "high", W(100)) });
  if (!sized) return raw;
  const sizedV: V[] = raw.map((v) => ({
    label: `${v.label}+vt`,
    positions: applySizing(c, v.positions, { n: sizeWindow, periodsPerYear, posMax: 1.0 }),
    raw: v.label,
  }));
  return [...raw, ...sizedV];
}

const feeBps = arg("--fee-bps", 10);
const nBlocks = arg("--blocks", 8);
const folds = arg("--folds", 4);
const coinArg = process.argv.indexOf("--coins");
const coins = coinArg >= 0 && process.argv[coinArg + 1]
  ? process.argv[coinArg + 1].split(",").map((s) => s.trim())
  : await listProducts(GRAN);
// Need enough bars to be meaningful AND to warm up the LARGEST registered window
// (W(200)); otherwise that variant is a silent all-zero no-op that still pollutes the
// PBO / Deflated-Sharpe multiple-testing math.
const maxWindow = Math.max(2, Math.round(200 * barsPerDay));
const minBars = Math.max(Math.round(600 * (barsPerDay > 1 ? barsPerDay / 4 : 1)), maxWindow + Math.round(60 * barsPerDay));

console.log(`\nharden-priors — ${GRAN}${sized ? " +inverse-vol sizing" : ""} · PBO (C(${nBlocks},${nBlocks / 2})) + Deflated Sharpe + ${folds}-fold WF, ${feeBps}bps/turn\n`);
console.log(`  ${"coin".padEnd(10)} ${"best".padEnd(16)} ${"PBO".padEnd(6)} ${"DSR".padEnd(6)} ${"medOOS".padEnd(8)} ${"folds(OOS)".padEnd(20)} ${"turn×".padEnd(7)} verdict`);

let hardened = 0, total = 0;
for (const coin of coins) {
  const c = await loadCandles(coin);
  if (c.length < minBars) continue;
  total++;
  const variants = allVariants(c);
  const vr = variants.map((v) => variantReturns(c, v.positions, feeBps));
  const T = vr[0].length;
  const M: number[][] = Array.from({ length: T }, (_, i) => vr.map((r) => r[i]));

  const PBO = pbo(M, nBlocks);
  const fullSh = vr.map((r) => sharpe(r));                       // every trial (raw + sized) in the pool
  const bestIdx = fullSh.reduce((bi, x, i) => (x > fullSh[bi] ? i : bi), 0);
  const best = variants[bestIdx];
  const dsr = deflatedSharpe(vr[bestIdx], fullSh);              // SR0 deflated by cross-trial dispersion
  const mwf = multiFoldWalkForward(c, variants, { folds, feeBps });
  const medOos = median(mwf.map((f) => f.oosSharpe));

  // Mandatory turnover check: sized turnover must not materially exceed its raw baseline.
  const rawParent = best.raw ? variants.find((v) => v.label === best.raw) : undefined;
  const turnRatio = rawParent ? turnover(best.positions) / Math.max(1e-9, turnover(rawParent.positions)) : 1;
  const turnOk = turnRatio <= 1.25;

  const ok = PBO < 0.3 && dsr.dsr > 0.95 && medOos > 0 && turnOk;
  if (ok) hardened++;
  const verdict = ok ? "HARDENED ✓" : medOos > 0 ? "partial" : "REJECT ✗";
  const foldStr = mwf.map((f) => f.oosSharpe.toFixed(2)).join("/");
  console.log(`  ${coin.padEnd(10)} ${best.label.padEnd(16)} ${PBO.toFixed(2).padEnd(6)} ${dsr.dsr.toFixed(2).padEnd(6)} ${medOos.toFixed(3).padEnd(8)} ${foldStr.padEnd(20)} ${turnRatio.toFixed(2).padEnd(7)} ${verdict}`);
}
console.log(`\n  HARDENED (PBO<0.3 & DSR>0.95 & medOOS>0 & turn×≤1.25): ${hardened}/${total} coins.`);
console.log(`  ${variants_note(sized)}  trials/coin=${sized ? "raw+sized (honest pool)" : "raw"}.\n`);
function variants_note(s: boolean) { return s ? "best may be a +vt (sized) variant; DSR deflated across raw+sized trials." : "PBO=P(IS-best below median OOS); DSR=P(true Sharpe>0 after deflation)."; }
await closeTsdb();
