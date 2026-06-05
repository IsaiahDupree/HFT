/**
 * _carry-xsection-funding-carry — CROSS-SECTIONAL FUNDING CARRY (market-neutral funding HARVEST).
 *
 * EDGE: funding rates differ ACROSS perps. Each day SHORT the top-funding-tercile perps (collect
 * their high funding) and LONG the bottom-funding-tercile perps (pay their low/negative funding),
 * notional-balanced so the book is delta-neutral. Because the long and short baskets are equal
 * notional, the directional price legs roughly CANCEL across the cross-section — what remains is
 * the funding DISPERSION harvested as income: mean(funding of shorts collected) − mean(funding of
 * longs paid), minus turnover when the tercile membership rotates. This is income (carry), distinct
 * from the rejected PRICE factor (betting high-funding coins fall) and distinct from the existing
 * per-coin |funding| harvest (which trades each coin against its own spot leg). Benchmark = CASH.
 *
 * DATA: data/funding/<COIN>.binance.jsonl = {time(sec), rate} for 40 coins. Coins fund 8-hourly
 * (BTC, 3/day) OR 4-hourly (WIF/ENA/NEIRO, 6/day) — so funding is aggregated into a DAILY TOTAL per
 * coin (sum of the day's intervals) before any cross-sectional ranking, putting all coins on equal
 * footing. ~500 days (2025-01-21 → 2026-06).
 *
 * MODEL (NO-LOOKAHEAD): on day d, rank coins by the funding signal OBSERVED over day d (the daily
 * total funding realized on day d, known at the d-close); form short(top tercile)/long(bottom
 * tercile) baskets; HOLD that book over day d+1 and realize the funding that ACCRUES on day d+1.
 *   leg pnl (per unit notional): short a coin collects +funding_{d+1}; long a coin pays it
 *   (i.e. earns −funding_{d+1}). Equal-weight within each basket, equal notional short vs long.
 *   net_{d+1} = mean_{c in SHORT} funding_{c,d+1}  −  mean_{c in LONG} funding_{c,d+1}  −  fee·turnover
 * Turnover = fraction of basket notional that changed legs between d and d+1 (a coin that stays in
 * the same basket pays nothing; entering/leaving/flipping is charged feeBps on both perp legs that
 * moved). A coin is eligible on a day only if it has BOTH a signal (day d) and a realized funding
 * (day d+1). Price legs are assumed to cancel in the notional-balanced cross-section (the model's
 * main omission is cross-sectional residual beta + the spot-hedge basis; reported honestly).
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_carry-xsection-funding-carry.ts
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const ANN = Math.sqrt(365);
const flagS = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlyCoins = flagS("--coins")?.split(",").map((s) => s.trim().toUpperCase());

const dir = resolve(process.cwd(), "data", "funding");
const coins = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [])
  .filter((c) => !onlyCoins || onlyCoins.includes(c.toUpperCase()));
if (!coins.length) { console.log("\n  no data/funding/*.binance.jsonl — run: npm run fetch:funding:binance\n"); process.exit(0); }

function loadFunding(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { time: number; rate: number }).sort((a, b) => a.time - b.time);
}

/** Daily TOTAL funding per coin: sum every interval whose timestamp falls in UTC day d → Map(dayUnix→sum). */
function dailyTotalFunding(fund: Array<{ time: number; rate: number }>): Map<number, number> {
  const byDay = new Map<number, number>();
  for (const r of fund) {
    const d = Math.floor(r.time / DAY) * DAY;
    byDay.set(d, (byDay.get(d) ?? 0) + r.rate);
  }
  return byDay;
}

// Build the panel: coin → Map(day → dailyFunding). Then the sorted union of days.
const panel = new Map<string, Map<number, number>>();
for (const c of coins) panel.set(c, dailyTotalFunding(loadFunding(c)));
const daySet = new Set<number>();
for (const m of panel.values()) for (const d of m.keys()) daySet.add(d);
const days = [...daySet].sort((a, b) => a - b);

