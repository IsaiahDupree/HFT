/**
 * _intraday-intraday-vol-spike-reversion — INTRADAY VOL-SPIKE MEAN-REVERSION (minute scale).
 *
 * Hypothesis: after a SHARP minute-scale realized-vol spike (top decile of trailing realizedVol),
 * the immediate price move is an OVERREACTION and short-horizon price MEAN-REVERTS. So FADE the
 * sign of the move that produced the spike, hold N minutes, exit. Daily vol-reversion was
 * FALSIFIED (vol persists, no price-reversion edge) — this tests whether the MINUTE horizon differs.
 *
 * Everything NO-LOOKAHEAD:
 *  - realizedVol[i] = std of last VOL_N 1m log-returns ending at bar i (data ≤ i).
 *  - The top-decile vol threshold is EXPANDING: at bar i it is the TOP_DECILE quantile of all
 *    vol values strictly < i (no peeking at the present or future).
 *  - Signal at bar i: if vol[i] is a spike AND |ret[i]| (the move INTO bar i, close[i]/close[i-1]-1)
 *    is meaningful, take a position = -sign(ret[i]) (fade). Hold HOLD_N bars: realize the return
 *    from close[i] forward over close[i]→close[i+HOLD_N]. Entry at close[i] (known at i).
 *  - Round-trip cost FEE_BPS charged once per round-trip trade (entry+exit), plus SLIP_BPS slippage.
 *
 * Gauntlet: per-bar net Sharpe (annualized √(365*1440)), PBO (coins×params = config axis),
 * Deflated Sharpe, adviseTrade one-voice verdict, and a BLOCK-SHUFFLE permutation control on the
 * pooled net trade-return series (the decisive intraday test).
 *
 *   cd HFT-work && npx tsx scripts/_intraday-intraday-vol-spike-reversion.ts \
 *       [--days 14] [--vol-n 15] [--hold 5] [--fee-bps 10] [--slip-bps 2] [--move-mult 0]
 */
import "./_env.ts";
import { fetchBinanceKlines } from "../src/lib/data/binance.ts";
import { type VenueCandle } from "../src/lib/data/venue-candles.ts";
import { realizedVol } from "../src/lib/backtest/candle/indicators.ts";
import { sharpe, pbo, deflatedSharpe, median } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const DAYS = arg("--days", 14);
const VOL_N = arg("--vol-n", 15);       // trailing minutes for realized vol
const HOLD_N = arg("--hold", 5);        // minutes to hold the fade
const FEE_BPS = arg("--fee-bps", 10);   // round-trip taker fee (5bps/side)
const SLIP_BPS = arg("--slip-bps", 2);  // extra round-trip slippage
const MOVE_MULT = arg("--move-mult", 0); // require |ret[i]| >= MOVE_MULT * vol[i] to fade (0 = off)
const TOP_DECILE = 0.90;
const WARMUP = 600;                      // bars before the expanding decile + quantile is allowed to act
const PER_YEAR = 365 * 1440;             // minute bars / year
const annualize = (s: number) => s * Math.sqrt(PER_YEAR);
const RT_COST = (FEE_BPS + SLIP_BPS) / 1e4; // round-trip cost as a fraction

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Paginate Binance 1m klines via the proxy to cover `days` days ending now. */
async function fetchMinutes(symbol: string, days: number): Promise<VenueCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  let start = now - days * 24 * 3600;
  const all: VenueCandle[] = [];
  let guard = 0;
  while (start < now && guard++ < 80) {
    const page = await fetchBinanceKlines(symbol, "1m", { startUnix: start, limit: 1000 });
    if (!page.length) break;
    for (const c of page) all.push(c);
    const lastStart = page[page.length - 1].start_unix;
    if (lastStart <= start) break;             // no progress
    start = lastStart + 60;                     // next bar after the last we got
    if (page.length < 1000) break;              // reached the present
  }
  // de-dup + sort by time
  const seen = new Set<number>();
  const out = all.filter((c) => (seen.has(c.start_unix) ? false : (seen.add(c.start_unix), true)));
  out.sort((a, b) => a.start_unix - b.start_unix);
  return out;
}

/** Expanding TOP_DECILE quantile of vol values strictly before index i (no lookahead).
 *  Returns thr[i] = the q-quantile of {vol[j] : j < i, finite}, or NaN until enough history. */
function expandingQuantile(vol: number[], q: number, warmup: number): number[] {
  const thr: number[] = new Array(vol.length).fill(NaN);
  const hist: number[] = []; // kept sorted by insertion
  for (let i = 0; i < vol.length; i++) {
    if (hist.length >= warmup) {
      const idx = Math.min(hist.length - 1, Math.floor(q * (hist.length - 1)));
      thr[i] = hist[idx];
    }
    const v = vol[i];
    if (Number.isFinite(v)) {
      // insert v into sorted hist (binary search)
      let lo = 0, hi = hist.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (hist[m] < v) lo = m + 1; else hi = m; }
      hist.splice(lo, 0, v);
    }
  }
  return thr;
}

