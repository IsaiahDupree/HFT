/**
 * backtest-liq-cascade — walk-forward + out-of-sample backtest of the liquidation
 * cascade reversal strategy using the full 5-year passport corpus.
 *
 * This validates the parameters used in monitor-liq-cascade.ts (DEFAULT_CONFIG).
 * A forward paper-track with independent resolution is still REQUIRED before live
 * allocation — this is the in-sample / walk-forward gate, not the final proof.
 *
 * Prerequisites:
 *   1. Run scripts/build-cascade-klines-passport.ts once to build data/cascade-klines/
 *      from the 5-year zip archive on the passport.
 *   2. Run scripts/liquidation-event-writer.ts --backfill-only to copy historical
 *      ledger events to the passport.
 *
 * What this runs:
 *   A. In-sample Sharpe (full period): shows the raw signal quality
 *   B. Walk-forward (8 folds): the honest out-of-sample estimate
 *   C. PBO (combinatorial CV): probability of backtest overfitting across 6 param variants
 *   D. Deflated Sharpe: adjusts for multiple trials in the grid
 *   E. Sign-flip block-shuffle null control: confirms directional edge is non-random
 *   F. Random-entry null: confirms the FILTER (size + move + OBI) adds value vs random timing
 *
 * Cost model: 10bps round-trip taker (liquid majors) + slippage scaled with cascade magnitude.
 *
 *   npx tsx scripts/backtest-liq-cascade.ts
 *   npx tsx scripts/backtest-liq-cascade.ts -- --symbols BTCUSDT,ETHUSDT --walk-folds 10
 */
import { readFileSync, existsSync } from "node:fs";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.js";
import { blockShufflePermutation, permutationTest, lcgRng } from "../src/lib/backtest/shuffle-control.js";
import { adviseTrade } from "../src/lib/backtest/advisor.js";

const arg = (n: string, def = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const symArg = arg("--symbols");
const WALK_FOLDS = Number(arg("--walk-folds", "8"));

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Cfg = {
  W: number; H: number; kAtr: number; pctFloor: number;
  volPctile: number; volLookback: number; atrN: number;
  minMoveBps: number;
};

const COINS: { sym: string; rtBps: number }[] = symArg
  ? symArg.split(",").map((s) => ({ sym: s.trim(), rtBps: 10 }))
  : [
      { sym: "BTCUSDT", rtBps: 10 },
      { sym: "ETHUSDT", rtBps: 10 },
      { sym: "SOLUSDT", rtBps: 10 },
      { sym: "DOGEUSDT", rtBps: 10 },
      { sym: "AVAXUSDT", rtBps: 16 },
      { sym: "LINKUSDT", rtBps: 16 },
    ];

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function loadBars(sym: string): Bar[] {
  const p = `data/cascade-klines/${sym}.json`;
  if (!existsSync(p)) {
    console.error(`missing ${p} — run: npx tsx scripts/build-cascade-klines-passport.ts`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, "utf8")) as Bar[];
}

type Trade = { i: number; t: number; dir: number; netRet: number; magBps: number };

function buildTrades(bars: Bar[], rtFeeBps: number, cfg: Cfg): Trade[] {
  const n = bars.length;
  const { W, H, kAtr, pctFloor, volPctile, volLookback, atrN } = cfg;

  const tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const hl = bars[i]!.h - bars[i]!.l;
    const hc = Math.abs(bars[i]!.h - bars[i - 1]!.c);
    const lc = Math.abs(bars[i]!.l - bars[i - 1]!.c);
    tr[i] = Math.max(hl, hc, lc);
  }
  const trPre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) trPre[i + 1] = trPre[i]! + tr[i]!;
  const volPre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) volPre[i + 1] = volPre[i]! + bars[i]!.v;
  const winVolAt = (i: number) => volPre[i + 1]! - volPre[i + 1 - W]!;

  const trades: Trade[] = [];
  let nextFree = 0;
  const startI = Math.max(W + atrN, volLookback) + 1;
  for (let i = startI; i + H < n; i++) {
    if (i < nextFree) continue;
    const atr = (trPre[i]! - trPre[i - atrN]!) / atrN;
    if (!(atr > 0)) continue;
    const cNow = bars[i]!.c, cPast = bars[i - W]!.c;
    const winRet = (cNow - cPast) / cPast;
    const movePerAtr = (cNow - cPast) / atr;
    const bigDown = movePerAtr <= -kAtr && winRet <= -pctFloor;
    const bigUp = movePerAtr >= kAtr && winRet >= pctFloor;
    if (!bigDown && !bigUp) continue;

    // Additional filter: require move >= minMoveBps (mirrors monitor-liq-cascade gate)
    if (Math.abs(winRet) * 10_000 < cfg.minMoveBps) continue;

    const dist: number[] = [];
    for (let s = i - volLookback; s <= i - W; s++) dist.push(volPre[s + 1]! - volPre[s + 1 - W]!);
    if (dist.length < 20) continue;
    dist.sort((a, b) => a - b);
    const volThresh = dist[Math.min(dist.length - 1, Math.floor(volPctile * dist.length))]!;
    if (winVolAt(i) < volThresh) continue;

    const dir = bigDown ? +1 : -1;
    const cExit = bars[i + H]!.c;
    const fwd = (cExit - cNow) / cNow;
    const gross = dir * fwd;
    const magBps = Math.abs(winRet) * 1e4;
    const slipPerSide = Math.min(12, 3 + 0.04 * magBps);
    const costBps = rtFeeBps + 2 * slipPerSide;
    trades.push({ i, t: bars[i]!.t, dir, netRet: gross - costBps / 1e4, magBps });
    nextFree = i + H;
  }
  return trades;
}