console.log(`\n  CROSS-SECTIONAL FUNDING CARRY — ${coins.length} coins, ${days.length} days ` +
  `(${new Date(days[0] * 1000).toISOString().slice(0, 10)} → ${new Date(days.at(-1)! * 1000).toISOString().slice(0, 10)})`);

// Quick dispersion sanity: average cross-sectional spread (top-tercile − bottom-tercile daily funding).
let spreadSum = 0, spreadN = 0;
for (const d of days) {
  const vals = coins.map((c) => panel.get(c)!.get(d)).filter((x): x is number => x != null);
  if (vals.length < 6) continue;
  vals.sort((a, b) => a - b);
  const k = Math.floor(vals.length / 3);
  const lo = vals.slice(0, k), hi = vals.slice(vals.length - k);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  spreadSum += mean(hi) - mean(lo); spreadN++;
}
console.log(`  avg daily tercile funding spread (top − bottom): ${(spreadSum / spreadN * 1e4).toFixed(2)} bps/day ` +
  `≈ ${(spreadSum / spreadN * 365 * 100).toFixed(1)}% annualized gross\n`);

/**
 * Build the cross-sectional carry return series for one variant.
 * @param frac      tercile fraction (1/3 = terciles; 1/5 = quintiles, etc.)
 * @param feeBps    per-leg fee charged on basket-notional turnover
 * @param minCoins  require at least this many coins with data on a day to trade it
 * @param signalLag use funding observed on day d as the signal (lag 0 = the same day we realize over d+1)
 * @param holdDays  rebalance only every `holdDays` days (reduces turnover); membership persists in between
 */
function xsectionCarry(frac: number, feeBps: number, minCoins: number, holdDays: number): number[] {
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const rets: number[] = [];
  // weights[coin] = signed notional weight on the perp leg: + = SHORT perp (collect funding), − = LONG perp (pay funding).
  // We track the previous day's weights to compute turnover.
  let prevW = new Map<string, number>();
  let curW = new Map<string, number>(); // current target book (only re-formed every holdDays)
  for (let t = 0; t < days.length - 1; t++) {
    const dSig = days[t];      // signal day (funding observed over dSig, known at close)
    const dReal = days[t + 1]; // realize the book's funding over the NEXT day

    // (Re)form the book on a rebalance day; otherwise keep curW (still must be tradable next day).
    if (t % holdDays === 0) {
      const elig = coins
        .map((c) => ({ c, sig: panel.get(c)!.get(dSig) }))
        .filter((x): x is { c: string; sig: number } => x.sig != null);
      const nextW = new Map<string, number>();
      if (elig.length >= minCoins) {
        elig.sort((a, b) => a.sig - b.sig);
        const k = Math.max(1, Math.floor(elig.length * frac));
        const longBasket = elig.slice(0, k).map((x) => x.c);   // lowest funding → LONG perp (pay it)
        const shortBasket = elig.slice(elig.length - k).map((x) => x.c); // highest funding → SHORT perp (collect)
        // equal-weight within each basket, normalized so |short notional| = |long notional| = 1.
        for (const c of shortBasket) nextW.set(c, +1 / shortBasket.length); // SHORT perp: +funding
        for (const c of longBasket) nextW.set(c, -1 / longBasket.length);   // LONG perp: −funding
      }
      curW = nextW;
    }

    // Realize: net funding accrued over dReal on the held book. A coin contributes only if it has a
    // realized funding on dReal; if it's missing, that leg simply earns 0 that day (no lookahead — we
    // just don't get the cash). Use the book formed at/under dSig (curW), held into dReal.
    let income = 0;
    for (const [c, w] of curW) {
      const f = panel.get(c)!.get(dReal);
      if (f != null) income += w * f; // SHORT (w>0) collects +f; LONG (w<0) earns −f
    }

    // Turnover fee: sum |w_new − w_old| over the union of coins, ×feeBps (each unit of notional that
    // changes legs is a perp trade). Charged on the rebalance transition (curW vs prevW).
    let turnover = 0;
    const union = new Set<string>([...curW.keys(), ...prevW.keys()]);
    for (const c of union) turnover += Math.abs((curW.get(c) ?? 0) - (prevW.get(c) ?? 0));
    const fee = turnover * (feeBps / 1e4);

    rets.push(income - fee);
    prevW = curW;
  }
  return rets;
}

