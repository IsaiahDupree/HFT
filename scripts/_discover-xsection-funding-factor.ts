import "./_env.ts";
/**
 * DISCOVERY: CROSS-SECTIONAL FUNDING FACTOR (market-neutral).
 *
 * Hypothesis: coins with very HIGH perp funding are crowded longs that mean-revert /
 * UNDERPERFORM; coins with LOW or NEGATIVE funding are under-owned and OUTPERFORM.
 * Each day rank the universe by a funding signal, go LONG the bottom tercile + SHORT
 * the top tercile (equal-weight, dollar-neutral), realize the PRICE return i -> i+1.
 *
 * NO-LOOKAHEAD: the funding signal for day i uses only funding settlements that occurred
 * WITHIN day i (00:00 / 08:00 / 16:00 UTC of day i, all known by the day-i+1 00:00 candle
 * close). The position formed at day i is held over i->i+1 and realizes close[i+1]/close[i]-1.
 *
 * Benchmark = cash (zeros) — the correct yardstick for a dollar-neutral long/short book.
 * Gauntlet: annualized Sharpe (sqrt 365), PBO, Deflated Sharpe, adviseTrade one-voice verdict.
 * Control: a block-shuffle permutation of the funding RANK signal (break the funding->return
 * link while preserving the cross-section), to check the edge isn't a coincidence.
 *
 * Run: cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_discover-xsection-funding-factor.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getCandles } from "../src/lib/db/candle-store.ts";
import { sharpe, pbo, deflatedSharpe } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

const DAY = 86_400;
const FUND_DIR = "data/funding";
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------------------
// 1. Load funding (8-hourly) -> per-coin DAILY funding sum, keyed by UTC day.
// ---------------------------------------------------------------------------
type DayMap = Map<number, number>;
function loadDailyFunding(coin: string): DayMap | null {
  const fp = path.join(FUND_DIR, `${coin}.binance.jsonl`);
  if (!fs.existsSync(fp)) return null;
  const byDay: DayMap = new Map();
  for (const line of fs.readFileSync(fp, "utf8").trim().split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as { time: number; rate: number };
    const day = Math.floor(r.time / DAY) * DAY; // funding `time` is in SECONDS
    byDay.set(day, (byDay.get(day) ?? 0) + r.rate); // sum the 3 settlements -> daily funding
  }
  return byDay;
}

// All binance funding coins on disk.
const fundingCoins = fs
  .readdirSync(FUND_DIR)
  .filter((f) => f.endsWith(".binance.jsonl"))
  .map((f) => f.replace(".binance.jsonl", ""));

// ---------------------------------------------------------------------------
// 2. Match each funding coin to its warehouse USDT candle series; keep coins
//    with full post-funding-start coverage. close keyed by UTC day.
// ---------------------------------------------------------------------------
const FUND_START = 1737417600; // 2025-01-21, first funding day
type Coin = { coin: string; sym: string; close: DayMap; funding: DayMap };
const coins: Coin[] = [];
for (const coin of fundingCoins) {
  const fund = loadDailyFunding(coin);
  if (!fund) continue;
  const sym = `${coin}USDT`;
  let candles;
  try {
    candles = await getCandles(sym, "ONE_DAY");
  } catch {
    continue;
  }
  const post = candles.filter((c) => c.start_unix >= FUND_START);
  if (post.length < 200) continue; // need a usable window
  const close: DayMap = new Map();
  for (const c of candles) close.set(Math.floor(c.start_unix / DAY) * DAY, c.close);
  coins.push({ coin, sym, close, funding: fund });
}

console.log(`Universe: ${coins.length} coins with funding + warehouse candles`);
console.log(coins.map((c) => c.coin).join(" "));
if (coins.length < 6) {
  console.log("Not enough coins for terciles — aborting.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Build the common day axis (intersection of funding-start..end where >= N coins
//    have BOTH funding[i] and close[i] and close[i+1]).
// ---------------------------------------------------------------------------
const allDays = new Set<number>();
for (const c of coins) for (const d of c.close.keys()) if (d >= FUND_START) allDays.add(d);
const days = [...allDays].sort((a, b) => a - b);
console.log(
  `Day axis: ${days.length} days  ${new Date(days[0] * 1000).toISOString().slice(0, 10)} .. ${new Date(days[days.length - 1] * 1000).toISOString().slice(0, 10)}`,
);

// eligibility for day i: coin has funding[i], close[i], close[i+1].
function eligible(i: number): Coin[] {
  const t = days[i], tNext = days[i + 1];
  return coins.filter((c) => c.funding.has(t) && c.close.has(t) && c.close.has(tNext));
}

// ---------------------------------------------------------------------------
// 4. Core long/short tercile return builder (parameterized for variant sweep).
//    signalKind: how to turn funding into a rank value at day i (NO-LOOKAHEAD).
//    fracTercile: top/bottom fraction to long/short (0.33 = terciles).
//    sign:  +1 = standard hypothesis (long LOW funding, short HIGH funding).
//           -1 = inverted (the momentum/crowding-confirmed direction) — included so the
//                sweep is honest about which side actually worked, and PBO sees both.
//    rankOverride: optional precomputed signal map for the shuffle control.
// ---------------------------------------------------------------------------
type Variant = { label: string; smooth: number; frac: number; sign: 1 | -1 };

/** funding signal at day i = trailing `smooth`-day average daily funding (uses funding <= day i). */
function fundingSignal(c: Coin, i: number, smooth: number): number | null {
  let sum = 0, n = 0;
  for (let k = i - smooth + 1; k <= i; k++) {
    if (k < 0) continue;
    const d = days[k];
    const f = c.funding.get(d);
    if (f == null) continue;
    sum += f; n++;
  }
  return n > 0 ? sum / n : null;
}