type CoinResult = {
  symbol: string;
  bars: number;
  trades: number;
  perBarNet: number[];   // length = bars-1, net per-bar return contribution (for Sharpe/shuffle on the strategy series)
  tradeNet: number[];    // per-trade net returns (entry-to-exit, cost charged), for trade stats + shuffle
  benchPerBar: number[]; // buy-and-hold per-bar returns aligned to perBarNet (benchmark)
};

// ---- the no-lookahead fade backtest (HOLD_N parameterized for the PBO grid) ----
function backtestCoinWithHold(symbol: string, candles: VenueCandle[], hold: number): CoinResult {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const vol = realizedVol(closes, VOL_N);
  const thr = expandingQuantile(vol, TOP_DECILE, WARMUP);
  const ret: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) { const p = closes[i - 1]; ret[i] = p > 0 && closes[i] > 0 ? closes[i] / p - 1 : NaN; }
  const pos: number[] = new Array(n).fill(0);
  const tradeNet: number[] = [];
  let i = WARMUP + VOL_N + 1;
  while (i < n - hold - 1) {
    const isSpike = Number.isFinite(vol[i]) && Number.isFinite(thr[i]) && vol[i] >= thr[i];
    const moveOk = Number.isFinite(ret[i]) && (MOVE_MULT <= 0 || Math.abs(ret[i]) >= MOVE_MULT * vol[i]);
    if (isSpike && moveOk && ret[i] !== 0) {
      const dir = -Math.sign(ret[i]);
      for (let k = 0; k < hold; k++) pos[i + k] = dir;
      const gross = dir * (closes[i + hold] / closes[i] - 1);
      tradeNet.push(gross - RT_COST);
      i += hold + 1;
    } else { i += 1; }
  }
  const perBarNet: number[] = [];
  const benchPerBar: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    const p = pos[j] ?? 0; const prev = j > 0 ? (pos[j - 1] ?? 0) : 0;
    const barRet = closes[j + 1] / closes[j] - 1;
    perBarNet.push(p * barRet - Math.abs(p - prev) * (RT_COST / 2));
    benchPerBar.push(barRet);
  }
  return { symbol, bars: n, trades: tradeNet.length, perBarNet, tradeNet, benchPerBar };
}

// ---- run ----
console.log(`\n=== INTRADAY VOL-SPIKE MEAN-REVERSION (minute) ===`);
console.log(`days=${DAYS} volN=${VOL_N} holdN=${HOLD_N} fee=${FEE_BPS}bps slip=${SLIP_BPS}bps moveMult=${MOVE_MULT} topDecile=${TOP_DECILE}`);
console.log(`round-trip cost charged = ${(RT_COST * 1e4).toFixed(1)}bps\n`);

const results: CoinResult[] = [];
for (const sym of SYMBOLS) {
  try {
    const candles = await fetchMinutes(sym, DAYS);
    const spanH = candles.length ? (candles[candles.length - 1].start_unix - candles[0].start_unix) / 3600 : 0;
    const r = backtestCoinWithHold(sym, candles, HOLD_N);
    results.push(r);
    console.log(`${sym}: ${candles.length} bars (${(spanH / 24).toFixed(1)}d span), ${r.trades} fade-trades`);
  } catch (e) {
    console.log(`${sym}: FETCH FAILED — ${(e as Error).message}`);
  }
}

if (!results.length) {
  console.log("\nNO DATA — aborting.");
  process.exit(1);
}

// ---- pooled trade stats ----
const allTradeNet = results.flatMap((r) => r.tradeNet);
const totalTrades = allTradeNet.length;
const totalBars = results.reduce((s, r) => s + r.bars, 0);
const totalDays = totalBars / 1440;
const tradesPerDay = totalDays > 0 ? totalTrades / totalDays : 0;
const avgTradeBps = totalTrades ? mean(allTradeNet) * 1e4 : 0;
const winRate = totalTrades ? allTradeNet.filter((x) => x > 0).length / totalTrades : 0;

// ---- pooled per-bar net series (concatenated across coins) for Sharpe + shuffle ----
const pooledPerBar = results.flatMap((r) => r.perBarNet);
const pooledBench = results.flatMap((r) => r.benchPerBar);
const perBarSharpe = sharpe(pooledPerBar);
const netSharpeAnn = annualize(perBarSharpe);
const benchSharpeAnn = annualize(sharpe(pooledBench));

// ---- gross (zero-cost) comparison: rebuild trade returns without cost ----
const grossTradeBps = totalTrades ? (avgTradeBps + RT_COST * 1e4) : 0; // gross = net + cost