// ---- VARIANT GRID (the search we correct for via DSR/PBO) ----
const VARIANTS: Array<{ label: string; frac: number; fee: number; hold: number }> = [
  { label: "tercile@1bp/1d", frac: 1 / 3, fee: 1, hold: 1 },
  { label: "tercile@3bp/1d", frac: 1 / 3, fee: 3, hold: 1 },
  { label: "tercile@5bp/1d", frac: 1 / 3, fee: 5, hold: 1 },
  { label: "tercile@5bp/3d", frac: 1 / 3, fee: 5, hold: 3 },
  { label: "tercile@10bp/3d", frac: 1 / 3, fee: 10, hold: 3 },
  { label: "quintile@5bp/1d", frac: 1 / 5, fee: 5, hold: 1 },
  { label: "quintile@10bp/3d", frac: 1 / 5, fee: 10, hold: 3 },
  { label: "decile@10bp/3d", frac: 1 / 10, fee: 10, hold: 3 },
];
const MIN_COINS = 6;

const series = VARIANTS.map((v) => ({ v, r: xsectionCarry(v.frac, v.fee, MIN_COINS, v.hold) }));

// Per-variant stats table.
console.log("  variant            bars    dailyMean(bps)  annRet%   annSharpe   per-bar Sharpe");
const rows = series.map(({ v, r }) => {
  const dm = r.reduce((s, x) => s + x, 0) / r.length;
  const annRet = dm * 365 * 100;
  const sh = sharpe(r);
  const annSh = sh * ANN;
  console.log(`  ${v.label.padEnd(18)} ${String(r.length).padStart(4)}    ${(dm * 1e4).toFixed(2).padStart(10)}   ${annRet.toFixed(1).padStart(6)}   ${annSh.toFixed(2).padStart(7)}    ${sh.toFixed(4).padStart(8)}`);
  return { v, r, dm, annRet, sh, annSh };
});

// ---- TURNOVER + CARRY-SIGNATURE diagnostic on the realistic-fee variant ----
// Re-run the tercile book WITHOUT fees and measure: (a) avg daily turnover (basket notional that
// rotates), (b) gross income. A carry's signature: gross income ≈ the funding spread we harvest,
// and the fee drag = turnover × feeBps. This proves the return is FUNDING, not a hidden price bet.
function turnoverAndGross(frac: number, minCoins: number, holdDays: number): { avgTurnover: number; grossDailyBps: number } {
  let prevW = new Map<string, number>(), curW = new Map<string, number>();
  let turnSum = 0, turnN = 0, grossSum = 0, grossN = 0;
  for (let t = 0; t < days.length - 1; t++) {
    const dSig = days[t], dReal = days[t + 1];
    if (t % holdDays === 0) {
      const elig = coins.map((c) => ({ c, sig: panel.get(c)!.get(dSig) })).filter((x): x is { c: string; sig: number } => x.sig != null);
      const nextW = new Map<string, number>();
      if (elig.length >= minCoins) {
        elig.sort((a, b) => a.sig - b.sig);
        const k = Math.max(1, Math.floor(elig.length * frac));
        for (const c of elig.slice(elig.length - k).map((x) => x.c)) nextW.set(c, +1 / k);
        for (const c of elig.slice(0, k).map((x) => x.c)) nextW.set(c, -1 / k);
      }
      curW = nextW;
    }
    let income = 0;
    for (const [c, w] of curW) { const f = panel.get(c)!.get(dReal); if (f != null) income += w * f; }
    grossSum += income; grossN++;
    let turnover = 0; const union = new Set<string>([...curW.keys(), ...prevW.keys()]);
    for (const c of union) turnover += Math.abs((curW.get(c) ?? 0) - (prevW.get(c) ?? 0));
    turnSum += turnover; turnN++;
    prevW = curW;
  }
  return { avgTurnover: turnSum / turnN, grossDailyBps: (grossSum / grossN) * 1e4 };
}
console.log("  turnover + gross (no-fee) by config:");
for (const v of VARIANTS) {
  const t = turnoverAndGross(v.frac, MIN_COINS, v.hold);
  // break-even fee = grossDailyBps / avgTurnover (bps of fee per leg that wipes the gross income)
  const beFee = t.avgTurnover > 0 ? t.grossDailyBps / t.avgTurnover : Infinity;
  console.log(`  ${v.label.padEnd(18)} avgTurnover ${t.avgTurnover.toFixed(3)}  grossIncome ${t.grossDailyBps.toFixed(2)} bps/day  break-even fee ${beFee.toFixed(1)} bps/leg`);
}
console.log("");

