/**
 * _intraday-momentum-ignition-breakout — INTRADAY MOMENTUM-IGNITION / BREAKOUT CONTINUATION.
 *
 * HYPOTHESIS: a clean range breakout on a volume surge CONTINUES intraday (trend ignition).
 * On 1m bars: signal at bar i = close breaks the trailing N-min high (long) or low (short) AND
 * the bar's volume > the p-th percentile of a trailing volume window. Enter in the breakout
 * direction, hold for a fixed horizon H bars (with the position realized bar-by-bar i->i+1, so
 * NO-LOOKAHEAD), charge a REALISTIC round-trip taker cost on every entry/exit.
 *
 * Daily momentum was BETA in this repo's prior work — this asks whether the INTRADAY breakout has
 * ANYTHING net of cost. Intraday "edges" usually die on (a) fees (you trade often) or (b) the
 * SHUFFLE control (block-shuffle the bar order: a real continuation edge needs the time-ordering;
 * a fee-illusion / spurious autocorrelation often survives only in-sample order).
 *
 * METHOD (NO-LOOKAHEAD; signal[i] from data <= i; return realized i->i+1):
 *   (1) Paginate Binance 1m klines via the data proxy to ~14-21 days (BTCUSDT + ETHUSDT).
 *   (2) Build a flat-or-directional position series: on a qualifying breakout at bar i, hold
 *       sign(breakout) for the next H bars (or until an opposite breakout flips it). Position is
 *       known at close of i, earns the i->i+1 return.
 *   (3) Net per-bar return = pos[i]*(c[i+1]/c[i]-1) - |pos[i]-pos[i-1]| * roundTripCost.
 *       Round-trip taker = 2*(takerBps + slipBps)/1e4 charged on every change in position size.
 *   (4) GAUNTLET: annualized Sharpe (sqrt(365*1440)); per-trade bps; trades/day; pbo over a small
 *       param grid; deflatedSharpe(best, trialSharpes); a BLOCK-SHUFFLE permutation control
 *       (shuffle bar blocks, recompute the SAME strategy, p = P[null Sharpe >= observed]); adviseTrade
 *       vs the asset's own buy-and-hold beta.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_intraday-momentum-ignition-breakout.ts
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { blockShufflePermutation, applyPermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade } from "../src/lib/backtest/advisor.ts";

// ---------- types ----------
type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

const BARS_PER_YEAR = 365 * 1440; // minute bars
const ANN = Math.sqrt(BARS_PER_YEAR);

// ---------- data: paginate Binance 1m klines via proxy ----------
async function fetchKlinesPaged(symbol: string, days: number): Promise<Bar[]> {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const out: Bar[] = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard < 200) {
    guard++;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000&startTime=${cursor}`;
    let rows: any[];
    try {
      const r = await proxiedFetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { console.error(`[${symbol}] HTTP ${r.status}`); break; }
      rows = (await r.json()) as any[];
    } catch (e) {
      console.error(`[${symbol}] fetch err ${(e as Error).message}`); break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) {
      out.push({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (lastOpen <= cursor) break; // no progress
    cursor = lastOpen + 60_000; // next minute
    if (rows.length < 1000) {
      // caught up to ~now; one more page may add the tail but Binance returns up to now, so break if we are within a page of now
      if (cursor >= endMs - 60_000) break;
    }
  }
  // dedup + sort by open time, drop the in-progress final bar
  const byT = new Map<number, Bar>();
  for (const b of out) byT.set(b.t, b);
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  return sorted.filter((b) => b.t < nowMin && Number.isFinite(b.c) && b.c > 0);
}

// ---------- signal: breakout + volume surge, NO-LOOKAHEAD ----------
type Params = { N: number; volPct: number; H: number };

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Build position series for a breakout-continuation strategy on one asset.
 * pos[i] is decided at CLOSE of bar i using ONLY bars <= i. It earns return i->i+1.
 * - long if c[i] > max(high[i-N .. i-1]) AND v[i] > p-th pct of v[i-volWin .. i-1]
 * - short if c[i] < min(low[i-N .. i-1])  AND v[i] > same vol gate
 * - once entered, hold for H bars (carry the sign) unless a fresh opposite breakout flips it
 */
