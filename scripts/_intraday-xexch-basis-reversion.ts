/**
 * _intraday-xexch-basis-reversion — INTRADAY edge hunt: CROSS-EXCHANGE BASIS DISLOCATION REVERSION.
 *
 * HYPOTHESIS: the Coinbase(follower)-vs-Binance(leader) basis has a structural offset (USDT/USD +
 * venue spread). When the DE-MEANED basis deviation (basis minus its rolling EWMA baseline) blows
 * past a band, it reverts — a market-neutral convergence trade: long the cheap leg / short the rich
 * leg, exit when the deviation collapses back inside.
 *
 * BRUTAL HONESTY BUILT IN:
 *   - This is a TWO-LEG trade. You pay taker fees + slippage on BOTH venues, on BOTH entry and exit.
 *     We charge a realistic round-trip across both legs and report the per-trade bps NET of that.
 *   - NO-LOOKAHEAD: signal at bar i uses the EWMA baseline through bar i-1 and basis at bar i;
 *     the convergence P&L is realized over i -> i+1 (and onward until exit), never peeking.
 *   - Binance LEADS Coinbase ~250-500ms intra-minute, but at the MINUTE close both prints are
 *     stale relative to that lead; we are NOT racing the leader, we're betting the basis mean-reverts.
 *   - GAUNTLET: per-trade net bps, trades/day, annualized net Sharpe, PBO/DSR, and the decisive
 *     BLOCK-SHUFFLE permutation control. If the "edge" is a cost illusion or dies on the shuffle, we say NO.
 *
 * Run: cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_intraday-xexch-basis-reversion.ts
 */
import "./_env.ts";
import { parseBinanceKlines } from "../src/lib/data/binance.ts";
import { parseCoinbaseExchangeCandles, type VenueCandle } from "../src/lib/data/venue-candles.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { basisBps, ewma } from "../src/lib/data/reference-price.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const MIN = 60;
const BARS_PER_YEAR = 365 * 1440; // minute bars/year
const ANN = Math.sqrt(BARS_PER_YEAR);

// ---------------- DATA: paginate Binance proxy klines (1000/call ~ 16.7h) ----------------
async function fetchBinanceMinutes(symbol: string, days: number): Promise<VenueCandle[]> {
  const nowMs = Date.now();
  let startMs = nowMs - days * 24 * 3600 * 1000;
  const all: VenueCandle[] = [];
  let guard = 0;
  while (startMs < nowMs && guard++ < 80) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000&startTime=${startMs}`;
    const r = await proxiedFetch(url);
    if (!r.ok) { console.error(`  binance HTTP ${r.status}`); break; }
    const raw = (await r.json()) as Array<Array<number | string>>;
    if (!Array.isArray(raw) || raw.length === 0) break;
    all.push(...parseBinanceKlines(raw));
    const lastOpen = Number(raw[raw.length - 1][0]);
    if (raw.length < 1000) break;
    startMs = lastOpen + 60_000; // next minute after the last open
  }
  // dedup + sort happens in parseBinanceKlines/sanitize per-page; do a final dedup by start_unix
  const seen = new Set<number>(); const out: VenueCandle[] = [];
  for (const c of all.sort((a, b) => a.start_unix - b.start_unix)) { if (!seen.has(c.start_unix)) { seen.add(c.start_unix); out.push(c); } }
  return out;
}

// ---------------- DATA: paginate Coinbase Exchange public candles (300/call ~ 5h) ----------------
async function fetchCoinbaseMinutes(product: string, days: number): Promise<VenueCandle[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  let end = nowSec;
  const earliest = nowSec - days * 24 * 3600;
  const all: VenueCandle[] = [];
  let guard = 0;
  while (end > earliest && guard++ < 200) {
    const start = Math.max(earliest, end - 300 * MIN);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${start}&end=${end}`;
    const r = await fetch(url, { headers: { "User-Agent": "hft-research/1.0" } });
    if (!r.ok) { console.error(`  coinbase HTTP ${r.status}`); await sleep(300); end = start; continue; }
    const raw = (await r.json()) as Array<Array<number | string>>;
    if (!Array.isArray(raw) || raw.length === 0) { end = start; continue; }
    all.push(...parseCoinbaseExchangeCandles(raw));
    end = start; // step the window back
    await sleep(120); // be gentle with the public endpoint
  }
  const seen = new Set<number>(); const out: VenueCandle[] = [];
  for (const c of all.sort((a, b) => a.start_unix - b.start_unix)) { if (!seen.has(c.start_unix)) { seen.add(c.start_unix); out.push(c); } }
  return out;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---------------- ALIGN by minute ----------------