// ---- GAUNTLET on the best per-bar-Sharpe variant ----
const best = rows.reduce((b, x) => (x.sh > b.sh ? x : b), rows[0]);
const trialSharpes = rows.map((x) => x.sh);
const { dsr, sr0 } = deflatedSharpe(best.r, trialSharpes);

// PBO: matrix M[t][c] = variant c's return at bar t (align to the shortest series).
const minLen = Math.min(...series.map((s) => s.r.length));
const M: number[][] = [];
for (let t = 0; t < minLen; t++) M.push(series.map((s) => s.r[t]));
const pboVal = pbo(M, 8);

// ---- CONTROL: scramble the cross-sectional ranks (shuffle which coin is which each day). If the
// edge is real funding DISPERSION, assigning the book to RANDOM coins should kill it (income → ~0). ----
function shuffledControl(frac: number, feeBps: number, minCoins: number, holdDays: number, seed: number): number[] {
  let s = (seed >>> 0) || 1;
  const rng = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
  const mean = (a: number[]) => (a.length ? a.reduce((sm, x) => sm + x, 0) / a.length : 0);
  const rets: number[] = [];
  let prevW = new Map<string, number>(), curW = new Map<string, number>();
  for (let t = 0; t < days.length - 1; t++) {
    const dSig = days[t], dReal = days[t + 1];
    if (t % holdDays === 0) {
      const elig = coins.filter((c) => panel.get(c)!.get(dSig) != null);
      const nextW = new Map<string, number>();
      if (elig.length >= minCoins) {
        // shuffle eligible coins → assign top/bottom baskets at RANDOM (destroys the funding-rank signal).
        const sh = [...elig];
        for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
        const k = Math.max(1, Math.floor(sh.length * frac));
        const shortB = sh.slice(0, k), longB = sh.slice(sh.length - k);
        for (const c of shortB) nextW.set(c, +1 / shortB.length);
        for (const c of longB) nextW.set(c, -1 / longB.length);
      }
      curW = nextW;
    }
    let income = 0;
    for (const [c, w] of curW) { const f = panel.get(c)!.get(dReal); if (f != null) income += w * f; }
    let turnover = 0; const union = new Set<string>([...curW.keys(), ...prevW.keys()]);
    for (const c of union) turnover += Math.abs((curW.get(c) ?? 0) - (prevW.get(c) ?? 0));
    rets.push(income - turnover * (feeBps / 1e4));
    prevW = curW;
  }
  return rets;
}
const nCtrl = 200;
const ctrlSharpes: number[] = [];
let ctrlMeanSum = 0;
for (let i = 0; i < nCtrl; i++) {
  const r = shuffledControl(best.v.frac, best.v.fee, MIN_COINS, best.v.hold, 12345 + i * 7);
  ctrlSharpes.push(sharpe(r) * ANN);
  ctrlMeanSum += r.reduce((s, x) => s + x, 0) / r.length;
}
ctrlSharpes.sort((a, b) => a - b);
const ctrlMeanAnnRet = (ctrlMeanSum / nCtrl) * 365 * 100;
const ctrlP95 = ctrlSharpes[Math.floor(0.95 * nCtrl)];
const exceed = ctrlSharpes.filter((x) => x >= best.annSh).length;
const ctrlPval = (1 + exceed) / (1 + nCtrl);