function buildPositions(bars: Bar[], p: Params): number[] {
  const n = bars.length;
  const volWin = 60; // trailing 60-min volume distribution
  const pos = new Array<number>(n).fill(0);
  let holdLeft = 0;
  let curSign = 0;
  for (let i = 0; i < n; i++) {
    // need lookback for both the high/low channel and the vol window (all strictly < i)
    const need = Math.max(p.N, volWin);
    if (i < need) { pos[i] = 0; continue; }
    // trailing channel from bars [i-N, i-1]
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p.N; j <= i - 1; j++) { if (bars[j].h > hh) hh = bars[j].h; if (bars[j].l < ll) ll = bars[j].l; }
    // trailing volume distribution from [i-volWin, i-1]
    const vols: number[] = [];
    for (let j = i - volWin; j <= i - 1; j++) vols.push(bars[j].v);
    vols.sort((a, b) => a - b);
    const volGate = percentile(vols, p.volPct);
    const c = bars[i].c, v = bars[i].v;

    let fresh = 0;
    if (c > hh && v > volGate) fresh = +1;
    else if (c < ll && v > volGate) fresh = -1;

    if (fresh !== 0) {
      curSign = fresh;
      holdLeft = p.H;
    }
    if (holdLeft > 0) {
      pos[i] = curSign;
      holdLeft--;
    } else {
      pos[i] = 0;
      curSign = 0;
    }
  }
  return pos;
}

// ---------- net per-bar returns with realistic round-trip cost ----------
function netReturns(bars: Bar[], pos: number[], roundTripBps: number): { rets: number[]; turnovers: number } {
  const rt = roundTripBps / 1e4; // cost per UNIT change in |position| (1.0 long = full round trip on close)
  const rets: number[] = [];
  let turnovers = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const cur = pos[i] ?? 0;
    const prev = i > 0 ? (pos[i - 1] ?? 0) : 0;
    const dPos = Math.abs(cur - prev);
    turnovers += dPos;
    const gross = cur * (bars[i + 1].c / bars[i].c - 1);
    // a full entry (0->1) then full exit (1->0) over the life of a trade = 2 * |dPos|=1 events,
    // each charged half the round trip -> total = roundTrip. So charge (rt/2) per unit |dPos|.
    const cost = dPos * (rt / 2);
    rets.push(gross - cost);
  }
  return { rets, turnovers };
}

// gross (zero-fee) for the fee-illusion diagnostic
function grossReturns(bars: Bar[], pos: number[]): number[] {
  const rets: number[] = [];
  for (let i = 0; i < bars.length - 1; i++) rets.push((pos[i] ?? 0) * (bars[i + 1].c / bars[i].c - 1));
  return rets;
}

function buyHold(bars: Bar[]): number[] {
  const rets: number[] = [];
  for (let i = 0; i < bars.length - 1; i++) rets.push(bars[i + 1].c / bars[i].c - 1);
  return rets;
}

function countTrades(pos: number[]): number {
  // a "trade" = an entry event (0 or opposite -> nonzero new direction)
  let trades = 0;
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] !== 0 && pos[i] !== pos[i - 1]) trades++;
  }
  return trades;
}

const fmt = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "NaN");
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const cum = (a: number[]) => a.reduce((e, x) => e * (1 + x), 1) - 1;

// ---------- main ----------
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const DAYS = 21;
// realistic taker cost: 5 bps/side + ~2 bps slippage/side -> ~14 bps round trip on a major
const TAKER_BPS_SIDE = 5;
const SLIP_BPS_SIDE = 2;
const ROUND_TRIP_BPS = 2 * (TAKER_BPS_SIDE + SLIP_BPS_SIDE); // 14 bps

console.log(`=== INTRADAY MOMENTUM-IGNITION / BREAKOUT CONTINUATION ===`);
console.log(`cost model: ${TAKER_BPS_SIDE}bps taker + ${SLIP_BPS_SIDE}bps slip per side => ${ROUND_TRIP_BPS}bps round trip\n`);

const dataBySym: Record<string, Bar[]> = {};
for (const sym of SYMBOLS) {
  const bars = await fetchKlinesPaged(sym, DAYS);
  dataBySym[sym] = bars;
  if (bars.length) {
    const spanH = (bars[bars.length - 1].t - bars[0].t) / 3.6e6;
    console.log(`[${sym}] ${bars.length} bars, ${(spanH / 24).toFixed(1)} days  (${new Date(bars[0].t).toISOString()} -> ${new Date(bars[bars.length - 1].t).toISOString()})`);
  } else {
    console.log(`[${sym}] NO DATA`);
  }
}
console.log("");