type Row = { t: number; binance: number; coinbase: number };
function align(bin: VenueCandle[], cb: VenueCandle[]): Row[] {
  const cbMap = new Map(cb.map((c) => [c.start_unix, c.close]));
  const out: Row[] = [];
  for (const b of bin) {
    const c = cbMap.get(b.start_unix);
    if (c == null) continue;
    out.push({ t: b.start_unix, binance: b.close, coinbase: c });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------- SIGNAL + NET P&L (NO-LOOKAHEAD) ----------------
// Convergence trade on the de-meaned basis. follower=Coinbase, leader=Binance.
// dev[i] = basis[i] - baseline_through_(i-1). When |dev| > entryBand we open a market-neutral
// position betting the spread (coinbase - binance) reverts toward the baseline. P&L per held bar =
// position * change in the SPREAD return. We approximate the spread leg return with the basis change
// in bps (the convergence we actually capture). Costs: round-trip taker on BOTH legs on open + close.
type Params = { alpha: number; entryBps: number; exitBps: number; maxHold: number; legCostBps: number; slipBps: number };

type Bt = {
  perBarNet: number[];        // net return per bar (for Sharpe), aligned to rows[i] -> i+1
  perTradeNetBps: number[];   // net bps per completed trade
  trades: number;
  bars: number;
  spanDays: number;
};

function backtest(rows: Row[], p: Params): Bt {
  const n = rows.length;
  const perBarNet = new Array(Math.max(0, n - 1)).fill(0);
  const perTradeNetBps: number[] = [];

  // rolling EWMA baseline of the basis (causal: baseline[i] uses basis[0..i]; for the SIGNAL at bar i
  // we use baselinePrev = baseline through i-1 so bar i isn't part of its own baseline).
  let baseline = NaN;
  let pos = 0;             // +1 = long the spread (expect basis to RISE back), -1 = short
  let entryBasis = 0;      // basis bps at entry
  let entrySpreadCost = 0; // round-trip cost charged at entry (bps), full cost booked here
  let holdBars = 0;

  // cost in *return units* per leg-roundtrip event: 2 legs each paying legCost on open AND close,
  // plus slippage per leg per side. We book the FULL round-trip cost at entry so per-trade net is
  // entry-vs-exit basis move minus the all-in cost.
  const fullRoundTripBps = 2 /*legs*/ * 2 /*open+close*/ * (p.legCostBps + p.slipBps);

  for (let i = 0; i < n; i++) {
    const b = basisBps(rows[i].binance, rows[i].coinbase); // signed (coinbase - binance)/binance bps
    const baselinePrev = baseline; // through i-1
    const dev = Number.isFinite(baselinePrev) ? b - baselinePrev : 0;

    // ----- realize P&L over bar i -> i+1 for an OPEN position (no lookahead: position decided at <= i) -----
    if (i < n - 1 && pos !== 0) {
      const bNext = basisBps(rows[i + 1].binance, rows[i + 1].coinbase);
      // spread convergence return captured this bar: if we are LONG the spread (pos=+1, basis was
      // CHEAP, expect it to rise), we profit when basis rises. delta in bps -> return units (/1e4).
      const deltaBps = bNext - b;
      perBarNet[i] += pos * (deltaBps / 1e4);
      holdBars++;

      // ----- EXIT decision evaluated at bar i (acts on i -> i+1 already realized above is the held bar;
      // we decide to CLOSE based on info <= i, effective next bar) -----
      const reverted = Math.abs(b - baselinePrev) <= p.exitBps; // dev collapsed back inside exit band
      const expired = holdBars >= p.maxHold;
      if (reverted || expired) {
        // book the full round-trip cost now (entry+exit, both legs)
        perBarNet[i] -= fullRoundTripBps / 1e4;
        const tradeMoveBps = pos * (b - entryBasis); // realized convergence from entry to here (bps)
        perTradeNetBps.push(tradeMoveBps - fullRoundTripBps);
        pos = 0; holdBars = 0; entryBasis = 0;
      }
    }

    // ----- ENTRY decision at bar i (uses baselinePrev = through i-1, basis at i) -> position held i+1 onward -----
    if (pos === 0 && Number.isFinite(baselinePrev) && Math.abs(dev) > p.entryBps) {
      // basis RICH (dev>0): coinbase too expensive vs leader+baseline -> expect basis to FALL -> SHORT the spread (pos=-1)
      // basis CHEAP (dev<0): expect basis to RISE -> LONG the spread (pos=+1)
      pos = dev > 0 ? -1 : 1;
      entryBasis = b;
      entrySpreadCost = fullRoundTripBps;
      holdBars = 0;
    }

    // ----- update baseline AFTER using its prior value (so it's causal) -----
    baseline = ewma(baseline, b, p.alpha);
  }

  // force-close any open position at the end (book cost, realize whatever convergence happened)
  if (pos !== 0 && n >= 1) {
    const bLast = basisBps(rows[n - 1].binance, rows[n - 1].coinbase);
    const tradeMoveBps = pos * (bLast - entryBasis);
    perTradeNetBps.push(tradeMoveBps - fullRoundTripBps);
    if (perBarNet.length) perBarNet[perBarNet.length - 1] -= fullRoundTripBps / 1e4;
  }

  const spanDays = n > 1 ? (rows[n - 1].t - rows[0].t) / 86400 : 0;
  return { perBarNet, perTradeNetBps, trades: perTradeNetBps.length, bars: n, spanDays };
}

// ---------------- positions array for PBO/shuffle (per-bar signed position, no-lookahead) ----------------
function positionSeries(rows: Row[], p: Params): number[] {
  const n = rows.length;
  const pos = new Array(n).fill(0);
  let baseline = NaN, cur = 0, hold = 0;
  for (let i = 0; i < n; i++) {
    const b = basisBps(rows[i].binance, rows[i].coinbase);
    const baselinePrev = baseline;
    const dev = Number.isFinite(baselinePrev) ? b - baselinePrev : 0;
    if (cur !== 0) {
      hold++;
      if (Math.abs(b - baselinePrev) <= p.exitBps || hold >= p.maxHold) { cur = 0; hold = 0; }
    }
    if (cur === 0 && Number.isFinite(baselinePrev) && Math.abs(dev) > p.entryBps) { cur = dev > 0 ? -1 : 1; hold = 0; }
    pos[i] = cur;
    baseline = ewma(baseline, b, p.alpha);
  }
  return pos;
}

// ---------------- MAIN ----------------
const DAYS = Number(process.env.DAYS ?? 8);
console.log(`\n=== CROSS-EXCHANGE BASIS DISLOCATION REVERSION (Coinbase vs Binance, BTC, 1m) ===`);
console.log(`Fetching ~${DAYS} days of minute bars (Binance proxy + Coinbase public)...`);

const [bin, cb] = await Promise.all([
  fetchBinanceMinutes("BTCUSDT", DAYS),
  fetchCoinbaseMinutes("BTC-USD", DAYS),
]);
const binSpan = bin.length ? ((bin[bin.length - 1].start_unix - bin[0].start_unix) / 86400).toFixed(2) : "0";
const cbSpan = cb.length ? ((cb[cb.length - 1].start_unix - cb[0].start_unix) / 86400).toFixed(2) : "0";
console.log(`  Binance:  ${bin.length} bars, span ${binSpan} days`);
console.log(`  Coinbase: ${cb.length} bars, span ${cbSpan} days`);

const rows = align(bin, cb);
const span = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 86400 : 0;
console.log(`  ALIGNED:  ${rows.length} overlapping minute bars, span ${span.toFixed(2)} days`);

if (rows.length < 1000) {
  console.log(`\nDATA INSUFFICIENT: only ${rows.length} aligned bars (<1000). Cannot validate an intraday edge.`);
  process.exit(0);
}

// describe the structural basis
const allBasis = rows.map((r) => basisBps(r.binance, r.coinbase));
const meanBasis = allBasis.reduce((s, x) => s + x, 0) / allBasis.length;
const sdBasis = Math.sqrt(allBasis.reduce((s, x) => s + (x - meanBasis) ** 2, 0) / (allBasis.length - 1));
console.log(`  Structural basis (coinbase-binance): mean ${meanBasis.toFixed(2)} bps, sd ${sdBasis.toFixed(2)} bps`);

// ---------------- PARAMETER GRID (report the best, then stress it) ----------------
const COST = { legCostBps: 5, slipBps: 1 }; // 5bps taker/side/leg + 1bp slippage/side/leg
const alphas = [0.02, 0.05, 0.1];
const entries = [3, 5, 8, 12];
const exits = [0, 1, 2];
const holds = [5, 15, 30];

type Trial = { p: Params; bt: Bt; perBarSharpeAnn: number; perBarSharpe: number; label: string };
const trials: Trial[] = [];
for (const alpha of alphas) for (const entryBps of entries) for (const exitBps of exits) for (const maxHold of holds) {
  if (exitBps >= entryBps) continue;
  const p: Params = { alpha, entryBps, exitBps, maxHold, ...COST };
  const bt = backtest(rows, p);
  if (bt.trades < 5) continue;
  const s = sharpe(bt.perBarNet);
  trials.push({ p, bt, perBarSharpe: s, perBarSharpeAnn: s * ANN, label: `a${alpha}_e${entryBps}_x${exitBps}_h${maxHold}` });
}

if (trials.length === 0) {
  console.log(`\nNO TRADES fire across the grid at realistic cost — the deviation never exceeds the band enough to trade.`);
  process.exit(0);
}

trials.sort((a, b) => b.perBarSharpe - a.perBarSharpe);
const best = trials[0];
const trialSharpes = trials.map((t) => t.perBarSharpe);

console.log(`\n--- GRID: ${trials.length} configs with >=5 trades ---`);
console.log(`Top 5 by per-bar net Sharpe:`);
for (const t of trials.slice(0, 5)) {
  const tpd = t.bt.trades / Math.max(t.bt.spanDays, 1e-9);
  const avgBps = t.bt.perTradeNetBps.reduce((s, x) => s + x, 0) / Math.max(t.bt.perTradeNetBps.length, 1);
  console.log(`  ${t.label.padEnd(22)} trades=${String(t.bt.trades).padStart(4)} tpd=${tpd.toFixed(1).padStart(6)} avgNetBps=${avgBps.toFixed(2).padStart(7)} SharpeAnn=${t.perBarSharpeAnn.toFixed(2).padStart(7)}`);
}

// ---------------- GAUNTLET on the BEST config ----------------
const bt = best.bt;
const tpd = bt.trades / Math.max(bt.spanDays, 1e-9);
const avgNetBps = bt.perTradeNetBps.reduce((s, x) => s + x, 0) / Math.max(bt.perTradeNetBps.length, 1);
const winRate = bt.perTradeNetBps.filter((x) => x > 0).length / Math.max(bt.perTradeNetBps.length, 1);
const cumNet = bt.perBarNet.reduce((s, x) => s + x, 0);
const netSharpeAnn = best.perBarSharpeAnn;

console.log(`\n=== BEST CONFIG: ${best.label} ===`);
console.log(`  trades=${bt.trades}  trades/day=${tpd.toFixed(2)}  span=${bt.spanDays.toFixed(2)}d`);
console.log(`  avg NET per-trade = ${avgNetBps.toFixed(2)} bps   win rate = ${(winRate * 100).toFixed(1)}%`);
console.log(`  cum net return = ${(cumNet * 100).toFixed(3)}%   per-bar net Sharpe = ${best.perBarSharpe.toFixed(4)}   ANNUALIZED = ${netSharpeAnn.toFixed(2)}`);
console.log(`  COST charged: ${2 * 2 * (COST.legCostBps + COST.slipBps)} bps round-trip ALL-IN (2 legs x 2 sides x ${COST.legCostBps + COST.slipBps}bps)`);

// DSR (deflate the best per-bar Sharpe for the N trials we scanned)
const dsrRes = deflatedSharpe(bt.perBarNet, trialSharpes);
console.log(`  Deflated Sharpe: SR(per-bar)=${dsrRes.sr.toFixed(4)} SR0=${dsrRes.sr0.toFixed(4)} DSR=${dsrRes.dsr.toFixed(4)}`);

// PBO across the grid's position series
const posSeries = trials.map((t) => positionSeries(rows, t.p));
const M: number[][] = [];
for (let i = 0; i < rows.length - 1; i++) {
  const rowRet: number[] = [];
  for (let c = 0; c < trials.length; c++) {
    const pos = posSeries[c][i];
    const prev = i > 0 ? posSeries[c][i - 1] : 0;
    const b = basisBps(rows[i].binance, rows[i].coinbase);
    const bNext = basisBps(rows[i + 1].binance, rows[i + 1].coinbase);
    const gross = pos * ((bNext - b) / 1e4);
    const cost = Math.abs(pos - prev) * (2 * (COST.legCostBps + COST.slipBps) / 1e4); // per turn, both legs one side
    rowRet.push(gross - cost);
  }
  M.push(rowRet);
}
const pboVal = trials.length >= 2 ? pbo(M, 8) : 1;
console.log(`  PBO (across ${trials.length} configs) = ${pboVal.toFixed(3)}`);

// ---------------- BLOCK-SHUFFLE PERMUTATION CONTROL (the decisive intraday test) ----------------
// Shuffle the bar ORDER in blocks (destroys the longer-horizon basis mean-reversion structure while
// preserving short-run autocorrelation + the return distribution). If the strategy's Sharpe survives
// on shuffled data, the "edge" was a static artifact, not real temporal mean-reversion.
const observed = best.perBarSharpe;
const nullStats: number[] = [];
const NPERM = 300;
const blockSize = Math.max(best.p.maxHold * 2, 20);
for (let s = 0; s < NPERM; s++) {
  const rng = lcgRng(1234 + s * 7);
  const perm = blockShufflePermutation(rows.length, blockSize, rng);
  const shuffled = applyPermutation(rows, perm).map((r) => ({ ...r }));
  // re-fix timestamps to be monotonic so span/logic is sane (order is what matters for the signal)
  for (let i = 0; i < shuffled.length; i++) shuffled[i].t = rows[0].t + i * 60;
  const sbt = backtest(shuffled, best.p);
  nullStats.push(sharpe(sbt.perBarNet));
}
const perm = permutationTest(observed, nullStats, "greater");
const nullMean = nullStats.reduce((s, x) => s + x, 0) / nullStats.length;
console.log(`\n--- BLOCK-SHUFFLE PERMUTATION CONTROL (${NPERM} perms, blockSize=${blockSize}) ---`);
console.log(`  observed per-bar Sharpe = ${observed.toFixed(4)}   null mean = ${nullMean.toFixed(4)}   p-value = ${perm.pValue.toFixed(4)}`);

// ---------------- ADVISOR ----------------
const betaRets = rows.slice(0, -1).map((r, i) => rows[i + 1].binance / r.binance - 1); // buy-and-hold BTC per bar
const betaSharpe = sharpe(betaRets) * ANN;
const memo = adviseTrade({
  label: "xexch-basis-reversion",
  benchmarkReturns: betaRets,
  strategyReturns: bt.perBarNet,
  pbo: pboVal,
  dsr: dsrRes.dsr,
  search: { hypothesesScanned: trials.length, bonferroniSurvivors: perm.pValue < 0.05 / trials.length ? 1 : 0 },
  data: { crossVenueVerdict: "agree" },
} as any);
console.log(`\n${renderTradeMemo(memo)}`);

// ---------------- VERDICT ----------------
const netsPositive = avgNetBps > 0 && cumNet > 0;
const survivesShuffle = perm.pValue < 0.05;
const firesEnough = tpd >= 1; // at least ~1 trade/day to matter
let verdict: "yes" | "maybe" | "no";
if (netsPositive && survivesShuffle && firesEnough && netSharpeAnn > 1) verdict = "yes";
else if (netsPositive && (survivesShuffle || netSharpeAnn > 0.5) && bt.trades >= 10) verdict = "maybe";
else verdict = "no";

console.log(`\n=== VERDICT: ${verdict.toUpperCase()} ===`);
console.log(`  nets positive after cost: ${netsPositive} (avgNetBps=${avgNetBps.toFixed(2)}, cumNet=${(cumNet * 100).toFixed(3)}%)`);
console.log(`  survives shuffle (p<0.05): ${survivesShuffle} (p=${perm.pValue.toFixed(4)})`);
console.log(`  fires enough (>=1 tpd): ${firesEnough} (tpd=${tpd.toFixed(2)})`);
console.log(`  net Sharpe (annualized): ${netSharpeAnn.toFixed(2)}   beta(BTC) Sharpe ann: ${betaSharpe.toFixed(2)}`);

// machine-readable summary line
console.log(`\nRESULT_JSON ${JSON.stringify({
  dataAvailable: true,
  alignedBars: rows.length,
  spanDays: Number(span.toFixed(2)),
  meanBasisBps: Number(meanBasis.toFixed(2)),
  bestConfig: best.label,
  netSharpeAnn: Number(netSharpeAnn.toFixed(3)),
  avgNetPerTradeBps: Number(avgNetBps.toFixed(3)),
  tradesPerDay: Number(tpd.toFixed(2)),
  trades: bt.trades,
  winRate: Number(winRate.toFixed(3)),
  pbo: Number(pboVal.toFixed(3)),
  dsr: Number(dsrRes.dsr.toFixed(3)),
  shufflePvalue: Number(perm.pValue.toFixed(4)),
  advisorVerdict: memo.recommendation,
  verdict,
})}`);
