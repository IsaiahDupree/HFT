/**
 * _carry-calendar-spread-term-structure — TERM-STRUCTURE (CALENDAR-SPREAD) CARRY.
 *
 * EDGE: The OUTRIGHT calendar basis (edge #2) is long-spot / short-front-quarter cash-and-carry.
 * Here we trade the CURVE itself: the SPREAD between the NEXT_QUARTER basis and the CURRENT_QUARTER
 * basis. Both quarterlies share the SAME spot, so a future-vs-future spread (long one dated leg,
 * short the other) is delta-neutral WITHOUT a spot leg — even more spot-neutral than the outright,
 * because spot price drops out entirely (no spot leg to mark). The harvest:
 *   front basis bF = (FUT_front/spot − 1)·365/dteF   (annualized)
 *   back  basis bB = (FUT_back /spot − 1)·365/dteB
 *   spread s = bB − bF  (term premium of the back over the front)
 * A persistent contango curve has bB ≥ bF (longer to expiry ⇒ richer annualized premium is the
 * classic carry-curve shape). Going LONG the rich/dear leg and SHORT the cheap leg harvests the
 * convergence of the curve as both contracts roll down toward expiry.
 *
 * STRATEGY (NO-LOOKAHEAD): position decided from the spread OBSERVED at day i; realized i→i+1.
 *   We hold a future-vs-future spread. PnL per unit = sideBack·(backRet) + sideFront·(frontRet),
 *   where the spread is dollar-neutral: long-back/short-front ⇒ sideBack=+1, sideFront=−1, so
 *   ret = (FUT_back[i+1]/FUT_back[i] − 1) − (FUT_front[i+1]/FUT_front[i] − 1) − fee.
 *   We take the spread only when |s| ≥ minSpreadAnn (clears round-trip). Direction:
 *     s ≥ +minSpread → long-back / short-front  (back is dearer, harvest term premium)
 *     s ≤ −minSpread → long-front / short-back  (curve inverted) — unless oneSided.
 * Roll seams: EITHER leg stitching a new contract (dte jumps UP) makes that day's price move on
 * that leg ARTIFICIAL → skip the whole day (set both leg returns to 0). NO-LOOKAHEAD throughout.
 *
 * CONTROL: we also run the OUTRIGHT front-basis carry (edge #2) on the SAME window so the gauntlet
 * compares apples-to-apples — is the spread cleaner (higher Sharpe / lower DD) than the outright?
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_carry-calendar-spread-term-structure.ts
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { calendarBasisReturns } from "../src/lib/backtest/candle/funding.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

const DAY = 86_400;
const ANN = Math.sqrt(365);

// ---------- quarterly delivery calendar: last Friday of Mar/Jun/Sep/Dec, 08:00 UTC ----------
function lastFridayUTC(y: number, mZeroBased: number): number {
  const d = new Date(Date.UTC(y, mZeroBased + 1, 0, 8, 0, 0));
  const back = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return Math.floor(d.getTime() / 1000);
}
/** Ascending list of quarterly expiries bracketing tSec. */
function expiriesAround(tSec: number): number[] {
  const y0 = new Date(tSec * 1000).getUTCFullYear();
  const out: number[] = [];
  for (let y = y0 - 1; y <= y0 + 2; y++) for (const m of [2, 5, 8, 11]) out.push(lastFridayUTC(y, m));
  return out.sort((a, b) => a - b);
}
/** k-th quarterly expiry strictly after tSec (k=0 ⇒ front/CURRENT, k=1 ⇒ back/NEXT). */
function nthExpiry(tSec: number, k: number): number {
  const fut = expiriesAround(tSec).filter((e) => e > tSec);
  return fut[Math.min(k, fut.length - 1)];
}

// ---------- proxied klines ----------
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