const MIN_COINS = 6; // need >= 2 per tercile side
const START_I = 5; // allow up to 5-day smoothing warmup so variants share an index axis

function tercileReturns(v: Variant, feeBps = 10): number[] {
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = START_I; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    const elig = eligible(i)
      .map((c) => ({ c, s: fundingSignal(c, i, v.smooth) }))
      .filter((x): x is { c: Coin; s: number } => x.s != null);
    if (elig.length < MIN_COINS) {
      rets.push(0);
      prevW = {};
      continue;
    }
    // rank by funding signal ascending (lowest funding first).
    elig.sort((a, b) => a.s - b.s);
    const k = Math.max(1, Math.floor(elig.length * v.frac));
    const low = elig.slice(0, k); // lowest funding
    const high = elig.slice(elig.length - k); // highest funding
    // standard hypothesis (sign +1): LONG low funding, SHORT high funding.
    const wMap: Record<string, number> = {};
    const wl = (v.sign * 1) / k; // long weight on low-funding side
    const wh = (v.sign * -1) / k; // short weight on high-funding side
    let pr = 0;
    for (const { c } of low) {
      const ret = c.close.get(tNext)! / c.close.get(t)! - 1;
      pr += wl * ret;
      wMap[c.coin] = (wMap[c.coin] ?? 0) + wl;
    }
    for (const { c } of high) {
      const ret = c.close.get(tNext)! / c.close.get(t)! - 1;
      pr += wh * ret;
      wMap[c.coin] = (wMap[c.coin] ?? 0) + wh;
    }
    // turnover fee on |Δweight| (gross leg changes).
    let turn = 0;
    for (const cc of new Set([...Object.keys(prevW), ...Object.keys(wMap)])) turn += Math.abs((wMap[cc] ?? 0) - (prevW[cc] ?? 0));
    rets.push(pr - turn * (feeBps / 1e4));
    prevW = wMap;
  }
  return rets;
}

