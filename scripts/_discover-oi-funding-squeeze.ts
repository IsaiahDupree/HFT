import "./_env.ts";
/**
 * DISCOVERY: OPEN-INTEREST × FUNDING SQUEEZE (mean-reversion fade)
 * --------------------------------------------------------------
 * Hypothesis: rapidly rising open interest WITH extreme funding marks a crowded
 * position that snaps back. When ΔOI is large AND funding is extreme-positive
 * (crowded LONGS paying to hold) -> fade by SHORTING next bar (long-squeeze).
 * When ΔOI large AND funding extreme-negative (crowded SHORTS) -> fade by going
 * LONG next bar (short-squeeze).
 *
 * NO-LOOKAHEAD: signal at bar i uses OI[i-w..i] and funding[i] only; position is
 * held over i->i+1 and realized on the i->i+1 perp price return.
 *
 * HARD DATA CEILING: Binance futures/data/openInterestHist retains only ~30 DAYS
 * of history at ANY granularity (verified: 31 daily bars, 186 4h bars, all
 * 2026-05-05 -> 2026-06-05). So this is a SINGLE ~31-day regime. We use 4h bars
 * to maximize the sample and POOL across a basket of liquid alts, but every honest
 * caveat about a one-month, fully time-overlapping window applies. This is a
 * feasibility/sign-check, NOT a validated edge.
 */
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { fetchBinancePerpKlines, fetchBinanceFunding } from "../src/lib/data/binance.ts";
import { sharpe, pbo, deflatedSharpe } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { blockShufflePermutation, applyPermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control.ts";

const PERIOD = "4h";
const BARS_PER_YEAR = 365 * 6; // 4h bars
const ANN = Math.sqrt(BARS_PER_YEAR);
const FEE_BPS = 5; // taker round-trip-ish per side change on the perp leg

// Liquid alts most prone to crowded-position squeezes (and present in our funding set).
const SYMBOLS = ["SOLUSDT", "WIFUSDT", "ENAUSDT", "1000PEPEUSDT", "PNUTUSDT", "SEIUSDT", "TIAUSDT", "STRKUSDT", "ETHUSDT", "BTCUSDT"];

type OiRow = { t: number; oi: number };
async function fetchOi(symbol: string): Promise<OiRow[]> {
  const r = await proxiedFetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${PERIOD}&limit=500`);
  if (!r.ok) return [];
  const j = (await r.json()) as Array<{ sumOpenInterest: string; timestamp: number }>;
  if (!Array.isArray(j)) return [];
  return j.map((x) => ({ t: Math.floor(x.timestamp / 1000), oi: +x.sumOpenInterest })).filter((x) => Number.isFinite(x.oi)).sort((a, b) => a.t - b.t);
}

// Forward-fill a sorted funding series ({time(sec),rate}) onto a target timestamp grid:
// value at grid t = the most recent funding rate with time <= t (NO-LOOKAHEAD).
function ffillFunding(grid: number[], fund: { time: number; rate: number }[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(grid.length).fill(undefined);
  let j = 0; let cur: number | undefined = undefined;
  const f = [...fund].sort((a, b) => a.time - b.time);
  for (let i = 0; i < grid.length; i++) {
    while (j < f.length && f[j].time <= grid[i]) { cur = f[j].rate; j++; }
    out[i] = cur;
  }
  return out;
}

// Align perp closes onto the OI timestamp grid (exact match on 4h boundaries).
function alignClose(grid: number[], candles: { start_unix: number; close: number }[]): (number | undefined)[] {
  const m = new Map<number, number>();
  for (const c of candles) m.set(c.start_unix, c.close);
  return grid.map((t) => m.get(t));
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

type SymData = { sym: string; t: number[]; oi: number[]; close: (number | undefined)[]; fund: (number | undefined)[] };

// Build the squeeze signal for one symbol with given params; return per-bar net
// returns aligned to bars [0..n-2] (return realized over i->i+1). NO-LOOKAHEAD.
function squeezeReturns(d: SymData, p: { w: number; oiZ: number; fundZ: number; zwin: number }): { ret: number[]; trades: number } {
  const n = d.t.length;
  const out: number[] = []; let trades = 0; let prevPos = 0;
  // rolling stats use ONLY the trailing window ending at i (no future data)
  for (let i = 0; i < n - 1; i++) {
    let pos = 0;
    const c0 = d.close[i]; const c1 = d.close[i + 1]; const f = d.fund[i];
    const oiNow = d.oi[i]; const oiPast = d.oi[i - p.w];
    const haveStats = i >= Math.max(p.w, p.zwin);
    if (haveStats && c0 != null && c1 != null && f != null && oiNow != null && oiPast != null && oiPast > 0) {
      // ΔOI over lookback w, expressed as a z-score vs trailing zwin of ΔOI
      const dOiSeries: number[] = [];
      for (let k = i - p.zwin + 1; k <= i; k++) {
        const a = d.oi[k]; const b = d.oi[k - p.w];
        if (a != null && b != null && b > 0) dOiSeries.push(a / b - 1);
      }
      const dOiNow = oiNow / oiPast - 1;
      const oiMu = mean(dOiSeries); const oiSd = std(dOiSeries);
      const oiZscore = oiSd > 0 ? (dOiNow - oiMu) / oiSd : 0;
      // funding z-score vs trailing zwin
      const fSeries: number[] = [];
      for (let k = i - p.zwin + 1; k <= i; k++) { const fk = d.fund[k]; if (fk != null) fSeries.push(fk); }
      const fMu = mean(fSeries); const fSd = std(fSeries);
      const fZscore = fSd > 0 ? (f - fMu) / fSd : 0;
      // CROWDED LONGS: OI surging AND funding extreme-positive -> fade SHORT
      if (oiZscore >= p.oiZ && fZscore >= p.fundZ) pos = -1;
      // CROWDED SHORTS: OI surging AND funding extreme-negative -> fade LONG
      else if (oiZscore >= p.oiZ && fZscore <= -p.fundZ) pos = +1;
    }
    const priceRet = c0 != null && c1 != null && c0 > 0 ? c1 / c0 - 1 : 0;
    const fundPay = pos !== 0 && f != null ? pos * (-f) : 0; // a SHORT collects +funding; long pays it
    const fee = Math.abs(pos - prevPos) * (FEE_BPS / 1e4);
    out.push(pos * priceRet + fundPay - fee);
    if (pos !== prevPos && pos !== 0) trades++;
    prevPos = pos;
  }
  return { ret: out, trades };
}

// ---- LOAD DATA (live) ----
console.log(`[load] fetching 4h OI + perp klines + funding for ${SYMBOLS.length} symbols via proxy...`);
const data: SymData[] = [];
for (const sym of SYMBOLS) {
  try {
    const oi = await fetchOi(sym);
    if (oi.length < 60) { console.log(`  ${sym}: OI rows ${oi.length} < 60, skip`); continue; }
    const startSec = oi[0].t - 86400;
    const klines = await fetchBinancePerpKlines(sym, PERIOD, { startUnix: startSec, limit: 1000 });
    const fund = await fetchBinanceFunding(sym, { startUnix: startSec, limit: 1000 });
    const grid = oi.map((x) => x.t);
    const close = alignClose(grid, klines);
    const ff = ffillFunding(grid, fund);
    const covered = close.filter((x) => x != null).length;
    data.push({ sym, t: grid, oi: oi.map((x) => x.oi), close, fund: ff });
    console.log(`  ${sym}: OI ${oi.length} bars, price-cover ${covered}/${grid.length}, funding pts ${fund.length}`);
  } catch (e: any) { console.log(`  ${sym}: ERR ${e.message}`); }
}

if (data.length === 0) { console.log("NO DATA — aborting."); process.exit(0); }
const span = (data[0].t[data[0].t.length - 1] - data[0].t[0]) / 86400;
console.log(`[load] ${data.length} symbols, ~${data[0].t.length} bars each, span ~${span.toFixed(1)} days (ONE regime).`);

// ---- PARAM GRID (for PBO / DSR multiple-testing) ----
const grid: { w: number; oiZ: number; fundZ: number; zwin: number }[] = [];
for (const w of [1, 2, 3, 6]) for (const oiZ of [1.0, 1.5, 2.0]) for (const fundZ of [1.0, 1.5, 2.0]) {
  grid.push({ w, oiZ, fundZ, zwin: 30 });
}

// Pool one config across all symbols -> a single per-bar return series (equal weight across
// whichever symbols are signalling that bar; if none signal, return 0 for that bar).
function pooledReturns(p: { w: number; oiZ: number; fundZ: number; zwin: number }): { ret: number[]; trades: number } {
  const per = data.map((d) => squeezeReturns(d, p));
  const minLen = Math.min(...per.map((x) => x.ret.length));
  const ret: number[] = [];
  for (let i = 0; i < minLen; i++) {
    const vals = per.map((x) => x.ret[i]);
    ret.push(mean(vals)); // equal-weight basket
  }
  const trades = per.reduce((s, x) => s + x.trades, 0);
  return { ret, trades };
}

// ---- RUN GRID ----
const variants = grid.map((p) => { const r = pooledReturns(p); return { p, ...r, sh: sharpe(r.ret) }; });
// PBO matrix M[t][c]
const minLen = Math.min(...variants.map((v) => v.ret.length));
const M: number[][] = [];
for (let t = 0; t < minLen; t++) M.push(variants.map((v) => v.ret[t]));
const trialSharpes = variants.map((v) => v.sh);
const best = variants.reduce((b, v) => (v.sh > b.sh ? v : b), variants[0]);

console.log(`\n[grid] ${variants.length} configs. Best by in-sample Sharpe:`);
console.log(`  w=${best.p.w} oiZ=${best.p.oiZ} fundZ=${best.p.fundZ} zwin=${best.p.zwin}  perBarSharpe=${best.sh.toFixed(3)}  trades=${best.trades}  bars=${best.ret.length}`);

const annSharpe = best.sh * ANN;
const cum = best.ret.reduce((s, r) => s + r, 0); // log-ish/simple cum (small returns)
const nonZero = best.ret.filter((r) => r !== 0).length;
const pboVal = pbo(M, 8);
const { dsr, sr0, sr } = deflatedSharpe(best.ret, trialSharpes);

// ---- SHUFFLE CONTROL: does a TIME-SHUFFLED version of the best signal keep its Sharpe? ----
// Shuffle the bar order of the pooled OI/funding inputs is complex; instead shuffle the
// per-bar RETURN series of the best config in blocks and recompute Sharpe. If the real
// ordering's Sharpe isn't beyond the null, the structure isn't temporal.
// (Honest note: shuffling returns of a mean-reversion fade tests whether the SIGN/magnitude
//  structure beats a random reordering of the same returns — a sanity null, not a full
//  signal-permutation. With ~30 days it is what's available.)
const rng = lcgRng(12345);
const NULL = 1000;
const nullSharpes: number[] = [];
for (let s = 0; s < NULL; s++) {
  const perm = blockShufflePermutation(best.ret.length, 6, rng); // 1-day blocks (6×4h)
  nullSharpes.push(sharpe(applyPermutation(best.ret, perm)));
}
const perm = permutationTest(best.sh, nullSharpes, best.sh >= 0 ? "greater" : "less");

// ---- ADVISOR ----
const benchmark = new Array(best.ret.length).fill(0); // market-neutral -> cash benchmark
const memo = adviseTrade({
  label: "OI×Funding squeeze fade (4h, pooled)",
  strategyReturns: best.ret,
  benchmarkReturns: benchmark,
  pbo: pboVal,
  dsr,
  oosFrac: 0.4,
  betaAttractive: false, // market-neutral, no basket beta to fall back on
  search: { hypothesesScanned: variants.length, bonferroniSurvivors: dsr > 0.95 ? 1 : 0 },
});

console.log("\n==================== GAUNTLET ====================");
console.log(`annualized Sharpe (best):  ${annSharpe.toFixed(3)}   (per-bar ${sr.toFixed(3)})`);
console.log(`cumulative return (best):  ${(cum * 100).toFixed(2)}%   over ${best.ret.length} 4h bars (~${span.toFixed(0)}d)`);
console.log(`active bars (nonzero pos): ${nonZero}/${best.ret.length}  (${(100 * nonZero / best.ret.length).toFixed(1)}%)  total entries=${best.trades}`);
console.log(`PBO:                       ${pboVal.toFixed(3)}   (want < 0.30)`);
console.log(`Deflated Sharpe (DSR):     ${dsr.toFixed(3)}   sr0(expected-max-under-null)=${sr0.toFixed(3)}   (want > 0.95)`);
console.log(`Shuffle control p-value:   ${perm.pValue.toFixed(3)}   (best Sharpe vs ${NULL} block-shuffles; want < 0.05)`);
console.log("\n" + renderTradeMemo(memo));
console.log("\n[verdict-data] " + JSON.stringify({
  annSharpe: +annSharpe.toFixed(3), pbo: +pboVal.toFixed(3), dsr: +dsr.toFixed(3),
  shuffleP: +perm.pValue.toFixed(3), cumPct: +(cum * 100).toFixed(2), bars: best.ret.length,
  spanDays: +span.toFixed(1), symbols: data.length, recommendation: memo.recommendation, roiVerdict: memo.advice.roiVerdict,
}));
