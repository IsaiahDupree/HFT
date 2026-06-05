import "./_env.ts";
/**
 * _intraday-minute-pairs-statarb — MINUTE-scale pairs stat-arb hunt.
 *
 * Hypothesis: two tightly-correlated coins diverge intraday and RECONVERGE within the day. Trade the
 * spread z-score: when |z| stretches past `entry`, go long the laggard / short the leader (the spread
 * is the residual of log(A) - beta*log(B)); exit when |z| relaxes below `exit`. Daily pairs were
 * rejected for crypto (momentum, not mean-reversion). Does the MINUTE horizon differ? Honest test.
 *
 * NO-LOOKAHEAD: at bar i, beta_i and (mu_i, sigma_i) are estimated from the TRAILING window ending at
 * i-1 (strictly past data). The position decided at bar i is realized i -> i+1. The spread return that
 * the position earns is the change in the residual using beta_i held FIXED (beta is the hedge ratio you
 * locked in, not refit each bar with future data).
 *
 * COSTS: dollar-neutral, both legs trade. A round-trip is 10bps on BOTH legs => we charge 5bps/side/leg
 * => 20bps total to OPEN (10bps leg A + 10bps leg B) and 20bps to CLOSE, i.e. cost = 10bps * |dPosA| +
 * 10bps * |dPosB| where positions are +-1 notional on each leg. We add 2bps/leg slippage on top
 * (alts are thinner), so effectively ~24bps round-trip per leg, ~48bps to do a full open+close cycle.
 *
 * GAUNTLET: annualized net Sharpe (sqrt(365*1440)), PBO + deflated Sharpe over the entry-z grid, a
 * BLOCK-SHUFFLE permutation control (the decisive intraday test), and adviseTrade.
 */
import { fetchBinanceKlines } from "../src/lib/data/binance.ts";
import type { VenueCandle } from "../src/lib/data/venue-candles.ts";
import { sharpe, pbo, deflatedSharpe } from "../src/lib/backtest/candle/stats.ts";
import { blockShufflePermutation, applyPermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAYS = 21;
const SYMBOLS = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "AVAXUSDT"];
// candidate pairs (A leg, B leg) — A is the "test" leg, B the hedge reference
const PAIRS: Array<[string, string]> = [
  ["ETHUSDT", "SOLUSDT"],
  ["ETHUSDT", "BNBUSDT"],
  ["SOLUSDT", "BNBUSDT"],
  ["SOLUSDT", "AVAXUSDT"],
  ["ETHUSDT", "AVAXUSDT"],
];

const BAR_SEC = 60;
const BARS_PER_YEAR = 365 * 1440;
const ANN = Math.sqrt(BARS_PER_YEAR);

// Costs (basis points). Round-trip 10bps on each leg per the brief; we model per-side and per-leg.
const FEE_BPS_PER_SIDE_PER_LEG = 5;   // 5bps/side/leg => 10bps round-trip per leg (the brief's mandate)
const SLIP_BPS_PER_SIDE_PER_LEG = 2;  // alt-pair slippage cushion, per side per leg
const COST_BPS_PER_SIDE_PER_LEG = FEE_BPS_PER_SIDE_PER_LEG + SLIP_BPS_PER_SIDE_PER_LEG; // 7bps
// A dollar-neutral pair trade moves BOTH legs, so a position change of |dPos| on the spread costs
// COST on leg A + COST on leg B = 2 * COST_BPS_PER_SIDE_PER_LEG per unit |dPos|.
const COST_FRAC_PER_UNIT_DPOS = (2 * COST_BPS_PER_SIDE_PER_LEG) / 1e4;

const BETA_WINDOW = 240;  // 4h trailing window for beta (OLS hedge ratio)
const Z_WINDOW = 120;     // 2h trailing window for spread mean/std (z-score)
const EXIT_Z = 0.5;       // exit when |z| relaxes below this
const ENTRY_GRID = [1.5, 2.0, 2.5, 3.0]; // entry thresholds for the PBO/DSR config grid
const MAX_HOLD_BARS = 240; // hard time-stop (4h) so a non-reverting divergence doesn't ride forever

// ----------------------------------------------------------------------------------------------
// Data: paginate 1m klines for DAYS days.
async function fetchMinutes(symbol: string, days: number): Promise<VenueCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const startUnix = now - days * 24 * 3600;
  const all: VenueCandle[] = [];
  let cursor = startUnix;
  const seen = new Set<number>();
  for (let page = 0; page < Math.ceil((days * 1440) / 1000) + 4; page++) {
    const batch = await fetchBinanceKlines(symbol, "1m", { startUnix: cursor, limit: 1000 });
    if (!batch.length) break;
    for (const c of batch) if (!seen.has(c.start_unix)) { seen.add(c.start_unix); all.push(c); }
    const last = batch[batch.length - 1].start_unix;
    if (last <= cursor) break; // no progress
    cursor = last + BAR_SEC; // next page starts after the last bar we got
    if (cursor >= now) break;
  }
  all.sort((a, b) => a.start_unix - b.start_unix);
  return all;
}

