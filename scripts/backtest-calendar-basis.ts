/**
 * _discover-calendar-basis-carry — CALENDAR (DATED-FUTURES) BASIS CARRY.
 *
 * EDGE: Binance quarterly delivery futures trade at a premium/discount to spot. That gap, expressed
 * annualized, is a basis you can LOCK by long spot + short the dated future (cash-and-carry) and
 * hold to expiry — the future converges to spot at delivery, so a positive (contango) basis is
 * harvested as the gap collapses. This is the textbook low-risk carry, distinct from PERP funding
 * carry (no funding cash flows here; the return is pure price convergence of the dated leg).
 *
 * DATA: discovered via proxiedFetch(fapi/v1/exchangeInfo & dapi/v1/exchangeInfo) — quarterly symbols
 * (CURRENT_QUARTER / NEXT_QUARTER) exist on both USD-M (fapi, BTC/ETH) and COIN-M (dapi, BTC/ETH/
 * XRP/BNB/SOL). The individual dated contracts only list ~6mo before expiry (~160d each), so for a
 * real multi-year history we use the CONTINUOUS-quarter klines (fapi/v1/continuousKlines with
 * pair+contractType) which stitch the rolling front/back quarter back to 2021/2022.
 *
 * MODEL (NO-LOOKAHEAD): position[i] decided from the basis OBSERVED at day i; realized i→i+1.
 *   carry per unit notional of (long spot, short future): ret = side·(spotRet − futRet) − fee
 *   side = +1 (long spot / short fut) when annualized basis at i ≥ +minBasis  (harvest contango)
 *        = −1 (short spot / long fut) when basis ≤ −minBasis                  (harvest backwardation)
 *        =  0 otherwise.
 * Roll days (continuous series stitches a new contract → daysToExpiry jumps UP) are skipped so the
 * artificial price seam doesn't leak into returns. daysToExpiry from the real quarterly calendar
 * (last Friday of Mar/Jun/Sep/Dec, 08:00 UTC). Last `tailSkip` days before expiry dropped (basis→0,
 * convergence noise + thin liquidity). Benchmark = CASH (0): this is a market-neutral book.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_discover-calendar-basis-carry.ts
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
  const d = new Date(Date.UTC(y, mZeroBased + 1, 0, 8, 0, 0)); // last day of the month, 08:00 UTC
  const back = (d.getUTCDay() - 5 + 7) % 7; // walk back to Friday (5)
  d.setUTCDate(d.getUTCDate() - back);
  return Math.floor(d.getTime() / 1000);
}
/** First quarterly expiry strictly after tSec — for CURRENT_QUARTER (front contract). */
function frontExpiry(tSec: number): number {
  const y0 = new Date(tSec * 1000).getUTCFullYear();
  for (let y = y0 - 1; y <= y0 + 1; y++) for (const m of [2, 5, 8, 11]) { const e = lastFridayUTC(y, m); if (e > tSec) return e; }
  return tSec;
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

// ---------- build one coin's basis-carry day stream ----------
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
    const roll = dte > prevDte + 1; // dte jumped up ⇒ a new contract was stitched in (seam)
    prevDte = dte;
    bars.push({ day, spot: sp, fut: fc, dte, annBasis: (fc / sp - 1) * (365 / Math.max(dte, 1)), roll });
  }
  return bars;
}

/** Daily NO-LOOKAHEAD carry returns for one coin — delegates to the tested lib primitive. */
function carryReturns(bars: Bar[], opts: { minBasisAnn: number; feeBps: number; tailSkip: number; oneSided: boolean }): number[] {
  return calendarBasisReturns(bars.map((b) => b.spot), bars.map((b) => b.fut), bars.map((b) => b.dte), bars.map((b) => b.roll), opts);
}

// ---------- equal-weight a list of per-coin daily streams keyed by day index ----------
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

// ========================== MAIN ==========================
// Universe: every quarterly we can source a continuous series for. fapi continuousKlines supports
// any pair that has had a quarterly; BTC/ETH are the deep ones. SOL/XRP/BNB quarterlies exist on
// COIN-M but continuousKlines is fapi-only, so we use the pairs fapi serves.
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
const CONTRACT = "CURRENT_QUARTER"; // front quarter = shortest convergence horizon = cleanest carry

console.log(`\ncalendar (dated-futures) basis carry — front-quarter continuous vs spot · ${PAIRS.length} pairs\n`);

const built: Array<{ pair: string; bars: Bar[] }> = [];
for (const pair of PAIRS) {
  try {
    const bars = await buildBars(pair, CONTRACT);
    if (bars.length < 120) { console.log(`  ${pair}: only ${bars.length} aligned days — skip`); continue; }
    const b = bars.filter((x) => x.dte >= 3 && Math.abs(x.annBasis) < 2); // drop expiry-week + absurd outliers for STATS
    const mean = b.reduce((s, x) => s + x.annBasis, 0) / b.length;
    const contango = b.filter((x) => x.annBasis > 0).length / b.length;
    console.log(`  ${pair}: ${bars.length}d  annBasis mean=${(mean * 100).toFixed(2)}%  contango=${(contango * 100).toFixed(0)}%  span ${new Date(bars[0].day * DAY * 1000).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].day * DAY * 1000).toISOString().slice(0, 10)}`);
    built.push({ pair, bars });
  } catch (e) { console.log(`  ${pair}: ERROR ${(e as Error).message}`); }
}
if (!built.length) { console.log("\nNO dated-future data reachable — dataAvailable=false\n"); process.exit(0); }

