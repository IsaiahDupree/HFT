/**
 * _carry-basis-rolldown-curve — BASIS ROLL-DOWN CARRY as a function of DAYS-TO-EXPIRY.
 *
 * EDGE (a refinement of calendar-basis carry): a dated quarterly future trades at a basis to spot
 * that DECAYS toward zero as the contract approaches delivery. A cash-and-carry book (long spot +
 * short the front-quarter future) earns this convergence as roll-down. The textbook claim we test:
 * the $/day roll-down is FATTER far from expiry where the (annualized) basis is larger and where a
 * given calendar slope is multiplied by more remaining days. So entering ONLY in the fat part of the
 * dte curve (a mid band) should earn more carry per day at risk and IMPROVE Sharpe vs holding the
 * whole contract life (which dilutes with the near-expiry stub where basis≈0 and convergence is noisy).
 *
 * WHAT THIS SCRIPT DOES (NO-LOOKAHEAD throughout; position[i] from data ≤ i, realized i→i+1):
 *   (1) Build front-quarter continuous klines + spot per pair, exactly per backtest-calendar-basis.ts
 *       (same expiry calendar, same roll-seam skip so the contract-stitch price jump can't leak).
 *   (2) DTE PROFILE — bucket every NO-LOOKAHEAD daily carry return (full-life cash-and-carry, the
 *       reference book) by the dte OBSERVED at entry of that bar. Report mean $/day roll-down and an
 *       annualized Sharpe per dte bucket. This is the descriptive "is the carry fatter far out?" curve.
 *   (3) TIMING TEST — a dte-GATED variant of calendarBasisReturns: same cash-and-carry, but only hold
 *       when dte∈[dteLo,dteHi]. Compare annualized Sharpe & carry/day-at-risk of the gated band vs the
 *       full-life book. Search a few bands; PBO/DSR penalize the search breadth.
 *   (4) GAUNTLET — sharpe + pbo(M,blocks) + deflatedSharpe(best,trials) + a block-shuffle control
 *       (a real convergence carry has time-structure: basis→0 at expiry; a shuffle that preserves the
 *       drift but destroys the dte-ordering is the honest null) + adviseTrade vs CASH (market-neutral).
 *
 * Reuses the tested primitives (calendarBasisReturns / sharpe / pbo / deflatedSharpe / adviseTrade /
 * shuffle-control). Benchmark = CASH (zeros): the book is delta-neutral, nothing to compound against.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_carry-basis-rolldown-curve.ts
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { calendarBasisReturns } from "../src/lib/backtest/candle/funding.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

const DAY = 86_400;
const ANN = Math.sqrt(365);

// ---------- quarterly delivery calendar: last Friday of Mar/Jun/Sep/Dec, 08:00 UTC (per ref script) ----------
function lastFridayUTC(y: number, mZeroBased: number): number {
  const d = new Date(Date.UTC(y, mZeroBased + 1, 0, 8, 0, 0));
  const back = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return Math.floor(d.getTime() / 1000);
}
function frontExpiry(tSec: number): number {
  const y0 = new Date(tSec * 1000).getUTCFullYear();
  for (let y = y0 - 1; y <= y0 + 1; y++) for (const m of [2, 5, 8, 11]) { const e = lastFridayUTC(y, m); if (e > tSec) return e; }
  return tSec;
}

async function rawKlines(url: string): Promise<Array<Array<number | string>>> {
  const r = await proxiedFetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`);
  return (await r.json()) as Array<Array<number | string>>;
}
const dayIdx = (ms: number) => Math.floor(Number(ms) / 86_400_000);

async function spotDaily(symbol: string): Promise<Map<number, number>> {
  const j = await rawKlines(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000`);
  return new Map(j.map((k) => [dayIdx(k[0] as number), Number(k[4])]));
}
async function contQuarterDaily(pair: string, contractType: string): Promise<Map<number, number>> {
  const j = await rawKlines(`https://fapi.binance.com/fapi/v1/continuousKlines?pair=${pair}&contractType=${contractType}&interval=1d&limit=1500`);
  return new Map(j.map((k) => [dayIdx(k[0] as number), Number(k[4])]));
}

type Bar = { day: number; spot: number; fut: number; dte: number; annBasis: number; roll: boolean };
async function buildBars(pair: string, contractType: string): Promise<Bar[]> {
  const [spot, fut] = await Promise.all([spotDaily(pair), contQuarterDaily(pair, contractType)]);
  const days = [...fut.keys()].filter((d) => spot.has(d)).sort((a, b) => a - b);
  const bars: Bar[] = [];
  let prevDte = Infinity;
  for (const day of days) {
    const tSec = day * DAY;
    const sp = spot.get(day)!, fc = fut.get(day)!;
    if (!(sp > 0) || !(fc > 0)) continue;
    const exp = frontExpiry(tSec);
    const dte = (exp - tSec) / DAY;
    const roll = dte > prevDte + 1; // dte jumped UP ⇒ new contract stitched (artificial seam)
    prevDte = dte;
    bars.push({ day, spot: sp, fut: fc, dte, annBasis: (fc / sp - 1) * (365 / Math.max(dte, 1)), roll });
  }
  return bars;
}

/** NO-LOOKAHEAD daily carry returns via the tested primitive (full-life or dte-gated by opts). */
function carryReturns(bars: Bar[], opts: Parameters<typeof calendarBasisReturns>[4]): number[] {
  return calendarBasisReturns(bars.map((b) => b.spot), bars.map((b) => b.fut), bars.map((b) => b.dte), bars.map((b) => b.roll), opts);
}