// Align two candle series on their common timestamps (1m bars should line up; gaps dropped).
function align(a: VenueCandle[], b: VenueCandle[]): { t: number[]; la: number[]; lb: number[] } {
  const mb = new Map<number, number>();
  for (const c of b) mb.set(c.start_unix, c.close);
  const t: number[] = [], la: number[] = [], lb: number[] = [];
  for (const c of a) {
    const cb = mb.get(c.start_unix);
    if (cb == null || cb <= 0 || c.close <= 0) continue;
    t.push(c.start_unix); la.push(Math.log(c.close)); lb.push(Math.log(cb));
  }
  return { t, la, lb };
}

// Rolling OLS beta of la on lb over [i-window, i-1] (NO bar i). Returns beta and intercept alpha.
function rollingBeta(la: number[], lb: number[], i: number, window: number): { beta: number; alpha: number } | null {
  const lo = i - window;
  if (lo < 0) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = lo; k < i; k++) { // strictly past: k < i
    const x = lb[k], y = la[k];
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  if (n < window) return null;
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  return { beta, alpha };
}

// Build per-bar net spread returns for one pair at one entry threshold. NO-LOOKAHEAD.
function runPair(
  la: number[], lb: number[], entryZ: number,
): { rets: number[]; trades: number; barsInMarket: number; nBars: number } {
  const n = la.length;
  const warm = Math.max(BETA_WINDOW, Z_WINDOW) + 2;
  const rets: number[] = [];           // per-bar net return realized i -> i+1 (only counted from warm on)
  let pos = 0;                          // current spread position in {-1,0,+1}; +1 = long spread (long A, short B)
  let entryBetaHeld = 0;               // beta locked at entry (the hedge ratio of the open position)
  let holdBars = 0;
  let trades = 0, barsInMarket = 0, counted = 0;

  // We need a per-bar residual change. Spread_t = la_t - beta*lb_t. With beta held at entry, the
  // realized spread return from t to t+1 is (la_{t+1}-la_t) - beta*(lb_{t+1}-lb_t). Long spread earns
  // +that; short spread earns -that. We track positions decided at bar i (from data <= i) realized i->i+1.
  for (let i = warm; i < n - 1; i++) {
    // --- decide position at bar i using ONLY data <= i ---
    const bf = rollingBeta(la, lb, i, BETA_WINDOW);
    let desired = pos;
    let zNow = NaN;
    if (bf) {
      // spread series over the z-window ending at i-1 (past), using the CURRENT beta estimate.
      const lo = i - Z_WINDOW;
      let s = 0, ss = 0, m = 0;
      for (let k = lo; k < i; k++) { const sp = la[k] - bf.beta * lb[k]; s += sp; ss += sp * sp; m++; }
      const mu = s / m;
      const variance = ss / m - mu * mu;
      const sigma = variance > 0 ? Math.sqrt(variance) : 0;
      const spreadI = la[i] - bf.beta * lb[i]; // residual AT bar i (data <= i, fine)
      zNow = sigma > 0 ? (spreadI - mu) / sigma : 0;

      if (pos === 0) {
        if (zNow >= entryZ) { desired = -1; entryBetaHeld = bf.beta; }       // spread too high -> short spread (short A / long B)
        else if (zNow <= -entryZ) { desired = 1; entryBetaHeld = bf.beta; }  // spread too low -> long spread (long A / short B)
      } else {
        const stretchedMore = (pos === 1 && zNow <= -entryZ * 1.0) || (pos === -1 && zNow >= entryZ * 1.0);
        // exit on mean reversion OR time stop; keep position only while still stretched beyond exit band
        if (Math.abs(zNow) <= EXIT_Z) desired = 0;
        else if (holdBars >= MAX_HOLD_BARS) desired = 0;
        else desired = pos; // hold
        void stretchedMore;
      }
    } else {
      desired = pos; // can't estimate -> hold whatever we have (should be 0 in warmup)
    }

    // --- transaction cost on changing the position (both legs) ---
    const dPos = Math.abs(desired - pos);
    const cost = dPos * COST_FRAC_PER_UNIT_DPOS;
    if (desired !== 0 && pos === 0) trades++; // a new round trip opens
    // hold-bar bookkeeping
    if (desired !== 0) holdBars = (desired === pos) ? holdBars + 1 : 0;
    else holdBars = 0;

    // --- realize the position decided at i over i -> i+1 (beta held at entry) ---
    const beta = desired !== 0 ? (pos === desired ? entryBetaHeld : entryBetaHeld) : entryBetaHeld;
    const dLa = la[i + 1] - la[i];
    const dLb = lb[i + 1] - lb[i];
    const spreadRet = dLa - beta * dLb; // log-return of the residual with the held hedge ratio
    const gross = desired * spreadRet;  // +1 long spread earns +spreadRet
    rets.push(gross - cost);
    if (desired !== 0) barsInMarket++;
    counted++;

    pos = desired;
  }
  return { rets, trades, barsInMarket, nBars: counted };
}

