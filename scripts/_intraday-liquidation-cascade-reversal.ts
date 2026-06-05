/**
 * _intraday-liquidation-cascade-reversal — hunt the LIQUIDATION-CASCADE REVERSAL edge.
 *
 * HYPOTHESIS: a fast forced-liquidation move OVERSHOOTS and snaps back within minutes-to-hours.
 * From 1m klines we proxy a "cascade" as a LARGE adverse move over a short window WITH a volume
 * spike (close move over W min beyond k×ATR AND |pct| beyond a floor AND volume above the p-th
 * rolling percentile). On a DOWN-cascade we go LONG (fade), on an UP-cascade we go SHORT, hold for
 * a fixed HORIZON H minutes, then flat. We charge a realistic round-trip (taker fee + slippage)
 * per trade and run the full overfit/shuffle gauntlet.
 *
 * NO-LOOKAHEAD: the trigger at bar i uses only data ≤ i (the window return i-W..i, ATR/volume stats
 * from bars < i). The realized return is the forward close move i → i+H, charged costs.
 *
 * Costs: 10bps round-trip taker on liquid majors (BTC/ETH/SOL/DOGE), 16bps on the smaller alts,
 * PLUS slippage scaled with the cascade magnitude (worse fills fading a fast move; 3bps/side floor).
 *
 * Data: read from data/cascade-klines/*.json (populated by _fetch-cascade-klines.ts).
 * Run: cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_intraday-liquidation-cascade-reversal.ts
 */
import "./_env.ts";
import { readFileSync, existsSync } from "node:fs";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { blockShufflePermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade } from "../src/lib/backtest/advisor.ts";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Cfg = { W: number; H: number; kAtr: number; pctFloor: number; volPctile: number; volLookback: number; atrN: number };

const COINS: { sym: string; rtBps: number }[] = [
  { sym: "BTCUSDT", rtBps: 10 },
  { sym: "ETHUSDT", rtBps: 10 },
  { sym: "SOLUSDT", rtBps: 10 },
  { sym: "DOGEUSDT", rtBps: 10 },
  { sym: "AVAXUSDT", rtBps: 16 },
  { sym: "LINKUSDT", rtBps: 16 },
];

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Load cached bars. */
function loadBars(sym: string): Bar[] {
  const p = `data/cascade-klines/${sym}.json`;
  if (!existsSync(p)) throw new Error(`missing ${p} — run scripts/_fetch-cascade-klines.ts first`);
  return JSON.parse(readFileSync(p, "utf8")) as Bar[];
}

type Trade = { i: number; t: number; dir: number; netRet: number; magBps: number };

/**
 * Build trades for one coin, NO-LOOKAHEAD. Uses a prefix sum of volume so each W-window sum is O(1)
 * and the rolling distribution build is O(volLookback) per candidate bar.
 *   - causal ATR = mean true range over (i-atrN..i-1)
 *   - window return = close(i) vs close(i-W)
 *   - volume spike  = sum vol over (i-W+1..i) ≥ p-th percentile of W-window sums over (i-volLookback..i-W)
 *   - FADE: long after a down-cascade, short after an up-cascade; hold H; charge fee+slip round-trip.
 */
function buildTrades(bars: Bar[], rtFeeBps: number, cfg: Cfg): Trade[] {
  const n = bars.length;
  const { W, H, kAtr, pctFloor, volPctile, volLookback, atrN } = cfg;

  // true range + prefix sums
  const tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    tr[i] = Math.max(hl, hc, lc);
  }
  const trPre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) trPre[i + 1] = trPre[i] + tr[i];
  const volPre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) volPre[i + 1] = volPre[i] + bars[i].v;
  const winVolAt = (i: number) => volPre[i + 1] - volPre[i + 1 - W]; // sum over (i-W+1..i)

  const trades: Trade[] = [];
  let nextFree = 0;
  const startI = Math.max(W + atrN, volLookback) + 1;
  for (let i = startI; i + H < n; i++) {
    if (i < nextFree) continue;

    const atr = (trPre[i] - trPre[i - atrN]) / atrN; // bars (i-atrN..i-1)
    if (!(atr > 0)) continue;

    const cNow = bars[i].c, cPast = bars[i - W].c;
    const winRet = (cNow - cPast) / cPast;
    const movePerAtr = (cNow - cPast) / atr;

    const bigDown = movePerAtr <= -kAtr && winRet <= -pctFloor;
    const bigUp = movePerAtr >= kAtr && winRet >= pctFloor;
    if (!bigDown && !bigUp) continue;

    // rolling distribution of W-window volume sums over (i-volLookback .. i-W), strictly before i
    const dist: number[] = [];
    for (let s = i - volLookback; s <= i - W; s++) dist.push(volPre[s + 1] - volPre[s + 1 - W]);
    if (dist.length < 20) continue;
    dist.sort((a, b) => a - b);
    const volThresh = dist[Math.min(dist.length - 1, Math.floor(volPctile * dist.length))];
    if (winVolAt(i) < volThresh) continue;

    const dir = bigDown ? +1 : -1;
    const cExit = bars[i + H].c;
    const fwd = (cExit - cNow) / cNow;
    const gross = dir * fwd;
    const magBps = Math.abs(winRet) * 1e4;
    const slipPerSide = Math.min(12, 3 + 0.04 * magBps); // bps, grows with cascade size
    const costBps = rtFeeBps + 2 * slipPerSide;
    trades.push({ i, t: bars[i].t, dir, netRet: gross - costBps / 1e4, magBps });
    nextFree = i + H; // one position at a time per coin (no overlap)
  }
  return trades;
}