// ---------------------------------------------------------------------------
// 5. Variant grid (smoothing x tercile-fraction x direction). The PRIMARY claim
//    is sign +1 (long low / short high funding). We include sign -1 and a few
//    smoothing/frac cells so PBO + DSR see the real search space we explored.
// ---------------------------------------------------------------------------
const smooths = [1, 3, 5];
const fracs = [0.33, 0.25];
const variants: Variant[] = [];
for (const sign of [1, -1] as const)
  for (const smooth of smooths)
    for (const frac of fracs)
      variants.push({ label: `s${sign > 0 ? "+" : "-"}_sm${smooth}_f${frac}`, smooth, frac, sign });

const series = variants.map((v) => ({ v, r: tercileReturns(v) }));
const L = Math.min(...series.map((s) => s.r.length));
for (const s of series) s.r = s.r.slice(0, L);

// per-variant per-period Sharpe + annualized
function annSharpe(r: number[]): number {
  return sharpe(r) * ANN;
}
const ranked = series
  .map((s) => ({ label: s.v.label, sh: sharpe(s.r), ann: annSharpe(s.r), cum: s.r.reduce((a, x) => a + x, 0), r: s.r, v: s.v }))
  .sort((a, b) => b.sh - a.sh);

console.log(`\n=== Variant grid (${variants.length} cells), ${L} bars each ===`);
for (const x of ranked) console.log(`  ${x.label.padEnd(14)} annSharpe ${x.ann.toFixed(2).padStart(6)}  cum ${(x.cum * 100).toFixed(1).padStart(7)}%`);

// ---------------------------------------------------------------------------
// 6. Gauntlet on the BEST variant.
// ---------------------------------------------------------------------------
const best = ranked[0];
const bench = new Array(best.r.length).fill(0); // cash for market-neutral
const M = series.map((s) => s.r); // PBO matrix: M[t][c]
const Mt: number[][] = [];
for (let t = 0; t < L; t++) Mt.push(M.map((col) => col[t]));
const pboVal = pbo(Mt, 8);
const trialSharpes = ranked.map((x) => x.sh);
const { dsr, sr, sr0 } = deflatedSharpe(best.r, trialSharpes);

console.log(`\n=== Gauntlet (best = ${best.label}) ===`);
console.log(`  bars              ${best.r.length}`);
console.log(`  Sharpe/period     ${best.sh.toFixed(4)}`);
console.log(`  Sharpe annualized ${best.ann.toFixed(3)}`);
console.log(`  cum return        ${(best.cum * 100).toFixed(2)}%`);
console.log(`  PBO               ${pboVal.toFixed(3)}   (want < 0.30)`);
console.log(`  Deflated Sharpe   ${dsr.toFixed(3)}   (sr ${sr.toFixed(3)}, sr0 ${sr0.toFixed(3)}; want > 0.95)`);