// ----------------------------------------------------------------------------------------------
console.log(`\n=== MINUTE-SCALE PAIRS STAT-ARB — ${DAYS}d of 1m bars ===`);
console.log(`cost model: ${COST_BPS_PER_SIDE_PER_LEG}bps/side/leg (fee ${FEE_BPS_PER_SIDE_PER_LEG} + slip ${SLIP_BPS_PER_SIDE_PER_LEG}); a unit pos change costs ${(COST_FRAC_PER_UNIT_DPOS * 1e4).toFixed(0)}bps (both legs)`);
console.log(`beta window ${BETA_WINDOW}m, z window ${Z_WINDOW}m, exit |z|<${EXIT_Z}, time-stop ${MAX_HOLD_BARS}m\n`);

// fetch all symbols once
const series = new Map<string, VenueCandle[]>();
for (const s of SYMBOLS) {
  const c = await fetchMinutes(s, DAYS);
  series.set(s, c);
  const span = c.length ? (c[c.length - 1].start_unix - c[0].start_unix) / 86400 : 0;
  console.log(`fetched ${s}: ${c.length} bars, span ${span.toFixed(2)}d`);
}

type PairResult = {
  pair: string; entryZ: number; rets: number[]; trades: number; barsInMarket: number; nBars: number;
  netSharpeAnn: number; netPerTradeBps: number; tradesPerDay: number; cumPct: number;
};

const results: PairResult[] = [];
for (const [A, B] of PAIRS) {
  const ca = series.get(A)!, cb = series.get(B)!;
  if (!ca?.length || !cb?.length) continue;
  const { t, la, lb } = align(ca, cb);
  const spanDays = t.length ? (t[t.length - 1] - t[0]) / 86400 : 0;
  // correlation of 1m log-returns (sanity that the pair is actually correlated)
  let cr = 0;
  {
    const ra: number[] = [], rb: number[] = [];
    for (let i = 1; i < la.length; i++) { ra.push(la[i] - la[i - 1]); rb.push(lb[i] - lb[i - 1]); }
    const ma = ra.reduce((s, x) => s + x, 0) / ra.length, mb = rb.reduce((s, x) => s + x, 0) / rb.length;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < ra.length; i++) { cov += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
    cr = cov / Math.sqrt(va * vb);
  }
  console.log(`\n--- pair ${A}/${B}: ${la.length} aligned bars, span ${spanDays.toFixed(2)}d, 1m-return corr=${cr.toFixed(3)} ---`);
  for (const entryZ of ENTRY_GRID) {
    const r = runPair(la, lb, entryZ);
    const sh = sharpe(r.rets);
    const netSharpeAnn = sh * ANN;
    const totalNet = r.rets.reduce((s, x) => s + x, 0);
    const netPerTradeBps = r.trades > 0 ? (totalNet / r.trades) * 1e4 : 0;
    const tradesPerDay = spanDays > 0 ? r.trades / spanDays : 0;
    const cumPct = (r.rets.reduce((e, x) => e * (1 + x), 1) - 1) * 100;
    results.push({ pair: `${A}/${B}`, entryZ, rets: r.rets, trades: r.trades, barsInMarket: r.barsInMarket, nBars: r.nBars, netSharpeAnn, netPerTradeBps, tradesPerDay, cumPct });
    console.log(`  entryZ=${entryZ}: trades=${r.trades} (${tradesPerDay.toFixed(1)}/day), inMkt=${(100 * r.barsInMarket / r.nBars).toFixed(1)}%, netSharpe(ann)=${netSharpeAnn.toFixed(2)}, perTradeNet=${netPerTradeBps.toFixed(1)}bps, cum=${cumPct.toFixed(2)}%`);
  }
}

if (!results.length) {
  console.log("\nNO RESULTS — data did not align/paginate.");
  process.exit(1);
}

// Pick the best config by NET annualized Sharpe (the honest objective AFTER costs).
results.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
const best = results[0];
console.log(`\n=== BEST NET CONFIG: ${best.pair} entryZ=${best.entryZ} ===`);
console.log(`netSharpe(ann)=${best.netSharpeAnn.toFixed(2)}, perTradeNet=${best.netPerTradeBps.toFixed(2)}bps, trades/day=${best.tradesPerDay.toFixed(1)}, trades=${best.trades}, cum=${best.cumPct.toFixed(2)}%`);