// ---------- build one coin's term-structure day stream ----------
type Bar = {
  day: number; spot: number;
  front: number; back: number;
  dteF: number; dteB: number;
  bF: number; bB: number; spread: number;
  rollF: boolean; rollB: boolean;
};
async function buildBars(pair: string): Promise<Bar[]> {
  const [spot, front, back] = await Promise.all([
    spotDaily(pair),
    contQuarterDaily(pair, "CURRENT_QUARTER"),
    contQuarterDaily(pair, "NEXT_QUARTER"),
  ]);
  const days = [...front.keys()].filter((d) => back.has(d) && spot.has(d)).sort((a, b) => a - b);
  const bars: Bar[] = [];
  let prevDteF = Infinity, prevDteB = Infinity;
  for (const day of days) {
    const tSec = day * DAY;
    const sp = spot.get(day)!, fF = front.get(day)!, fB = back.get(day)!;
    if (!(sp > 0) || !(fF > 0) || !(fB > 0)) continue;
    const dteF = (nthExpiry(tSec, 0) - tSec) / DAY;
    const dteB = (nthExpiry(tSec, 1) - tSec) / DAY;
    const rollF = dteF > prevDteF + 1; // front stitched a new contract
    const rollB = dteB > prevDteB + 1; // back stitched a new contract
    prevDteF = dteF; prevDteB = dteB;
    const bF = (fF / sp - 1) * (365 / Math.max(dteF, 1));
    const bB = (fB / sp - 1) * (365 / Math.max(dteB, 1));
    bars.push({ day, spot: sp, front: fF, back: fB, dteF, dteB, bF, bB, spread: bB - bF, rollF, rollB });
  }
  return bars;
}

/**
 * TERM-STRUCTURE SPREAD carry, NO-LOOKAHEAD. Future-vs-future, dollar-neutral (no spot leg).
 *   side from spread at i: +1 long-back/short-front when spread≥minSpread, −1 reverse when ≤−minSpread.
 *   realized i→i+1: side·( backRet − frontRet ); a roll seam on EITHER leg zeroes that day's price move.
 *   fee charged on turnover of BOTH legs (a side change of magnitude d moves 2·d legs).
 */
function spreadReturns(bars: Bar[], opts: { minSpreadAnn: number; feeBps: number; tailSkip: number; oneSided: boolean }): number[] {
  const { minSpreadAnn, feeBps, tailSkip, oneSided } = opts;
  const out: number[] = [];
  let side = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i], nx = bars[i + 1];
    let target = 0;
    // only trade when both legs have a safe horizon (front not in expiry week)
    if (b.dteF >= tailSkip) {
      if (b.spread >= minSpreadAnn) target = 1;            // back dearer → long back / short front
      else if (!oneSided && b.spread <= -minSpreadAnn) target = -1; // curve inverted → reverse
    }
    let pnl = 0;
    const seam = nx.rollF || nx.rollB; // either leg stitched ⇒ artificial jump ⇒ skip price move
    if (!seam && b.front > 0 && b.back > 0) {
      const backRet = nx.back / b.back - 1;
      const frontRet = nx.front / b.front - 1;
      pnl = target * (backRet - frontRet);
    }
    const fee = Math.abs(target - side) * 2 * (feeBps / 1e4); // 2 legs per unit side change
    out.push(pnl - fee);
    side = target;
  }
  return out;
}

/** CONTROL: outright front-quarter basis carry (edge #2) on the same bars, via the tested primitive. */
function outrightReturns(bars: Bar[], opts: { minBasisAnn: number; feeBps: number; tailSkip: number; oneSided: boolean }): number[] {
  return calendarBasisReturns(
    bars.map((b) => b.spot), bars.map((b) => b.front), bars.map((b) => b.dteF),
    bars.map((b) => b.rollF), opts,
  );
}