// ---------------------------------------------------------------------------
// 7. SHUFFLE CONTROL — break the funding->forward-return link, keep the cross-section.
//    For each permutation we re-rank using a block-shuffled COPY of each coin's funding
//    series (shuffle the *day order* of funding values), then rebuild the long/short book.
//    A real cross-sectional funding edge should beat this null Sharpe distribution.
// ---------------------------------------------------------------------------
function shuffledFundingVariant(seed: number): number[] {
  const rng = lcgRng(seed);
  // build a per-coin shuffled funding map (block-shuffle the day->funding assignment)
  const shuffled: Coin[] = coins.map((c) => {
    const dayList = days.filter((d) => c.funding.has(d));
    const vals = dayList.map((d) => c.funding.get(d)!);
    const perm = blockShufflePermutation(vals.length, 5, rng); // 5-day blocks
    const permVals = applyPermutation(vals, perm);
    const fm: DayMap = new Map();
    dayList.forEach((d, idx) => fm.set(d, permVals[idx]));
    return { ...c, funding: fm };
  });
  // recompute best variant's returns against shuffled funding.
  const v = best.v;
  const rets: number[] = [];
  let prevW: Record<string, number> = {};
  for (let i = START_I; i < days.length - 1; i++) {
    const t = days[i], tNext = days[i + 1];
    const elig = shuffled
      .filter((c) => c.funding.has(t) && c.close.has(t) && c.close.has(tNext))
      .map((c) => {
        let sum = 0, n = 0;
        for (let kk = i - v.smooth + 1; kk <= i; kk++) {
          if (kk < 0) continue;
          const f = c.funding.get(days[kk]);
          if (f == null) continue;
          sum += f; n++;
        }
        return { c, s: n > 0 ? sum / n : null };
      })
      .filter((x): x is { c: Coin; s: number } => x.s != null);
    if (elig.length < MIN_COINS) { rets.push(0); prevW = {}; continue; }
    elig.sort((a, b) => a.s - b.s);
    const k = Math.max(1, Math.floor(elig.length * v.frac));
    const low = elig.slice(0, k), high = elig.slice(elig.length - k);
    const wMap: Record<string, number> = {};
    const wl = (v.sign * 1) / k, wh = (v.sign * -1) / k;
    let pr = 0;
    for (const { c } of low) { pr += wl * (c.close.get(tNext)! / c.close.get(t)! - 1); wMap[c.coin] = (wMap[c.coin] ?? 0) + wl; }
    for (const { c } of high) { pr += wh * (c.close.get(tNext)! / c.close.get(t)! - 1); wMap[c.coin] = (wMap[c.coin] ?? 0) + wh; }
    let turn = 0;
    for (const cc of new Set([...Object.keys(prevW), ...Object.keys(wMap)])) turn += Math.abs((wMap[cc] ?? 0) - (prevW[cc] ?? 0));
    rets.push(pr - turn * (10 / 1e4));
    prevW = wMap;
  }
  return rets.slice(0, L);
}

const N_PERM = 200;
const nullSharpes: number[] = [];
for (let p = 0; p < N_PERM; p++) nullSharpes.push(sharpe(shuffledFundingVariant(1000 + p)));
const perm = permutationTest(best.sh, nullSharpes, "greater");
console.log(`\n=== Shuffle control (${N_PERM} block-shuffled funding nulls) ===`);
const nMean = nullSharpes.reduce((a, x) => a + x, 0) / nullSharpes.length;
console.log(`  observed Sharpe/period ${best.sh.toFixed(4)}  (ann ${best.ann.toFixed(2)})`);
console.log(`  null mean ${nMean.toFixed(4)}  null p95 ${[...nullSharpes].sort((a, b) => a - b)[Math.floor(0.95 * N_PERM)].toFixed(4)}`);
console.log(`  permutation p-value ${perm.pValue.toFixed(4)}  (want < 0.05; exceed ${perm.exceed}/${perm.nNull})`);

// ---------------------------------------------------------------------------
// 8. Advisor — one-voice verdict. Market-neutral so beta is NOT attractive here.
// ---------------------------------------------------------------------------
const memo = adviseTrade({
  label: `xsection-funding-factor (${best.label})`,
  strategyReturns: best.r,
  benchmarkReturns: bench,
  pbo: pboVal,
  dsr,
  oosFrac: 0.3,
  betaAttractive: false, // cash benchmark; there is no basket to "just hold"
  search: { hypothesesScanned: variants.length, bonferroniSurvivors: dsr > 0.95 && pboVal < 0.3 ? 1 : 0 },
});
console.log(`\n${renderTradeMemo(memo)}`);

console.log(
  `\nROI_VERDICT=${memo.advice.roiVerdict} ADVISOR=${memo.recommendation} ANN_SHARPE=${best.ann.toFixed(3)} PBO=${pboVal.toFixed(3)} DSR=${dsr.toFixed(3)} PERM_P=${perm.pValue.toFixed(4)} BEST=${best.label} BARS=${best.r.length} COINS=${coins.length}`,
);