/**
 * DTE-GATED cash-and-carry: hold the full-life book ONLY when dte∈[lo,hi]. Built by zeroing the
 * spot/fut prices outside the band so the lib primitive sees no tradable signal there (annBasis→0,
 * dte<tailSkip guard already flattens the stub). Cleaner: we instead pass a per-bar dte that is set
 * out-of-band to a value < tailSkip so the primitive flattens it — but to keep the seam logic intact
 * we replicate the primitive's accounting here directly, gated by the band. NO-LOOKAHEAD preserved.
 */
function gatedCarryReturns(bars: Bar[], band: { lo: number; hi: number }, opts: { minBasisAnn: number; feeBps: number; tailSkip: number; oneSided: boolean }): number[] {
  const { minBasisAnn, feeBps, tailSkip, oneSided } = opts;
  const out: number[] = [];
  let side = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i];
    const inBand = b.dte >= Math.max(tailSkip, band.lo) && b.dte <= band.hi;
    let target = 0;
    if (inBand && b.spot > 0 && b.fut > 0) {
      if (b.annBasis >= minBasisAnn) target = 1;
      else if (!oneSided && b.annBasis <= -minBasisAnn) target = -1;
    }
    let pnl = 0;
    if (!bars[i + 1].roll && b.spot > 0 && b.fut > 0) {
      pnl = target * ((bars[i + 1].spot / b.spot - 1) - (bars[i + 1].fut / b.fut - 1));
    }
    out.push(pnl - Math.abs(target - side) * 2 * (feeBps / 1e4));
    side = target;
  }
  return out;
}