// ---------- equal-weight per-coin daily streams keyed by day index ----------
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
function maxDrawdown(r: number[]): number {
  let eq = 1, peak = 1, mdd = 0;
  for (const x of r) { eq *= 1 + x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  return mdd;
}

// ========================== MAIN ==========================
const PAIRS = ["BTCUSDT", "ETHUSDT"]; // the only deep quarterly continuous series fapi serves

console.log(`\nTERM-STRUCTURE (calendar-spread) carry — NEXT vs CURRENT quarter, future-vs-future · ${PAIRS.length} pairs\n`);

const built: Array<{ pair: string; bars: Bar[] }> = [];
for (const pair of PAIRS) {
  try {
    const bars = await buildBars(pair);
    if (bars.length < 120) { console.log(`  ${pair}: only ${bars.length} aligned days — skip`); continue; }
    const b = bars.filter((x) => x.dteF >= 3 && Math.abs(x.spread) < 2);
    const meanSpread = b.reduce((s, x) => s + x.spread, 0) / b.length;
    const meanBF = b.reduce((s, x) => s + x.bF, 0) / b.length;
    const meanBB = b.reduce((s, x) => s + x.bB, 0) / b.length;
    const backDearer = b.filter((x) => x.spread > 0).length / b.length;
    console.log(`  ${pair}: ${bars.length}d  frontBasis=${(meanBF * 100).toFixed(2)}%  backBasis=${(meanBB * 100).toFixed(2)}%  spread(B-F)=${(meanSpread * 100).toFixed(2)}%  back-dearer=${(backDearer * 100).toFixed(0)}%  span ${new Date(bars[0].day * DAY * 1000).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].day * DAY * 1000).toISOString().slice(0, 10)}`);
    built.push({ pair, bars });
  } catch (e) { console.log(`  ${pair}: ERROR ${(e as Error).message}`); }
}
if (!built.length) { console.log("\nNO dated-future data reachable — dataAvailable=false\n"); process.exit(0); }

// ---------- SPREAD variants (the search; PBO/DSR penalize this breadth) ----------
const SPREAD_VARIANTS = [
  { label: "spread>0%@2bp",    minSpreadAnn: 0.0,  feeBps: 2,  oneSided: true,  tailSkip: 3 },
  { label: "spread>1%@2bp",    minSpreadAnn: 0.01, feeBps: 2,  oneSided: true,  tailSkip: 3 },
  { label: "spread>2%@2bp",    minSpreadAnn: 0.02, feeBps: 2,  oneSided: true,  tailSkip: 5 },
  { label: "2sided>1%@2bp",    minSpreadAnn: 0.01, feeBps: 2,  oneSided: false, tailSkip: 3 },
  { label: "2sided>2%@5bp",    minSpreadAnn: 0.02, feeBps: 5,  oneSided: false, tailSkip: 5 },
];

type V = { label: string; days: number[]; rets: number[]; ann: number; perPeriodSharpe: number; cumPct: number; mdd: number };
function evalVariants<O>(variants: Array<{ label: string } & O>, fn: (bars: Bar[], o: O) => number[]): V[] {
  return variants.map((v) => {
    const streams = built.map(({ bars }) => ({ days: bars.slice(0, bars.length - 1).map((b) => b.day), rets: fn(bars, v) }));
    const pf = portfolio(streams);
    const s = sharpe(pf.rets);
    return { label: v.label, days: pf.days, rets: pf.rets, ann: s * ANN, perPeriodSharpe: s, cumPct: cum(pf.rets), mdd: maxDrawdown(pf.rets) };
  });
}

const spreadResults = evalVariants(SPREAD_VARIANTS, spreadReturns);

console.log("\n  SPREAD variant          annSharpe   cum%      maxDD%     n");
for (const r of spreadResults) console.log(`  ${r.label.padEnd(20)}  ${r.ann.toFixed(2).padStart(7)}  ${(r.cumPct * 100).toFixed(1).padStart(7)}  ${(r.mdd * 100).toFixed(1).padStart(7)}  ${r.days.length}`);

// ---------- CONTROL: outright front-basis carry on the SAME window ----------
const OUTRIGHT_VARIANTS = [
  { label: "out:contango>0%@2bp", minBasisAnn: 0.0,  feeBps: 2, oneSided: true,  tailSkip: 3 },
  { label: "out:contango>2%@2bp", minBasisAnn: 0.02, feeBps: 2, oneSided: true,  tailSkip: 3 },
  { label: "out:contango>5%@2bp", minBasisAnn: 0.05, feeBps: 2, oneSided: true,  tailSkip: 5 },
];
const outrightResults = evalVariants(OUTRIGHT_VARIANTS, outrightReturns);
console.log("\n  OUTRIGHT control        annSharpe   cum%      maxDD%     n");
for (const r of outrightResults) console.log(`  ${r.label.padEnd(20)}  ${r.ann.toFixed(2).padStart(7)}  ${(r.cumPct * 100).toFixed(1).padStart(7)}  ${(r.mdd * 100).toFixed(1).padStart(7)}  ${r.days.length}`);

// ---------- pick best SPREAD variant, run the gauntlet ----------
const best = spreadResults.reduce((a, b) => (b.ann > a.ann ? b : a));
const bestOut = outrightResults.reduce((a, b) => (b.ann > a.ann ? b : a));
console.log(`\nBEST SPREAD: ${best.label}  annSharpe=${best.ann.toFixed(2)}  cum=${(best.cumPct * 100).toFixed(1)}%  maxDD=${(best.mdd * 100).toFixed(1)}%`);
console.log(`BEST OUTRIGHT (control): ${bestOut.label}  annSharpe=${bestOut.ann.toFixed(2)}  cum=${(bestOut.cumPct * 100).toFixed(1)}%  maxDD=${(bestOut.mdd * 100).toFixed(1)}%`);

// PBO across ALL searched cells (spread + outright control) — honest about total search breadth.
const allResults = [...spreadResults, ...outrightResults];
const commonDays = allResults.map((r) => new Set(r.days)).reduce((acc, s) => new Set([...acc].filter((d) => s.has(d))));
const orderedDays = [...commonDays].sort((a, b) => a - b);
const idxByVariant = allResults.map((r) => new Map(r.days.map((d, i) => [d, i])));
const M: number[][] = orderedDays.map((d) => allResults.map((r, vi) => r.rets[idxByVariant[vi].get(d)!]));
const PBO = pbo(M, 8);

const trialSharpes = allResults.map((r) => r.perPeriodSharpe);
const { dsr } = deflatedSharpe(best.rets, trialSharpes);

// ---------- shuffle control: real curve convergence vs lucky drift? ----------
const rng = lcgRng(20260604);
const nullSharpes: number[] = [];
for (let k = 0; k < 1000; k++) {
  const perm = blockShufflePermutation(best.rets.length, 10, rng);
  nullSharpes.push(sharpe(applyPermutation(best.rets, perm)) * ANN);
}
const permRes = permutationTest(best.ann, nullSharpes, "greater");

// ---------- advisor: benchmark = CASH (market-neutral future-vs-future book) ----------
const benchRets = best.rets.map(() => 0);
const memo = adviseTrade({
  label: `term-structure-spread/${best.label}`,
  strategyReturns: best.rets,
  benchmarkReturns: benchRets,
  pbo: PBO,
  dsr,
  oosFrac: 0.3,
  betaAttractive: false,
  search: { hypothesesScanned: allResults.length },
});

console.log("\n================ GAUNTLET ================");
console.log(`annualized Sharpe (best spread):  ${best.ann.toFixed(2)}`);
console.log(`cumulative return:                ${(best.cumPct * 100).toFixed(1)}%  over ${best.days.length} days`);
console.log(`max drawdown:                     ${(best.mdd * 100).toFixed(1)}%`);
console.log(`  --- vs OUTRIGHT control ---`);
console.log(`outright best annSharpe:          ${bestOut.ann.toFixed(2)}   maxDD ${(bestOut.mdd * 100).toFixed(1)}%`);
console.log(`spread CLEANER than outright?     Sharpe ${best.ann > bestOut.ann ? "YES" : "NO"} (${best.ann.toFixed(2)} vs ${bestOut.ann.toFixed(2)})  |  DD ${Math.abs(best.mdd) < Math.abs(bestOut.mdd) ? "YES" : "NO"} (${(best.mdd * 100).toFixed(1)}% vs ${(bestOut.mdd * 100).toFixed(1)}%)`);
console.log(`  --- overfit + luck checks ---`);
console.log(`PBO (overfit prob):               ${PBO.toFixed(2)}   ${PBO < 0.3 ? "(robust)" : "(fragile)"}`);
console.log(`Deflated Sharpe (DSR):            ${dsr.toFixed(2)}   ${dsr > 0.95 ? "(survives multiple-testing)" : "(weak)"}`);
console.log(`shuffle control p-value:          ${permRes.pValue.toFixed(4)}  (obs ${best.ann.toFixed(2)} vs null mean ${(nullSharpes.reduce((a, b) => a + b, 0) / nullSharpes.length).toFixed(2)})`);
console.log(`\n${renderTradeMemo(memo)}`);
console.log(`\nADVISOR: ${memo.recommendation} | roiVerdict=${memo.advice.roiVerdict} | conviction=${memo.conviction}`);

// machine-readable tail for the harness
console.log(`\nRESULT_JSON ${JSON.stringify({
  bestSpread: { label: best.label, annSharpe: +best.ann.toFixed(3), cumPct: +(best.cumPct * 100).toFixed(2), maxDDPct: +(best.mdd * 100).toFixed(2), n: best.days.length },
  bestOutright: { label: bestOut.label, annSharpe: +bestOut.ann.toFixed(3), cumPct: +(bestOut.cumPct * 100).toFixed(2), maxDDPct: +(bestOut.mdd * 100).toFixed(2) },
  pbo: +PBO.toFixed(3), dsr: +dsr.toFixed(3), shuffleP: +permRes.pValue.toFixed(4),
  recommendation: memo.recommendation, roiVerdict: memo.advice.roiVerdict, conviction: memo.conviction,
})}`);