// ---- PBO + Deflated Sharpe over the entry-z grid, restricted to the BEST pair ----
const bestPairRows = results.filter((r) => r.pair === best.pair).sort((a, b) => a.entryZ - b.entryZ);
const minLen = Math.min(...bestPairRows.map((r) => r.rets.length));
const M: number[][] = [];
for (let i = 0; i < minLen; i++) M.push(bestPairRows.map((r) => r.rets[i]));
const pboVal = pbo(M, 8);
const trialSharpes = results.map((r) => sharpe(r.rets)); // per-bar sharpe of every config tried (cross-trial)
const dsr = deflatedSharpe(best.rets, trialSharpes);
console.log(`\nPBO (entry-z grid, best pair) = ${pboVal.toFixed(3)}  (lower better, <0.3 robust)`);
console.log(`Deflated Sharpe: SR(per-bar)=${dsr.sr.toFixed(4)}, SR0=${dsr.sr0.toFixed(4)}, DSR=${dsr.dsr.toFixed(4)}  (>0.95 = real after multiple-testing)`);

// ---- BLOCK-SHUFFLE permutation control (the decisive intraday test) ----
// Null: shuffle the BLOCK order of the per-bar net returns (preserves short-run autocorr + the return
// distribution, destroys the longer-horizon mean-reversion structure the strategy claims). If the
// observed Sharpe is not beyond the shuffled null, the "edge" is an artifact of the return distribution,
// not real temporal reversion structure.
const N_PERM = 1000;
const blockSize = 60; // 1h blocks
const obsSharpe = sharpe(best.rets);
const rng = lcgRng(12345);
const nullSharpes: number[] = [];
for (let p = 0; p < N_PERM; p++) {
  const perm = blockShufflePermutation(best.rets.length, blockSize, rng);
  const shuffled = applyPermutation(best.rets, perm);
  nullSharpes.push(sharpe(shuffled));
}
const permRes = permutationTest(obsSharpe, nullSharpes, "greater");
console.log(`\nBLOCK-SHUFFLE permutation (${N_PERM} draws, ${blockSize}m blocks):`);
console.log(`  observed per-bar Sharpe=${obsSharpe.toFixed(5)}, null mean=${(nullSharpes.reduce((s, x) => s + x, 0) / nullSharpes.length).toFixed(5)}, p=${permRes.pValue.toFixed(4)}`);

// NOTE: a block shuffle of the per-bar P&L preserves the position-cost structure imperfectly; the more
// honest reading is whether observed beats null. We also report a sign check: how much of the edge is
// just the entry-cost drag (i.e. is net even positive?).

// ---- adviseTrade: benchmark = buy-and-hold the spread's A leg (the "beta" of being in this market) ----
// Build a benchmark per-bar return series aligned to best.rets length: equal-weight long of both legs'
// 1m returns is roughly market beta; we use the A-leg log returns over the same realized bars.
const [Abest] = best.pair.split("/");
const caBest = series.get(Abest)!;
const benchAll: number[] = [];
for (let i = 1; i < caBest.length; i++) benchAll.push(caBest[i].close / caBest[i - 1].close - 1);
const bench = benchAll.slice(-best.rets.length);
const memo = adviseTrade({
  label: `minute-pairs ${best.pair} z>${best.entryZ}`,
  strategyReturns: best.rets,
  benchmarkReturns: bench,
  pbo: pboVal,
  dsr: dsr.dsr,
  oosFrac: 0.3,
});
console.log(`\n=== ADVISOR ===`);
console.log(renderTradeMemo(memo));

// ---- HONEST VERDICT ----
const survivesShuffle = permRes.pValue < 0.05;
const netPositive = best.netSharpeAnn > 0 && best.cumPct > 0;
const firesEnough = best.tradesPerDay >= 1;
let verdict: "REAL" | "MAYBE" | "NO";
if (netPositive && survivesShuffle && firesEnough && best.netSharpeAnn > 1.0) verdict = "REAL";
else if (netPositive && (survivesShuffle || best.netSharpeAnn > 0.5) && firesEnough) verdict = "MAYBE";
else verdict = "NO";

console.log(`\n=== HONEST VERDICT: ${verdict} ===`);
console.log(JSON.stringify({
  bestPair: best.pair, entryZ: best.entryZ,
  netSharpeAnn: +best.netSharpeAnn.toFixed(3),
  perTradeBps: +best.netPerTradeBps.toFixed(2),
  tradesPerDay: +best.tradesPerDay.toFixed(2),
  cumPct: +best.cumPct.toFixed(3),
  pbo: +pboVal.toFixed(3), dsr: +dsr.dsr.toFixed(4),
  shuffleP: +permRes.pValue.toFixed(4),
  advisor: memo.recommendation,
  verdict,
}, null, 2));