function portfolio(streams: Array<{ days: number[]; rets: number[] }>): { days: number[]; rets: number[] } {
  const byDay = new Map<number, number[]>();
  for (const s of streams) for (let i = 0; i < s.rets.length; i++) {
    const d = s.days[i];
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s.rets[i]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  return { days, rets: days.map((d) => { const a = byDay.get(d)!; return a.reduce((x, y) => x + y, 0) / a.length; }) };
}

const cum = (r: number[]) => r.reduce((acc, x) => acc * (1 + x), 1) - 1;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ========================== MAIN ==========================
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
const CONTRACT = "CURRENT_QUARTER";
// One-sided contango cash-and-carry at a realistic 2bp/leg fee; the basis is overwhelmingly contango.
const BASE = { minBasisAnn: 0.0, feeBps: 2, tailSkip: 3, oneSided: true };

console.log(`\nBASIS ROLL-DOWN CARRY vs days-to-expiry — front-quarter continuous vs spot · ${PAIRS.length} pairs\n`);

const built: Array<{ pair: string; bars: Bar[] }> = [];
for (const pair of PAIRS) {
  try {
    const bars = await buildBars(pair, CONTRACT);
    if (bars.length < 120) { console.log(`  ${pair}: only ${bars.length} aligned days — skip`); continue; }
    const b = bars.filter((x) => x.dte >= 3 && Math.abs(x.annBasis) < 2);
    const mAnn = mean(b.map((x) => x.annBasis));
    const contango = b.filter((x) => x.annBasis > 0).length / b.length;
    console.log(`  ${pair}: ${bars.length}d  annBasis mean=${(mAnn * 100).toFixed(2)}%  contango=${(contango * 100).toFixed(0)}%  span ${new Date(bars[0].day * DAY * 1000).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].day * DAY * 1000).toISOString().slice(0, 10)}`);
    built.push({ pair, bars });
  } catch (e) { console.log(`  ${pair}: ERROR ${(e as Error).message}`); }
}
if (!built.length) { console.log("\nNO dated-future data reachable — dataAvailable=false\n"); process.exit(0); }

// ---------- (2) DTE PROFILE: bucket NO-LOOKAHEAD full-life carry returns by dte-at-entry ----------
// Reference book = full-life one-sided contango carry. For every pair, pair each realized return
// rets[i] with the dte OBSERVED at bar i (entry), then aggregate across pairs into dte buckets.
const BUCKETS: Array<[number, number]> = [[3, 15], [15, 30], [30, 45], [45, 60], [60, 75], [75, 92]];
const bucketRets: number[][] = BUCKETS.map(() => []);
for (const { bars } of built) {
  const rets = carryReturns(bars, BASE); // length bars.length-1; rets[i] earned over bar i→i+1
  for (let i = 0; i < rets.length; i++) {
    if (bars[i + 1].roll) continue; // skip seam bars (no real pnl there)
    const dte = bars[i].dte;
    const bi = BUCKETS.findIndex(([lo, hi]) => dte >= lo && dte < hi);
    if (bi >= 0) bucketRets[bi].push(rets[i]);
  }
}
console.log("\n  dte-bucket   mean$/day   ann%/yr   annSharpe   n");
for (let bi = 0; bi < BUCKETS.length; bi++) {
  const r = bucketRets[bi];
  const m = mean(r), s = sharpe(r) * ANN;
  console.log(`  [${BUCKETS[bi][0]},${BUCKETS[bi][1]})d`.padEnd(13) + `  ${(m * 1e4).toFixed(2).padStart(7)}bp  ${(m * 365 * 100).toFixed(1).padStart(6)}%  ${s.toFixed(2).padStart(8)}  ${String(r.length).padStart(5)}`);
}

// ---------- (3) TIMING TEST: full-life book vs dte-gated bands ----------
type V = { label: string; band: { lo: number; hi: number } | null; days: number[]; rets: number[]; ann: number; perPeriodSharpe: number; cumPct: number; daysAtRisk: number };
function buildVariant(label: string, band: { lo: number; hi: number } | null): V {
  const streams = built.map(({ bars }) => {
    const rets = band ? gatedCarryReturns(bars, band, BASE) : carryReturns(bars, BASE);
    return { days: bars.slice(0, bars.length - 1).map((b) => b.day), rets };
  });
  const pf = portfolio(streams);
  const s = sharpe(pf.rets);
  const daysAtRisk = pf.rets.filter((x) => x !== 0).length;
  return { label, band, days: pf.days, rets: pf.rets, ann: s * ANN, perPeriodSharpe: s, cumPct: cum(pf.rets), daysAtRisk };
}

const VARIANTS: Array<{ label: string; band: { lo: number; hi: number } | null }> = [
  { label: "full-life(3-92)", band: null },
  { label: "fat-band(30-92)", band: { lo: 30, hi: 92 } },
  { label: "fat-band(45-92)", band: { lo: 45, hi: 92 } },
  { label: "mid-band(20-60)", band: { lo: 20, hi: 60 } },
  { label: "near-only(3-30)", band: { lo: 3, hi: 30 } },
];
const results = VARIANTS.map((v) => buildVariant(v.label, v.band));

console.log("\n  variant            annSharpe   cum%    carry/day-at-risk   daysAtRisk");
for (const r of results) {
  const car = r.daysAtRisk ? (r.rets.reduce((a, b) => a + b, 0) / r.daysAtRisk) * 1e4 : 0;
  console.log(`  ${r.label.padEnd(17)}  ${r.ann.toFixed(2).padStart(7)}  ${(r.cumPct * 100).toFixed(1).padStart(6)}  ${car.toFixed(2).padStart(13)}bp  ${String(r.daysAtRisk).padStart(11)}`);
}

const fullLife = results[0];
const best = results.reduce((a, b) => (b.ann > a.ann ? b : a));
const timingImprove = best.ann - fullLife.ann;
console.log(`\nFULL-LIFE annSharpe=${fullLife.ann.toFixed(2)}  |  BEST=${best.label} annSharpe=${best.ann.toFixed(2)}  |  timing Δ=${timingImprove >= 0 ? "+" : ""}${timingImprove.toFixed(2)}`);

// ---------- (4) GAUNTLET on the BEST variant ----------
const commonDays = results.map((r) => new Set(r.days)).reduce((acc, s) => new Set([...acc].filter((d) => s.has(d))));
const orderedDays = [...commonDays].sort((a, b) => a - b);
const idxByVariant = results.map((r) => new Map(r.days.map((d, i) => [d, i])));
const M: number[][] = orderedDays.map((d) => results.map((r, vi) => r.rets[idxByVariant[vi].get(d)!]));
const PBO = pbo(M, 8);

const trialSharpes = results.map((r) => r.perPeriodSharpe);
const { dsr } = deflatedSharpe(best.rets, trialSharpes);

// Block-shuffle control: destroy the dte time-ordering, keep the drift. A genuine convergence carry
// (basis→0 at expiry) has real time-structure; a path that's just a positive drift survives shuffling.
const rng = lcgRng(20260604);
const nullSharpes: number[] = [];
for (let k = 0; k < 1000; k++) {
  const perm = blockShufflePermutation(best.rets.length, 10, rng);
  nullSharpes.push(sharpe(applyPermutation(best.rets, perm)) * ANN);
}
const permRes = permutationTest(best.ann, nullSharpes, "greater");

const benchRets = best.rets.map(() => 0); // market-neutral ⇒ cash benchmark
const memo = adviseTrade({
  label: `basis-rolldown-carry/${best.label}`,
  strategyReturns: best.rets,
  benchmarkReturns: benchRets,
  pbo: PBO,
  dsr,
  oosFrac: 0.3,
  betaAttractive: false,
  search: { hypothesesScanned: VARIANTS.length },
});

console.log("\n================ GAUNTLET (best variant) ================");
console.log(`annualized Sharpe:        ${best.ann.toFixed(2)}`);
console.log(`cumulative return:        ${(best.cumPct * 100).toFixed(1)}%  over ${best.days.length} days (${best.daysAtRisk} at risk)`);
console.log(`ann return on days-at-risk:${best.daysAtRisk ? ((best.rets.reduce((a, b) => a + b, 0) / best.daysAtRisk) * 365 * 100).toFixed(1) : "0"}%/yr`);
console.log(`PBO (overfit prob):       ${PBO.toFixed(2)}   ${PBO < 0.3 ? "(robust)" : "(fragile)"}`);
console.log(`Deflated Sharpe (DSR):    ${dsr.toFixed(2)}   ${dsr > 0.95 ? "(survives multiple-testing)" : "(weak)"}`);
console.log(`shuffle control p-value:  ${permRes.pValue.toFixed(4)}  (obs ${best.ann.toFixed(2)} vs null mean ${mean(nullSharpes).toFixed(2)})`);
console.log(`\n${renderTradeMemo(memo)}`);
console.log(`\nADVISOR: ${memo.recommendation} | roiVerdict=${memo.advice.roiVerdict} | conviction=${memo.conviction}`);
console.log(`\nSUMMARY_JSON ${JSON.stringify({
  annSharpe: +best.ann.toFixed(2),
  annReturnPct: best.daysAtRisk ? +((best.rets.reduce((a, b) => a + b, 0) / best.daysAtRisk) * 365 * 100).toFixed(1) : 0,
  cumPct: +(best.cumPct * 100).toFixed(1),
  fullLifeSharpe: +fullLife.ann.toFixed(2),
  bestLabel: best.label,
  timingDelta: +timingImprove.toFixed(2),
  pbo: +PBO.toFixed(2),
  dsr: +dsr.toFixed(2),
  shuffleP: +permRes.pValue.toFixed(4),
  recommendation: memo.recommendation,
  roiVerdict: memo.advice.roiVerdict,
  conviction: memo.conviction,
})}`);