// ---- PBO across coin×param configs: build a return matrix per a small param grid ----
// columns = configs (coin × holdN ∈ {3,5,10}); rows = aligned bars (truncate to shortest).
const PBO_HOLDS = [3, 5, 10];
const cfgSeries: number[][] = [];
const cfgLabels: string[] = [];
for (const sym of SYMBOLS) {
  const r0 = results.find((r) => r.symbol === sym);
  if (!r0) continue;
  const candles = await fetchMinutes(sym, DAYS);
  for (const h of PBO_HOLDS) {
    const rr = backtestCoinWithHold(sym, candles, h);
    cfgSeries.push(rr.perBarNet);
    cfgLabels.push(`${sym}-h${h}`);
  }
}
const minLen = cfgSeries.length ? Math.min(...cfgSeries.map((s) => s.length)) : 0;
let pboVal = 1, dsr = 0, sr0 = 0;
if (cfgSeries.length >= 2 && minLen >= 32) {
  const M: number[][] = [];
  for (let t = 0; t < minLen; t++) M.push(cfgSeries.map((s) => s[t]));
  pboVal = pbo(M, 8);
  const trialSharpes = cfgSeries.map((s) => sharpe(s));
  // best config = the chosen one (this coin set, this holdN) — use the pooled per-bar as "best"
  const d = deflatedSharpe(pooledPerBar, trialSharpes);
  dsr = d.dsr; sr0 = d.sr0;
}

// ---- block-shuffle permutation control on the pooled per-bar net series ----
// Block size ~ HOLD_N*2 so the held-position autocorr is preserved; only longer structure is broken.
const BLOCK = Math.max(2, HOLD_N * 2);
const rng = lcgRng(12345);
const observedSharpe = perBarSharpe;
const NULLS = 500;
const nullSharpes: number[] = [];
for (let p = 0; p < NULLS; p++) {
  const perm = blockShufflePermutation(pooledPerBar.length, BLOCK, rng);
  nullSharpes.push(sharpe(applyPermutation(pooledPerBar, perm)));
}
const perm = permutationTest(observedSharpe, nullSharpes, "greater");

// ---- advisor ----
const memo = adviseTrade({
  label: "intraday-vol-spike-reversion-1m",
  strategyReturns: pooledPerBar,
  benchmarkReturns: pooledBench,
  pbo: pboVal,
  dsr,
}, undefined as any);

// ---- report ----
console.log(`\n--- POOLED RESULTS (${SYMBOLS.length} coins, ${totalDays.toFixed(1)} coin-days) ---`);
console.log(`trades:            ${totalTrades}  (${tradesPerDay.toFixed(1)}/coin-day)`);
console.log(`avg net per-trade: ${avgTradeBps.toFixed(2)} bps   (gross ${grossTradeBps.toFixed(2)} bps before ${(RT_COST*1e4).toFixed(0)}bps cost)`);
console.log(`win rate:          ${(winRate * 100).toFixed(1)}%`);
console.log(`net Sharpe (ann):  ${netSharpeAnn.toFixed(3)}   [per-bar ${perBarSharpe.toFixed(5)}]`);
console.log(`bench Sharpe(ann): ${benchSharpeAnn.toFixed(3)}`);
console.log(`PBO:               ${pboVal.toFixed(3)}   (want < 0.30)`);
console.log(`Deflated Sharpe:   ${dsr.toFixed(3)}  (sr0=${sr0.toFixed(4)})`);
console.log(`SHUFFLE p-value:   ${perm.pValue.toFixed(4)}  (observed Sharpe ${observedSharpe.toFixed(5)} vs ${NULLS} block-shuffled nulls; block=${BLOCK})`);
console.log(`null Sharpe mean:  ${mean(nullSharpes).toFixed(5)}`);
console.log(`\nADVISOR: ${memo.recommendation} (conviction ${memo.conviction}/100)`);
console.log(memo.voice);

// ---- verdict ----
const netsPositive = avgTradeBps > 0 && netSharpeAnn > 0;
const survivesShuffle = perm.pValue < 0.05;
const firesEnough = tradesPerDay >= 0.5; // at least ~0.5 trades/coin-day to matter
let verdict: "REAL" | "MAYBE" | "NO";
if (netsPositive && survivesShuffle && firesEnough && netSharpeAnn > 1.0) verdict = "REAL";
else if (netsPositive && (survivesShuffle || netSharpeAnn > 0.5) && firesEnough) verdict = "MAYBE";
else verdict = "NO";
console.log(`\nVERDICT: ${verdict}`);
console.log(`  netsPositive=${netsPositive} survivesShuffle=${survivesShuffle} firesEnough=${firesEnough}`);

// emit a machine-readable line
console.log(`\nJSON ${JSON.stringify({
  netSharpe: +netSharpeAnn.toFixed(4),
  perTradeBps: +avgTradeBps.toFixed(3),
  grossTradeBps: +grossTradeBps.toFixed(3),
  tradesPerDay: +tradesPerDay.toFixed(3),
  totalTrades,
  winRate: +winRate.toFixed(4),
  pbo: +pboVal.toFixed(4),
  dsr: +dsr.toFixed(4),
  shufflePvalue: +perm.pValue.toFixed(4),
  advisor: memo.recommendation,
  verdict,
})}`);