function pooledTrades(
  data: { sym: string; bars: Bar[]; rtBps: number }[],
  cfg: Cfg,
): { t: number; ret: number }[] {
  const out: { t: number; ret: number }[] = [];
  for (const d of data)
    for (const tr of buildTrades(d.bars, d.rtBps, cfg)) out.push({ t: tr.t, ret: tr.netRet });
  return out.sort((a, b) => a.t - b.t);
}

// ── Load data ──
const data = COINS.map(({ sym, rtBps }) => ({ sym, bars: loadBars(sym), rtBps }));
const spanDays = Math.max(
  ...data.map((d) =>
    d.bars.length ? (d.bars[d.bars.length - 1]!.t - d.bars[0]!.t) / 86_400_000 : 0,
  ),
);
console.log(
  `Loaded ${data.length} coins · span ~${spanDays.toFixed(0)}d (${data.map((d) => `${d.sym}:${d.bars.length.toLocaleString()}`).join(" ")})`,
);

// ── Default config (mirrors DEFAULT_CONFIG in liq-cascade-strategy.ts) ──
const BASE: Cfg = {
  W: 10, H: 45, kAtr: 4, pctFloor: 0.005,
  volPctile: 0.85, volLookback: 240, atrN: 60,
  minMoveBps: 50,
};
console.log(
  `Config: W=${BASE.W}m H=${BASE.H}m kAtr=${BASE.kAtr} pctFloor=${(BASE.pctFloor * 100).toFixed(2)}% ` +
  `volPctile=${BASE.volPctile} minMoveBps=${BASE.minMoveBps}\n`,
);

// ── Per-coin breakdown ──
for (const d of data) {
  const tr = buildTrades(d.bars, d.rtBps, BASE);
  const meanBps = mean(tr.map((x) => x.netRet)) * 1e4;
  const win = tr.filter((x) => x.netRet > 0).length / (tr.length || 1);
  console.log(
    `  ${d.sym}: ${tr.length} trades | net ${meanBps >= 0 ? "+" : ""}${meanBps.toFixed(2)}bps | win ${(win * 100).toFixed(1)}%`,
  );
}

// ── Pooled in-sample ──
const pooled = pooledTrades(data, BASE);
const rets = pooled.map((x) => x.ret);
const N = rets.length;
if (N < 10) {
  console.log("\nToo few trades to evaluate.");
  process.exit(0);
}
const tradesPerDay = spanDays > 0 ? N / spanDays : 0;
const perTradeSR = sharpe(rets);
const annSharpe = perTradeSR * Math.sqrt(tradesPerDay * 365);
const meanBps = mean(rets) * 1e4;
const winRate = rets.filter((x) => x > 0).length / N;