// ---------- variants (the search; PBO/DSR penalize this breadth) ----------
const VARIANTS = [
  { label: "contango>0%@1bp",  minBasisAnn: 0.0,  feeBps: 1,  oneSided: true,  tailSkip: 3 },
  { label: "contango>2%@2bp",  minBasisAnn: 0.02, feeBps: 2,  oneSided: true,  tailSkip: 3 },
  { label: "contango>5%@2bp",  minBasisAnn: 0.05, feeBps: 2,  oneSided: true,  tailSkip: 5 },
  { label: "2sided>2%@2bp",    minBasisAnn: 0.02, feeBps: 2,  oneSided: false, tailSkip: 3 },
  { label: "2sided>5%@5bp",    minBasisAnn: 0.05, feeBps: 5,  oneSided: false, tailSkip: 5 },
];

type V = { label: string; days: number[]; rets: number[]; ann: number; perPeriodSharpe: number; cumPct: number };
const results: V[] = [];
for (const v of VARIANTS) {
  const streams = built.map(({ bars }) => {
    const rets = carryReturns(bars, v);
    return { days: bars.slice(0, bars.length - 1).map((b) => b.day), rets };
  });
  const pf = portfolio(streams);
  const s = sharpe(pf.rets);
  results.push({ label: v.label, days: pf.days, rets: pf.rets, ann: s * ANN, perPeriodSharpe: s, cumPct: cum(pf.rets) });
}

console.log("\n  variant                annSharpe   cum%     n");
for (const r of results) console.log(`  ${r.label.padEnd(20)}  ${r.ann.toFixed(2).padStart(7)}  ${(r.cumPct * 100).toFixed(1).padStart(7)}  ${r.days.length}`);

// ---------- pick best, run the gauntlet ----------
const best = results.reduce((a, b) => (b.ann > a.ann ? b : a));
console.log(`\nBEST variant: ${best.label}  annSharpe=${best.ann.toFixed(2)}  cum=${(best.cumPct * 100).toFixed(1)}%\n`);

// PBO needs a common-time matrix across variants. Align on the intersection of days.
const commonDays = results.map((r) => new Set(r.days)).reduce((acc, s) => new Set([...acc].filter((d) => s.has(d))));
const orderedDays = [...commonDays].sort((a, b) => a - b);
const idxByVariant = results.map((r) => new Map(r.days.map((d, i) => [d, i])));
const M: number[][] = orderedDays.map((d) => results.map((r, vi) => r.rets[idxByVariant[vi].get(d)!]));
const PBO = pbo(M, 8);

const trialSharpes = results.map((r) => r.perPeriodSharpe);
const { dsr } = deflatedSharpe(best.rets, trialSharpes);

// ---------- shuffle control: is the carry from real basis convergence or a lucky path? ----------
// Block-shuffle the BEST variant's returns; under the null (no time-structured edge) the annualized
// Sharpe of a shuffled path should match. A carry whose Sharpe is destroyed by shuffling is genuine
// time-structure (basis mean-reverts to 0 at expiry); one that survives is just a positive drift.
const rng = lcgRng(20260604);
const nullSharpes: number[] = [];
for (let k = 0; k < 1000; k++) {
  const perm = blockShufflePermutation(best.rets.length, 10, rng);
  nullSharpes.push(sharpe(applyPermutation(best.rets, perm)) * ANN);
}
const perm = permutationTest(best.ann, nullSharpes, "greater");

// ---------- benchmark: equal-weight buy & hold of the underlying spots (is this just beta?) ----------
const benchRets = best.rets.map(() => 0); // market-neutral book ⇒ cash benchmark
const memo = adviseTrade({
  label: `calendar-basis-carry/${best.label}`,
  strategyReturns: best.rets,
  benchmarkReturns: benchRets,
  pbo: PBO,
  dsr,
  oosFrac: 0.3,
  betaAttractive: false, // a cash benchmark doesn't compound; this is pure carry
  search: { hypothesesScanned: VARIANTS.length },
});

console.log("================ GAUNTLET ================");
console.log(`annualized Sharpe (best): ${best.ann.toFixed(2)}`);
console.log(`cumulative return:        ${(best.cumPct * 100).toFixed(1)}%  over ${best.days.length} days`);
console.log(`PBO (overfit prob):       ${PBO.toFixed(2)}   ${PBO < 0.3 ? "(robust)" : "(fragile)"}`);
console.log(`Deflated Sharpe (DSR):    ${dsr.toFixed(2)}   ${dsr > 0.95 ? "(survives multiple-testing)" : "(weak)"}`);
console.log(`shuffle control p-value:  ${perm.pValue.toFixed(4)}  (obs annSharpe ${best.ann.toFixed(2)} vs null mean ${(nullSharpes.reduce((a, b) => a + b, 0) / nullSharpes.length).toFixed(2)})`);
console.log(`\n${renderTradeMemo(memo)}`);
console.log(`\nADVISOR: ${memo.recommendation} | roiVerdict=${memo.advice.roiVerdict} | conviction=${memo.conviction}`);