// param grid (kept small; PBO/DSR penalize breadth)
const GRID: Params[] = [];
for (const N of [15, 30, 60]) for (const volPct of [80, 90]) for (const H of [10, 30]) GRID.push({ N, volPct, H });

type Trial = { sym: string; p: Params; netSharpeAnn: number; netRets: number[]; pos: number[]; perTradeBps: number; tradesPerDay: number; grossSharpeAnn: number; nTrades: number };

const trials: Trial[] = [];
const perSymBest: Record<string, Trial | null> = {};

for (const sym of SYMBOLS) {
  const bars = dataBySym[sym];
  if (bars.length < 2000) { perSymBest[sym] = null; continue; }
  const days = (bars[bars.length - 1].t - bars[0].t) / 8.64e7;
  let best: Trial | null = null;
  for (const p of GRID) {
    const pos = buildPositions(bars, p);
    const { rets } = netReturns(bars, pos, ROUND_TRIP_BPS);
    const gRets = grossReturns(bars, pos);
    const nTrades = countTrades(pos);
    const netSh = sharpe(rets) * ANN;
    const grSh = sharpe(gRets) * ANN;
    // per-trade bps = total net return / number of round-trip trades, in bps
    const perTradeBps = nTrades > 0 ? (sum(rets) / nTrades) * 1e4 : 0;
    const tradesPerDay = nTrades / days;
    const t: Trial = { sym, p, netSharpeAnn: netSh, netRets: rets, pos, perTradeBps, tradesPerDay, grossSharpeAnn: grSh, nTrades };
    trials.push(t);
    if (!best || t.netSharpeAnn > best.netSharpeAnn) best = t;
  }
  perSymBest[sym] = best;
  console.log(`--- ${sym} (${days.toFixed(1)}d) grid results (best-by-net-Sharpe) ---`);
  for (const t of trials.filter((x) => x.sym === sym).sort((a, b) => b.netSharpeAnn - a.netSharpeAnn).slice(0, 4)) {
    console.log(`  N=${t.p.N} volP=${t.p.volPct} H=${t.p.H}  netSh=${fmt(t.netSharpeAnn, 2)} grossSh=${fmt(t.grossSharpeAnn, 2)}  trades=${t.nTrades} (${fmt(t.tradesPerDay, 1)}/d) perTrade=${fmt(t.perTradeBps, 2)}bps  netCum=${fmt(cum(t.netRets) * 100, 2)}%`);
  }
  console.log("");
}

// ---------- pick the single best trial across assets for the gauntlet ----------
const allBest = trials.slice().sort((a, b) => b.netSharpeAnn - a.netSharpeAnn)[0];
if (!allBest) { console.log("No trials. Abort."); process.exit(1); }
const bars = dataBySym[allBest.sym];
const days = (bars[bars.length - 1].t - bars[0].t) / 8.64e7;

console.log(`=== GAUNTLET on best trial: ${allBest.sym} N=${allBest.p.N} volP=${allBest.p.volPct} H=${allBest.p.H} ===`);
console.log(`net Sharpe (ann) = ${fmt(allBest.netSharpeAnn, 3)}   gross Sharpe (ann) = ${fmt(allBest.grossSharpeAnn, 3)}`);
console.log(`trades = ${allBest.nTrades}  (${fmt(allBest.tradesPerDay, 2)}/day)   per-trade net = ${fmt(allBest.perTradeBps, 2)} bps`);
console.log(`net cum = ${fmt(cum(allBest.netRets) * 100, 2)}%   over ${fmt(days, 1)} days\n`);

// PBO over the grid for this asset (matrix bars x configs, aligned)
const symTrials = trials.filter((t) => t.sym === allBest.sym);
const minLen = Math.min(...symTrials.map((t) => t.netRets.length));
const M: number[][] = [];
for (let i = 0; i < minLen; i++) M.push(symTrials.map((t) => t.netRets[i]));
const pboVal = pbo(M, 8);

// Deflated Sharpe: best net returns vs the per-period sharpes of all trials (this asset)
const trialSharpesPerPeriod = symTrials.map((t) => sharpe(t.netRets));
const dsr = deflatedSharpe(allBest.netRets, trialSharpesPerPeriod);