/** Pooled, time-ordered net returns across all coins for a config. */
function pooledTrades(data: { sym: string; bars: Bar[]; rtBps: number }[], cfg: Cfg): { t: number; ret: number }[] {
  const out: { t: number; ret: number }[] = [];
  for (const d of data) for (const tr of buildTrades(d.bars, d.rtBps, cfg)) out.push({ t: tr.t, ret: tr.netRet });
  return out.sort((a, b) => a.t - b.t);
}

// ---- load ----
const data = COINS.map(({ sym, rtBps }) => ({ sym, bars: loadBars(sym), rtBps }));
const spanDays = Math.max(...data.map((d) => (d.bars.length ? (d.bars[d.bars.length - 1].t - d.bars[0].t) / 86400_000 : 0)));
console.log(`Loaded ${data.length} coins, ~${spanDays.toFixed(1)}d each (${data.map((d) => `${d.sym}:${d.bars.length}`).join(" ")})`);

const CFG: Cfg = { W: 10, H: 60, kAtr: 4, pctFloor: 0.008, volPctile: 0.9, volLookback: 240, atrN: 60 };
console.log(`Signal: window=${CFG.W}m horizon=${CFG.H}m FADE when |move|≥${CFG.kAtr}×ATR & ≥${(CFG.pctFloor * 100).toFixed(1)}% & vol≥p${CFG.volPctile * 100}\n`);

// per-coin breakdown
for (const d of data) {
  const tr = buildTrades(d.bars, d.rtBps, CFG);
  console.log(`  ${d.sym}: ${tr.length} trades | net mean ${(mean(tr.map((x) => x.netRet)) * 1e4).toFixed(2)}bps`);
}

const pooled = pooledTrades(data, CFG);
const rets = pooled.map((x) => x.ret);
const N = rets.length;
const tradesPerDay = spanDays > 0 ? N / spanDays : 0;

console.log(`\n===== POOLED =====`);
console.log(`trades ${N} | span ~${spanDays.toFixed(1)}d | trades/day ${tradesPerDay.toFixed(2)}`);
if (N < 10) { console.log("Too few trades — trigger essentially never fires."); process.exit(0); }

const perTradeSharpe = sharpe(rets);
const meanBps = mean(rets) * 1e4;
const winRate = rets.filter((x) => x > 0).length / N;
const tradesPerYear = tradesPerDay * 365;
const annSharpe = perTradeSharpe * Math.sqrt(tradesPerYear);
console.log(`per-trade net ${meanBps.toFixed(2)}bps | win ${(winRate * 100).toFixed(1)}% | per-trade Sharpe ${perTradeSharpe.toFixed(4)} | ann Sharpe ×√${tradesPerYear.toFixed(0)} = ${annSharpe.toFixed(2)}`);

// ---- deflated Sharpe over a param grid (trials) ----
const grid: Cfg[] = [];
for (const kAtr of [3, 4, 5]) for (const H of [30, 60, 120]) for (const W of [5, 10, 15]) grid.push({ ...CFG, kAtr, H, W });
const trialSharpes: number[] = [];
for (const g of grid) { const r = pooledTrades(data, g).map((x) => x.ret); if (r.length >= 10) trialSharpes.push(sharpe(r)); }
const dsr = deflatedSharpe(rets, trialSharpes.length ? trialSharpes : [perTradeSharpe]);
console.log(`\nDSR: SR=${dsr.sr.toFixed(4)} SR0=${dsr.sr0.toFixed(4)} DSR(P true>0)=${dsr.dsr.toFixed(3)} over ${trialSharpes.length} trials`);

// ---- PBO via combinatorial CV on a (time-rows × configs) mean-return matrix ----
const pboConfigs: Cfg[] = [CFG, { ...CFG, kAtr: 3 }, { ...CFG, kAtr: 5 }, { ...CFG, H: 30 }, { ...CFG, H: 120 }, { ...CFG, W: 5 }];
const series = pboConfigs.map((g) => pooledTrades(data, g));
const ROWS = 16;
const tMin = Math.min(...series.flatMap((s) => (s.length ? [s[0].t] : [])));
const tMax = Math.max(...series.flatMap((s) => (s.length ? [s[s.length - 1].t] : [])));
let pboVal = 1;
if (Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin) {
  const M: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const lo = tMin + ((tMax - tMin) * r) / ROWS, hi = tMin + ((tMax - tMin) * (r + 1)) / ROWS;
    M.push(series.map((s) => { const b = s.filter((x) => x.t >= lo && x.t < hi).map((x) => x.ret); return b.length ? mean(b) : 0; }));
  }
  pboVal = pbo(M, 8);
}
console.log(`PBO (${pboConfigs.length} configs × ${ROWS} rows): ${pboVal.toFixed(3)}`);