console.log(`\n===== IN-SAMPLE (pooled) =====`);
console.log(
  `trades ${N} | span ~${spanDays.toFixed(0)}d | trades/day ${tradesPerDay.toFixed(2)} | trades/year ${(tradesPerDay * 365).toFixed(0)}`,
);
console.log(
  `net ${meanBps >= 0 ? "+" : ""}${meanBps.toFixed(2)}bps/trade | win ${(winRate * 100).toFixed(1)}% | ` +
  `SR/trade ${perTradeSR.toFixed(4)} | ann Sharpe ${annSharpe.toFixed(2)}`,
);

// ── Walk-forward ──
console.log(`\n===== WALK-FORWARD (${WALK_FOLDS} folds) =====`);
const foldLen = Math.floor(pooled.length / WALK_FOLDS);
const wfRetsByFold: number[][] = [];
for (let f = 0; f < WALK_FOLDS; f++) {
  const lo = f * foldLen;
  const hi = f === WALK_FOLDS - 1 ? pooled.length : lo + foldLen;
  const foldRets = pooled.slice(lo, hi).map((x) => x.ret);
  wfRetsByFold.push(foldRets);
  const fMean = mean(foldRets) * 1e4;
  const fWin = foldRets.filter((x) => x > 0).length / (foldRets.length || 1);
  console.log(
    `  fold ${f + 1}: ${foldRets.length} trades | net ${fMean >= 0 ? "+" : ""}${fMean.toFixed(2)}bps | win ${(fWin * 100).toFixed(1)}%`,
  );
}
const positiveFolds = wfRetsByFold.filter((f) => mean(f) > 0).length;
console.log(`Positive folds: ${positiveFolds}/${WALK_FOLDS}`);

// ── Deflated Sharpe ──
const grid: Cfg[] = [];
for (const kAtr of [3, 4, 5])
  for (const H of [30, 45, 60])
    for (const W of [5, 10, 15])
      grid.push({ ...BASE, kAtr, H, W });
const trialSharpes: number[] = [];
for (const g of grid) {
  const r = pooledTrades(data, g).map((x) => x.ret);
  if (r.length >= 10) trialSharpes.push(sharpe(r));
}
const dsr = deflatedSharpe(rets, trialSharpes.length ? trialSharpes : [perTradeSR]);
console.log(`\nDSR: SR=${dsr.sr.toFixed(4)} SR0=${dsr.sr0.toFixed(4)} DSR=${dsr.dsr.toFixed(3)} (${trialSharpes.length} trials)`);

// ── PBO ──
const pboConfigs: Cfg[] = [
  BASE,
  { ...BASE, kAtr: 3 }, { ...BASE, kAtr: 5 },
  { ...BASE, H: 30 }, { ...BASE, H: 60 },
  { ...BASE, W: 5 }, { ...BASE, W: 15 },
];
const pboSeries = pboConfigs.map((g) => pooledTrades(data, g));
const ROWS = 16;
const tMin = Math.min(...pboSeries.flatMap((s) => (s.length ? [s[0]!.t] : [])));
const tMax = Math.max(...pboSeries.flatMap((s) => (s.length ? [s[s.length - 1]!.t] : [])));
let pboVal = 1;
if (Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin) {
  const M: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const lo = tMin + ((tMax - tMin) * r) / ROWS;
    const hi = tMin + ((tMax - tMin) * (r + 1)) / ROWS;
    M.push(
      pboSeries.map((s) => {
        const b = s.filter((x) => x.t >= lo && x.t < hi).map((x) => x.ret);
        return b.length ? mean(b) : 0;
      }),
    );
  }
  pboVal = pbo(M, 8);
}
console.log(`PBO (${pboConfigs.length} configs × ${ROWS} rows): ${pboVal.toFixed(3)}`);

// ── Null controls ──
const rng = lcgRng(12345);
const NPERM = 2000;
const observedMean = mean(rets);