console.log(`PBO (grid, 8 blocks) = ${fmt(pboVal, 3)}   (want < 0.30)`);
console.log(`Deflated Sharpe: sr(per-bar)=${fmt(dsr.sr, 5)} sr0=${fmt(dsr.sr0, 5)} DSR=${fmt(dsr.dsr, 3)}   (want > 0.95)\n`);

// ---------- BLOCK-SHUFFLE permutation control (the decisive intraday test) ----------
// Null: shuffle bar BLOCKS (preserves local autocorrelation within a block, destroys the
// cross-block ordering the continuation edge relies on). Recompute the SAME strategy on the
// shuffled bars, take its net annualized Sharpe. p = P[null Sharpe >= observed].
const NPERM = 400;
const blockSize = 60; // 1-hour blocks
const rng = lcgRng(12345);
const nullSharpes: number[] = [];
for (let k = 0; k < NPERM; k++) {
  const perm = blockShufflePermutation(bars.length, blockSize, rng);
  const shuffled = applyPermutation(bars, perm);
  // reindex t so channel/vol windows operate on the shuffled order (we only use relative order)
  const pos = buildPositions(shuffled, allBest.p);
  const { rets } = netReturns(shuffled, pos, ROUND_TRIP_BPS);
  nullSharpes.push(sharpe(rets) * ANN);
}
const permRes = permutationTest(allBest.netSharpeAnn, nullSharpes, "greater");
const nullMean = sum(nullSharpes) / nullSharpes.length;
console.log(`BLOCK-SHUFFLE control: ${NPERM} perms, ${blockSize}-bar blocks`);
console.log(`  observed netSharpe=${fmt(allBest.netSharpeAnn, 3)}  null mean=${fmt(nullMean, 3)}  p-value=${fmt(permRes.pValue, 4)}  (want < 0.05)\n`);

// ---------- advisor vs the asset's own buy-and-hold beta ----------
const bh = buyHold(bars).slice(0, allBest.netRets.length);
const memo = adviseTrade({
  label: `intraday-breakout-${allBest.sym}-N${allBest.p.N}-v${allBest.p.volPct}-H${allBest.p.H}`,
  strategyReturns: allBest.netRets,
  benchmarkReturns: bh,
  pbo: pboVal,
  dsr: dsr.dsr,
  oosFrac: 0.3,
}, { minBars: 250, pboClean: 0.3, dsrClean: 0.95, artifactTopBars: 5, artifactShare: 0.5 });

console.log(`=== ADVISOR ===`);
console.log(`recommendation: ${memo.recommendation}  (conviction ${memo.conviction})`);
console.log(`roiVerdict: ${memo.advice.roiVerdict}`);
console.log(`strategy Sharpe(ann)=${fmt(memo.advice.metrics.strategySharpe, 2)} beta Sharpe(ann)=${fmt(memo.advice.metrics.betaSharpe, 2)} alphaOos=${fmt(memo.advice.metrics.alphaSharpeOos, 2)}`);
console.log(`voice: ${memo.voice}\n`);

// ---------- honest verdict ----------
const positiveNet = allBest.perTradeBps > 0 && allBest.netSharpeAnn > 0;
const survivesShuffle = permRes.pValue < 0.05;
const firesEnough = allBest.tradesPerDay >= 1;
let verdict: "REAL" | "MAYBE" | "NO";
if (positiveNet && survivesShuffle && firesEnough && allBest.netSharpeAnn > 1.0) verdict = "REAL";
else if (positiveNet && (survivesShuffle || allBest.netSharpeAnn > 0.5)) verdict = "MAYBE";
else verdict = "NO";

console.log(`=== VERDICT: ${verdict} ===`);
console.log(`positiveNetAfterCost=${positiveNet} survivesShuffle=${survivesShuffle} firesEnough(>=1/d)=${firesEnough}`);
console.log(JSON.stringify({
  bestSym: allBest.sym, params: allBest.p,
  netSharpeAnn: +fmt(allBest.netSharpeAnn, 3), grossSharpeAnn: +fmt(allBest.grossSharpeAnn, 3),
  perTradeBps: +fmt(allBest.perTradeBps, 2), tradesPerDay: +fmt(allBest.tradesPerDay, 2),
  pbo: +fmt(pboVal, 3), dsr: +fmt(dsr.dsr, 3), shufflePvalue: +fmt(permRes.pValue, 4),
  advisor: memo.recommendation, verdict, days: +fmt(days, 1), bars: bars.length,
}, null, 2));