// ---- NULL CONTROLS ----
const rng = lcgRng(12345);
const NPERM = 2000;
const observedMean = mean(rets);

// (A) sign-flip block-shuffle null: shuffle block order AND randomly negate whole blocks → destroys
// the directional (fade) edge while preserving the magnitude distribution. Statistic = mean return.
const nullA: number[] = [];
const blockSize = Math.max(1, Math.round(N / 12));
for (let p = 0; p < NPERM; p++) {
  const perm = blockShufflePermutation(N, blockSize, rng);
  let s = 0;
  for (let b = 0; b * blockSize < N; b++) { const sign = rng() < 0.5 ? -1 : 1; for (let j = b * blockSize; j < Math.min(N, (b + 1) * blockSize); j++) s += sign * rets[perm[j]]; }
  nullA.push(s / N);
}
const permA = permutationTest(observedMean, nullA, "greater");

// (B) random-entry control (strongest): does the CASCADE FILTER beat fading random bars? Same #
// trades/coin, same dir-by-sign-of-local-move logic, same cost model, but entries at random bars.
function randomEntryMeanBps(r: () => number): number {
  const all: number[] = [];
  for (const d of data) {
    const m = buildTrades(d.bars, d.rtBps, CFG).length;
    if (!m) continue;
    const n = d.bars.length, W = CFG.W, H = CFG.H;
    for (let k = 0; k < m; k++) {
      const i = W + 1 + Math.floor(r() * (n - W - H - 2));
      const cNow = d.bars[i].c, cPast = d.bars[i - W].c, cExit = d.bars[i + H].c;
      const winRet = (cNow - cPast) / cPast;
      const dir = winRet <= 0 ? +1 : -1;
      const magBps = Math.abs(winRet) * 1e4;
      const slip = Math.min(12, 3 + 0.04 * magBps);
      all.push(dir * (cExit - cNow) / cNow - (d.rtBps + 2 * slip) / 1e4);
    }
  }
  return mean(all) * 1e4;
}
const nullB: number[] = [];
const rngB = lcgRng(999);
for (let p = 0; p < 400; p++) nullB.push(randomEntryMeanBps(rngB));
const permB = permutationTest(meanBps, nullB, "greater");

console.log(`\n--- NULL CONTROLS ---`);
console.log(`(A) sign-flip block-shuffle: obs ${(observedMean * 1e4).toFixed(2)}bps vs null ${(mean(nullA) * 1e4).toFixed(2)}±${(std(nullA) * 1e4).toFixed(2)}bps → p=${permA.pValue.toFixed(4)}`);
console.log(`(B) random-entry: cascade ${meanBps.toFixed(2)}bps vs random-fade ${mean(nullB).toFixed(2)}±${std(nullB).toFixed(2)}bps → p=${permB.pValue.toFixed(4)}`);

// ---- advisor (benchmark = cash; intraday strategy must beat 0 net) ----
const memo = adviseTrade({ label: "liquidation-cascade-reversal", strategyReturns: rets, benchmarkReturns: rets.map(() => 0), pbo: pboVal, dsr: dsr.dsr });
console.log(`\n--- ADVISOR ---\n${memo.recommendation} (conviction ${memo.conviction}) | roiVerdict ${memo.advice.roiVerdict}\n${memo.voice}`);

// ---- verdict ----
const netPositive = meanBps > 0 && annSharpe > 0;
const survivesShuffle = permA.pValue < 0.05 && permB.pValue < 0.05;
const firesEnough = tradesPerDay >= 0.3;
let verdict: "yes" | "maybe" | "no";
if (netPositive && survivesShuffle && firesEnough && annSharpe > 1.0) verdict = "yes";
else if (netPositive && (permA.pValue < 0.1 || permB.pValue < 0.1) && firesEnough) verdict = "maybe";
else verdict = "no";

console.log(`\n===== VERDICT: ${verdict.toUpperCase()} =====`);
console.log(JSON.stringify({
  netSharpe: +annSharpe.toFixed(3), perTradeBps: +meanBps.toFixed(2), tradesPerDay: +tradesPerDay.toFixed(3),
  winRate: +(winRate * 100).toFixed(1), shufflePvalueA: +permA.pValue.toFixed(4), randomEntryPvalueB: +permB.pValue.toFixed(4),
  pbo: +pboVal.toFixed(3), dsr: +dsr.dsr.toFixed(3), advisorVerdict: memo.recommendation, realCandidate: verdict, nTrades: N,
}, null, 2));