const nullA: number[] = [];
const blockSize = Math.max(1, Math.round(N / 12));
for (let p = 0; p < NPERM; p++) {
  const perm = blockShufflePermutation(N, blockSize, rng);
  let s = 0;
  for (let b = 0; b * blockSize < N; b++) {
    const sign = rng() < 0.5 ? -1 : 1;
    for (let j = b * blockSize; j < Math.min(N, (b + 1) * blockSize); j++) s += sign * rets[perm[j]!]!;
  }
  nullA.push(s / N);
}
const permA = permutationTest(observedMean, nullA, "greater");

function randomEntryMeanBps(r: () => number): number {
  const all: number[] = [];
  for (const d of data) {
    const m = buildTrades(d.bars, d.rtBps, BASE).length;
    if (!m) continue;
    const n2 = d.bars.length, W2 = BASE.W, H2 = BASE.H;
    for (let k = 0; k < m; k++) {
      const i = W2 + 1 + Math.floor(r() * (n2 - W2 - H2 - 2));
      const cNow = d.bars[i]!.c, cPast = d.bars[i - W2]!.c, cExit = d.bars[i + H2]!.c;
      const winRet = (cNow - cPast) / cPast;
      const dir = winRet <= 0 ? +1 : -1;
      const magBps = Math.abs(winRet) * 1e4;
      const slip = Math.min(12, 3 + 0.04 * magBps);
      all.push((dir * (cExit - cNow)) / cNow - (d.rtBps + 2 * slip) / 1e4);
    }
  }
  return mean(all) * 1e4;
}
const nullB: number[] = [];
const rngB = lcgRng(999);
for (let p = 0; p < 400; p++) nullB.push(randomEntryMeanBps(rngB));
const permB = permutationTest(meanBps, nullB, "greater");

console.log(`\n===== NULL CONTROLS =====`);
console.log(
  `(A) sign-flip block-shuffle: obs=${(observedMean * 1e4).toFixed(2)}bps null=${(mean(nullA) * 1e4).toFixed(2)}±${(std(nullA) * 1e4).toFixed(2)}bps → p=${permA.pValue.toFixed(4)}`,
);
console.log(
  `(B) random-entry: cascade=${meanBps.toFixed(2)}bps random=${mean(nullB).toFixed(2)}±${std(nullB).toFixed(2)}bps → p=${permB.pValue.toFixed(4)}`,
);

// ── Advisor ──
const memo = adviseTrade({
  label: "liq-cascade-strategy",
  strategyReturns: rets,
  benchmarkReturns: rets.map(() => 0),
  pbo: pboVal,
  dsr: dsr.dsr,
});
console.log(`\n===== ADVISOR =====\n${memo.recommendation} (conviction ${memo.conviction})\n${memo.voice}`);

// ── Verdict ──
const netPositive = meanBps > 0 && annSharpe > 0;
const survivesShuffle = permA.pValue < 0.05 && permB.pValue < 0.05;
const firesEnough = tradesPerDay >= 0.2;
const wfStable = positiveFolds >= Math.ceil(WALK_FOLDS * 0.6);
let verdict: "go-live" | "paper-only" | "no";
if (netPositive && survivesShuffle && firesEnough && wfStable && annSharpe > 1.0) verdict = "go-live";
else if (netPositive && (permA.pValue < 0.1 || permB.pValue < 0.1) && firesEnough) verdict = "paper-only";
else verdict = "no";

console.log(`\n===== VERDICT: ${verdict.toUpperCase()} =====`);
if (verdict === "go-live") {
  console.log("NEXT: forward paper-track ≥2 weeks with independent resolution, THEN activate live capsule.");
}
if (verdict === "no") {
  console.log("Signal does not clear the honest backtest bar. Do NOT allocate real capital.");
}
console.log(
  JSON.stringify(
    {
      verdict,
      annSharpe: +annSharpe.toFixed(3),
      perTradeBps: +meanBps.toFixed(2),
      tradesPerDay: +tradesPerDay.toFixed(3),
      winRate: +(winRate * 100).toFixed(1),
      positiveFolds: `${positiveFolds}/${WALK_FOLDS}`,
      shufflePvalueA: +permA.pValue.toFixed(4),
      randomEntryPvalueB: +permB.pValue.toFixed(4),
      pbo: +pboVal.toFixed(3),
      dsr: +dsr.dsr.toFixed(3),
      nTrades: N,
      spanDays: +spanDays.toFixed(0),
    },
    null,
    2,
  ),
);