console.log(`\n  ── GAUNTLET (best = ${best.v.label}) ──`);
console.log(`  ann Sharpe        : ${best.annSh.toFixed(2)}   (per-bar ${best.sh.toFixed(4)})`);
console.log(`  ann return        : ${best.annRet.toFixed(1)}%   (daily mean ${(best.dm * 1e4).toFixed(2)} bps)`);
console.log(`  DSR (vs ${VARIANTS.length} trials) : ${dsr.toFixed(3)}   (SR0 ${sr0.toFixed(4)})`);
console.log(`  PBO (8 blocks)    : ${pboVal.toFixed(3)}`);
console.log(`  RANK-SHUFFLE CTRL : mean annRet ${ctrlMeanAnnRet.toFixed(2)}%  | annSharpe p95 ${ctrlP95.toFixed(2)}  | p(ctrl≥obs)=${ctrlPval.toFixed(3)}`);

// ---- REALISTIC-FEE GAUNTLET: re-judge the fee-honest, low-turnover variant on its OWN merits, so
// the verdict doesn't ride on the optimistic 1bp config. Pick the best variant whose break-even fee
// exceeds a punitive 10 bps/leg (i.e. it survives illiquid-alt taker costs by a real margin). ----
const ROBUST_FEE = 10;
const robustCands = rows.filter((x) => {
  const t = turnoverAndGross(x.v.frac, MIN_COINS, x.v.hold);
  const be = t.avgTurnover > 0 ? t.grossDailyBps / t.avgTurnover : Infinity;
  return x.v.fee >= ROBUST_FEE && be >= 2 * ROBUST_FEE; // 2× margin over the 10bp fee
});
const robust = robustCands.reduce((b, x) => (x.sh > b.sh ? x : b), robustCands[0] ?? best);
{
  const half = Math.floor(robust.r.length / 2);
  const sh1 = sharpe(robust.r.slice(0, half)) * ANN, sh2 = sharpe(robust.r.slice(half)) * ANN;
  const { dsr: rDsr } = deflatedSharpe(robust.r, trialSharpes);
  console.log(`  ── ROBUST (fee-honest) candidate = ${robust.v.label} ──`);
  console.log(`  ann Sharpe ${robust.annSh.toFixed(2)} | annRet ${robust.annRet.toFixed(1)}% | DSR ${rDsr.toFixed(3)} | OOS halves Sharpe ${sh1.toFixed(2)} / ${sh2.toFixed(2)}\n`);
}

// ---- ADVISOR (benchmark = CASH, a market-neutral carry) ----
const benchmark = new Array(best.r.length).fill(0);
const memo = adviseTrade({
  label: `xsection-funding-carry ${best.v.label}`,
  strategyReturns: best.r,
  benchmarkReturns: benchmark,
  pbo: pboVal,
  dsr,
  oosFrac: 0.4,
  betaAttractive: false, // cash benchmark — there is no "beta basket" to fall back on
  search: { hypothesesScanned: VARIANTS.length, bonferroniSurvivors: dsr > 0.95 ? 1 : 0 },
});
console.log("\n" + renderTradeMemo(memo) + "\n");

// machine-readable summary line
console.log(`RESULT_JSON ${JSON.stringify({
  bestVariant: best.v.label, bars: best.r.length,
  annSharpe: +best.annSh.toFixed(2), annReturnPct: +best.annRet.toFixed(1),
  dailyMeanBps: +(best.dm * 1e4).toFixed(2), dsr: +dsr.toFixed(3), pbo: +pboVal.toFixed(3),
  ctrlMeanAnnRetPct: +ctrlMeanAnnRet.toFixed(2), ctrlAnnSharpeP95: +ctrlP95.toFixed(2), ctrlPval: +ctrlPval.toFixed(3),
  avgSpreadBpsPerDay: +(spreadSum / spreadN * 1e4).toFixed(2), recommendation: memo.recommendation, conviction: memo.conviction,
})}`);
