/**
 * _carry-deribit-vol-risk-premium — OPTIONS VOL-RISK-PREMIUM (VRP) CARRY.
 *
 * EDGE: Deribit's DVOL index (30-day forward IMPLIED vol on BTC, annualized %) typically sits ABOVE
 * the vol the market subsequently REALIZES. That spread (VRP = implied − realized) is the option
 * seller's structural yield: a delta-hedged short-vol book earns ~VRP when positive. This is CARRY
 * (you are PAID for warehousing variance/gap risk), not a directional bet — distinct from funding
 * carry and calendar-basis carry. Honest caveat: short vol has a FAT LEFT TAIL (crash gaps), so the
 * average yield is paid for bearing tail risk; the gauntlet + tail stats below keep us honest.
 *
 * DATA (both REAL, fetched live):
 *   IMPLIED  — Deribit get_volatility_index_data?currency=BTC&resolution=1D → DVOL daily OHLC; the
 *              CLOSE is the annualized implied-vol index (vol points, e.g. 65 = 65%). Available from
 *              ~2021-03; we page back to the start. Public API, NOT geo-blocked (direct fetch ok).
 *   REALIZED — BTC-USDT daily closes (proxiedFetch unblocks Binance) → realizedVol() (sample std of
 *              log-returns), annualized ×√365. We compute a TRAILING realized vol (data ≤ i, no peek)
 *              for the SIGNAL, and the NEXT-DAY realized variance for the REALIZED short-var PnL.
 *
 * CARRY MODEL (NO-LOOKAHEAD): a short, delta-hedged VARIANCE position struck at the implied vol.
 *   • Signal at day i (data ≤ i only): VRP_obs[i] = IV[i] − RV_trail[i]. Go SHORT vol (side=−1) when
 *     VRP_obs[i] ≥ minVRP; else flat. IV[i]=DVOL close at i, RV_trail[i] = trailing-N realized vol.
 *   • Realize i→i+1: a short variance swap struck at K=IV[i] pays, per day, (K² − rv_next²) where
 *     rv_next² = (r_{i+1})²·365 is the day's annualized realized variance (r = log return). Scaled by
 *     a variance-notional so a 1-vol-point move ≈ a sensible P&L; we normalize to VEGA terms:
 *         pnl_day = side · (K² − rv_next²) / (2·K)        ⇒  units of vol-points / 100 ≈ fraction.
 *     Dividing by 2K converts variance P&L → vega-equivalent (∂σ²/∂σ = 2σ), giving a return whose
 *     scale matches "vol points earned" — the canonical variance-swap-to-vega normalization.
 *   • Fee: each entry/exit pays feeVol vol-points of slippage (option bid/ask + hedge cost), charged
 *     on |Δside| as a vega-equivalent drag.
 * Return stream is the daily fractional P&L of the carry book; benchmark = CASH (0): market-neutral.
 *
 * GAUNTLET: sharpe (annualized ×√365) + pbo(M) across variants + deflatedSharpe(best, trialSharpes)
 * + a block-shuffle permutation control + adviseTrade memo. Plus a TAIL panel (worst day, skew) so
 * the fat-left-tail risk is reported, not hidden.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_carry-deribit-vol-risk-premium.ts
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { realizedVol } from "../src/lib/backtest/candle/indicators.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

const ANN = Math.sqrt(365);
const DAY_MS = 86_400_000;
const dayIdx = (ms: number) => Math.floor(Number(ms) / DAY_MS);

// ───────────────────────── DVOL (implied vol) — paged back to inception ─────────────────────────
// Deribit returns OHLC rows [ts(ms), open, high, low, close]; close = annualized implied vol (%).
async function fetchDvolDaily(currency = "BTC"): Promise<Map<number, number>> {
  const out = new Map<number, number>(); // dayIdx -> implied vol close (%)
  // Walk forward in ~1y windows from 2021-01-01 to now; resolution=1D ⇒ one bar/day.
  let start = Date.UTC(2021, 0, 1);
  const now = Date.now();
  while (start < now) {
    const end = Math.min(start + 360 * DAY_MS, now);
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Deribit HTTP ${r.status}`);
    const j = (await r.json()) as { result?: { data?: Array<[number, number, number, number, number]> } };
    for (const row of j.result?.data ?? []) out.set(dayIdx(row[0]), row[4]); // close
    start = end + DAY_MS;
  }
  return out;
}

// ───────────────────────── BTC spot daily closes (proxied Binance) ─────────────────────────
async function fetchBtcSpotDaily(): Promise<Map<number, number>> {
  // Two paged pulls of 1000 (Binance cap) to cover 2021→now.
  const out = new Map<number, number>();
  for (const startUnix of [Date.UTC(2021, 0, 1) / 1000, Date.UTC(2023, 9, 1) / 1000]) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000&startTime=${startUnix * 1000}`;
    const r = await proxiedFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    const j = (await r.json()) as Array<Array<number | string>>;
    for (const k of j) out.set(dayIdx(k[0] as number), Number(k[4])); // close
  }
  return out;
}

// ───────────────────────── build aligned daily series ─────────────────────────
console.log("Fetching DVOL (implied) + BTC spot (realized)…");
const [dvol, spot] = await Promise.all([fetchDvolDaily("BTC"), fetchBtcSpotDaily()]);
console.log(`  DVOL bars: ${dvol.size}   spot bars: ${spot.size}`);
if (dvol.size < 200 || spot.size < 200) throw new Error("insufficient data");

// common day grid (need both IV and spot)
const days = [...dvol.keys()].filter((d) => spot.has(d)).sort((a, b) => a - b);
const ivPct = days.map((d) => dvol.get(d)!);          // implied vol, % (e.g. 65)
const closes = days.map((d) => spot.get(d)!);
const iv = ivPct.map((v) => v / 100);                  // implied vol, fraction
// daily log returns (aligned to `days`)
const logret = closes.map((c, i) => (i === 0 ? 0 : Math.log(c / closes[i - 1])));

console.log(`  aligned days: ${days.length}  (${new Date(days[0] * DAY_MS).toISOString().slice(0, 10)} → ${new Date(days[days.length - 1] * DAY_MS).toISOString().slice(0, 10)})`);

// ───────────────────────── measurement: average VRP (implied − subsequent realized) ─────────────────────────
// FORWARD realized vol over the next 30 days (annualized) vs IV at the same day — pure descriptive
// stat (uses future data, MEASUREMENT ONLY, never feeds a position). Tells us if the premium exists.
const FWD = 30;
const fwdRV: number[] = days.map((_, i) => {
  if (i + FWD >= logret.length) return NaN;
  const win = logret.slice(i + 1, i + 1 + FWD);
  const m = win.reduce((s, x) => s + x, 0) / win.length;
  const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1);
  return Math.sqrt(v) * Math.sqrt(365); // annualized fraction
});
const vrpPts: number[] = [];
for (let i = 0; i < days.length; i++) if (Number.isFinite(fwdRV[i])) vrpPts.push((iv[i] - fwdRV[i]) * 100);
const meanVRP = vrpPts.reduce((s, x) => s + x, 0) / vrpPts.length;
const posShare = vrpPts.filter((x) => x > 0).length / vrpPts.length;
console.log(`\nMEASUREMENT (implied − subsequent-30d realized, vol points):`);
console.log(`  mean VRP = ${meanVRP.toFixed(2)} pts   P(VRP>0) = ${(posShare * 100).toFixed(0)}%   n=${vrpPts.length}`);

// ───────────────────────── trailing realized vol for the SIGNAL (NO-LOOKAHEAD) ─────────────────────────
// realizedVol(closes, n) = sample std of last n log-returns ending at i (NaN until i≥n). Annualize ×√365.
function trailingRVann(n: number): number[] {
  return realizedVol(closes, n).map((v) => (Number.isFinite(v) ? v * Math.sqrt(365) : NaN)); // fraction
}

// ───────────────────────── the carry: short delta-hedged VOL, sized to CONSTANT VEGA ─────────────────────────
// A single day's r²·365 is an unbiased but absurdly noisy variance estimate — modelling daily MTM on
// it is the scaling artifact that blew up v1. The HONEST short-vol carry sells the 30-day vol that
// DVOL actually references: on entry day i it sells a 30-day variance swap struck at IV[i] (sized so
// 1 vega = 1% per vol point), holds H days, and the P&L is the standard vol-swap convergence
//     pnl_position = side · (IV_entry − RV_realized[i→i+H])         [vol points → /100 = fraction]
// where RV_realized is the annualized realized vol OVER THE HOLDING WINDOW (the future the contract
// was priced against). To get a smooth DAILY return stream we run a LADDER: open one fresh H-day
// position per eligible day, each equal-vega, so on any day the book holds ~H overlapping positions
// and we book each one's per-day accrual of its eventual P&L (pnl_position / H). This is the textbook
// "sell a strip of options every day, hold to expiry" VRP harvester.
// NO-LOOKAHEAD: side[i] uses ONLY IV[i] + trailing RV[i] (≤ i); the position's REALIZED leg is the
// actual future RV — that is the realization (i→i+H), never used to DECIDE the position.
function rvOverWindow(i: number, H: number): number {
  // annualized realized vol of log-returns over days (i, i+H]  (the held window). NaN if truncated.
  if (i + H >= logret.length) return NaN;
  const win = logret.slice(i + 1, i + 1 + H);
  const m = win.reduce((s, x) => s + x, 0) / win.length;
  const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1);
  return Math.sqrt(v) * Math.sqrt(365);
}
function vrpCarryReturns(opts: { minVRPpts: number; rvWindow: number; feeVolPts: number; horizon: number }): { days: number[]; rets: number[] } {
  const rvTrail = trailingRVann(opts.rvWindow);
  const minVRP = opts.minVRPpts / 100;        // fraction
  const feeVol = opts.feeVolPts / 100;        // round-trip slippage per position, vol-point-equiv
  const H = opts.horizon;
  const rets = new Array(days.length).fill(0); // daily book P&L (fraction, vega units)
  for (let i = opts.rvWindow; i < days.length - H - 1; i++) {
    const K = iv[i], rvT = rvTrail[i];
    if (!(K > 0) || !Number.isFinite(rvT)) continue;
    if (K - rvT < minVRP) continue;            // only sell when observed premium positive enough
    const rvReal = rvOverWindow(i, H);         // realized vol over the held window (the realization)
    if (!Number.isFinite(rvReal)) continue;
    const posPnl = (K - rvReal) - feeVol;      // short vol P&L over the position, net of slippage
    // spread the position's P&L evenly across its H holding days → smooth daily book return
    for (let d = 1; d <= H; d++) rets[i + d] += posPnl / H;
  }
  // normalize the book to constant gross vega: divide by the AVG number of concurrent positions so
  // the daily return is "per unit vega deployed", not inflated by stacking H ladders.
  const concurrency = new Array(days.length).fill(0);
  for (let i = opts.rvWindow; i < days.length - H - 1; i++) {
    const K = iv[i], rvT = rvTrail[i];
    if (!(K > 0) || !Number.isFinite(rvT) || K - rvT < minVRP || !Number.isFinite(rvOverWindow(i, H))) continue;
    for (let d = 1; d <= H; d++) concurrency[i + d] += 1;
  }
  const rDays: number[] = [], rOut: number[] = [];
  for (let i = 0; i < days.length; i++) {
    if (concurrency[i] <= 0) continue;          // no live position that day
    rDays.push(days[i]);
    rOut.push(rets[i] / concurrency[i]);        // per-unit-vega daily return
  }
  return { days: rDays, rets: rOut };
}

// ───────────────────────── variant grid ─────────────────────────
const VARIANTS = [
  { label: "VRP>0,rv10,H30,fee1",   minVRPpts: 0,  rvWindow: 10, feeVolPts: 1.0, horizon: 30 },
  { label: "VRP>2,rv10,H30,fee1",   minVRPpts: 2,  rvWindow: 10, feeVolPts: 1.0, horizon: 30 },
  { label: "VRP>5,rv10,H30,fee1",   minVRPpts: 5,  rvWindow: 10, feeVolPts: 1.0, horizon: 30 },
  { label: "VRP>0,rv20,H30,fee1",   minVRPpts: 0,  rvWindow: 20, feeVolPts: 1.0, horizon: 30 },
  { label: "VRP>5,rv20,H30,fee1",   minVRPpts: 5,  rvWindow: 20, feeVolPts: 1.0, horizon: 30 },
  { label: "VRP>5,rv20,H30,fee2",   minVRPpts: 5,  rvWindow: 20, feeVolPts: 2.0, horizon: 30 },
  { label: "VRP>10,rv20,H30,fee2",  minVRPpts: 10, rvWindow: 20, feeVolPts: 2.0, horizon: 30 },
];

const cum = (r: number[]) => r.reduce((s, x) => s + x, 0); // additive per-vega P&L (not compounded)
type V = { label: string; days: number[]; rets: number[]; ann: number; pps: number; cumPct: number; nTrades: number };
const results: V[] = [];
for (const v of VARIANTS) {
  const { days: d, rets } = vrpCarryReturns(v);
  const s = sharpe(rets);
  const active = rets.filter((x) => x !== 0).length;
  results.push({ label: v.label, days: d, rets, ann: s * ANN, pps: s, cumPct: cum(rets), nTrades: active });
}

console.log(`\n  variant                   annSharpe   cumP&L    nDays  active`);
for (const r of results) console.log(`  ${r.label.padEnd(24)} ${r.ann.toFixed(2).padStart(7)}  ${(r.cumPct * 100).toFixed(1).padStart(7)}%  ${String(r.days.length).padStart(5)}  ${String(r.nTrades).padStart(5)}`);

// ───────────────────────── HONEST overlap correction ─────────────────────────
// The H-day ladder makes consecutive daily returns share ~29/30 of the same positions, so the naive
// daily Sharpe is INFLATED by autocorrelation. The honest risk-adjusted number uses NON-OVERLAPPING
// positions: enter once every H days, hold to expiry, one independent P&L per non-overlapping block.
// This is the un-smoothed truth about the carry's risk.
function nonOverlapPnl(opts: { minVRPpts: number; rvWindow: number; feeVolPts: number; horizon: number }): number[] {
  const rvTrail = trailingRVann(opts.rvWindow);
  const minVRP = opts.minVRPpts / 100, feeVol = opts.feeVolPts / 100, H = opts.horizon;
  const out: number[] = [];
  for (let i = opts.rvWindow; i < days.length - H - 1; i += H) { // step by H → independent blocks
    const K = iv[i], rvT = rvTrail[i];
    if (!(K > 0) || !Number.isFinite(rvT) || K - rvT < minVRP) continue;
    const rvReal = rvOverWindow(i, H);
    if (!Number.isFinite(rvReal)) continue;
    out.push((K - rvReal) - feeVol); // one independent short-vol position P&L (vol-point fraction)
  }
  return out;
}

// ───────────────────────── pick best, run the gauntlet ─────────────────────────
const best = results.reduce((a, b) => (b.ann > a.ann ? b : a));
console.log(`\nBEST: ${best.label}  annSharpe=${best.ann.toFixed(2)}  cumP&L=${(best.cumPct * 100).toFixed(1)}%`);

// PBO matrix: align variants on common days.
const commonDays = results.map((r) => new Set(r.days)).reduce((acc, s) => new Set([...acc].filter((d) => s.has(d))));
const orderedDays = [...commonDays].sort((a, b) => a - b);
const idxByVariant = results.map((r) => new Map(r.days.map((d, i) => [d, i])));
const M: number[][] = orderedDays.map((d) => results.map((r, vi) => r.rets[idxByVariant[vi].get(d)!]));
const PBO = pbo(M, 8);
const { dsr } = deflatedSharpe(best.rets, results.map((r) => r.pps));

// shuffle control: a real carry's edge survives because of the persistent positive premium (a drift),
// NOT time structure — so unlike a mean-reverting calendar basis we expect the shuffle to MATCH (the
// edge is a positive mean, scattered uniformly). What we're really checking: is the Sharpe explained
// by a few lucky clustered days? If shuffling DESTROYS it, the "carry" was a couple of regime windows.
const rng = lcgRng(20260604);
const nullSharpes: number[] = [];
for (let k = 0; k < 1000; k++) nullSharpes.push(sharpe(applyPermutation(best.rets, blockShufflePermutation(best.rets.length, 10, rng))) * ANN);
const permP = permutationTest(best.ann, nullSharpes, "greater");

// ───────────────────────── TAIL panel (short vol = fat left tail; report it) ─────────────────────────
const sorted = [...best.rets].sort((a, b) => a - b);
const worst = sorted[0], p1 = sorted[Math.floor(sorted.length * 0.01)];
const mu = best.rets.reduce((s, x) => s + x, 0) / best.rets.length;
const sd = Math.sqrt(best.rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (best.rets.length - 1));
const skew = best.rets.reduce((s, x) => s + ((x - mu) / sd) ** 3, 0) / best.rets.length;
const wins = best.rets.filter((x) => x > 0).length, losses = best.rets.filter((x) => x < 0).length;

// ───────────────────────── advisor memo ─────────────────────────
const memo = adviseTrade({
  label: `vrp-short-vol-carry/${best.label}`,
  strategyReturns: best.rets,
  benchmarkReturns: best.rets.map(() => 0), // CASH: market-neutral carry book
  pbo: PBO,
  dsr,
  oosFrac: 0.3,
  betaAttractive: false, // cash doesn't compound; pure carry vs zero
  search: { hypothesesScanned: VARIANTS.length },
});

// honest non-overlapping Sharpe for the best variant (un-inflated by the H-day ladder overlap)
const bestVar = VARIANTS.find((v) => v.label === best.label)!;
const noPnl = nonOverlapPnl(bestVar);
const noSharpePerBlock = sharpe(noPnl);             // per H-day block
const blocksPerYear = 365 / bestVar.horizon;
const noAnnSharpe = noSharpePerBlock * Math.sqrt(blocksPerYear);
const noMean = noPnl.reduce((s, x) => s + x, 0) / noPnl.length;
const noWin = noPnl.filter((x) => x > 0).length;

console.log("\n================ GAUNTLET ================");
console.log(`mean VRP (implied−realized):  ${meanVRP.toFixed(2)} vol pts   P(VRP>0)=${(posShare * 100).toFixed(0)}%`);
console.log(`annualized Sharpe (best, ladder):  ${best.ann.toFixed(2)}  ← overlap-inflated, do not trust`);
console.log(`annualized Sharpe (NON-OVERLAP):    ${noAnnSharpe.toFixed(2)}  ← HONEST (${noPnl.length} indep ${bestVar.horizon}d blocks, win ${noWin}/${noPnl.length}, mean ${(noMean * 100).toFixed(1)} vol pts)`);
console.log(`ladder annSharpe (best):      ${best.ann.toFixed(2)}`);
console.log(`cumulative P&L (vega units):  ${(best.cumPct * 100).toFixed(1)}%  over ${best.days.length} days`);
console.log(`PBO (overfit prob):           ${PBO.toFixed(2)}   ${PBO < 0.3 ? "(robust)" : "(fragile)"}`);
console.log(`Deflated Sharpe (DSR):        ${dsr.toFixed(2)}   ${dsr > 0.95 ? "(survives MT)" : "(weak)"}`);
console.log(`shuffle-control p:            ${permP.pValue.toFixed(3)}  (null mean ann Sharpe ${(nullSharpes.reduce((s, x) => s + x, 0) / nullSharpes.length).toFixed(2)})`);
console.log("---- TAIL (short vol = fat left tail) ----");
console.log(`daily   worst: ${(worst * 100).toFixed(2)}%   1%ile: ${(p1 * 100).toFixed(2)}%   skew: ${skew.toFixed(2)}   win/loss days: ${wins}/${losses}`);
const noSorted = [...noPnl].sort((a, b) => a - b);
console.log(`block   worst ${bestVar.horizon}d: ${(noSorted[0] * 100).toFixed(1)} vol pts   2nd-worst: ${(noSorted[1] * 100).toFixed(1)}   best: ${(noSorted[noSorted.length - 1] * 100).toFixed(1)}  (these are the real gap-risk events)`);
console.log("\n================ ADVISOR ================");
console.log(renderTradeMemo(memo));
console.log(`\nVERDICT: ${memo.recommendation}  (conviction ${memo.conviction})`);

// machine-readable footer. annReturnPct = mean per-position VRP captured, annualized over the # of
// non-overlapping holding blocks per year (the realistic gross carry yield in vol-point/vega terms).
const annReturnPct = noMean * blocksPerYear * 100;
console.log(`\nJSON ${JSON.stringify({ meanVRP: +meanVRP.toFixed(2), annSharpeLadder: +best.ann.toFixed(2), annSharpe: +noAnnSharpe.toFixed(2), annReturnPct: +annReturnPct.toFixed(1), pbo: +PBO.toFixed(2), dsr: +dsr.toFixed(2), permP: +permP.pValue.toFixed(3), worstDayPct: +(worst * 100).toFixed(2), skew: +skew.toFixed(2), recommendation: memo.recommendation, best: best.label })}`);
