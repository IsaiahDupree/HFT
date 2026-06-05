/**
 * _discover-funding-time-of-day — FUNDING SETTLEMENT SEASONALITY.
 *
 * Binance funds perps 3×/day at 00/08/16 UTC (8-hourly group) — a chunk of alts are 4-hourly
 * (00/04/08/12/16/20). Hypothesis: funding is systematically larger at one settlement slot, OR
 * the carry concentrates in one slot. If so, a TIMED delta-neutral carry that only harvests the
 * fat slot should beat harvesting ALL slots (better $/unit-of-risk).
 *
 * What this does, NO-LOOKAHEAD throughout:
 *   (1) Per-slot mean funding across the canonical 8-hourly universe (00/08/16) and, separately,
 *       the 4-hourly universe (00/04/08/12/16/20). Pure description of the seasonality.
 *   (2) TIMED CARRY: on a TRAIN window only, pick the slot with the fattest signed carry (the slot
 *       whose delta-neutral harvest |rate| is largest). Then OOS, run two delta-neutral carry books:
 *         - ALL slots  : harvest every interval's funding  (deltaNeutralCarryReturns over daily-summed funding)
 *         - FAT slot   : harvest only the train-chosen slot (deltaNeutralCarryReturns over that slot's funding)
 *       Equal-weight across coins into a daily portfolio for each book.
 *   (3) Gauntlet: ann.Sharpe(√365) + walk-forward OOS + PBO + Deflated-Sharpe, a block-shuffle
 *       permutation control on the slot-choice (does a RANDOM slot do as well as the "fat" one?),
 *       and the one-voice advisor verdict vs the ALL-slots carry as benchmark.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_discover-funding-time-of-day.ts
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
import { deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { lcgRng } from "../src/lib/backtest/shuffle-control.ts";
import { permutationTest } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const feeBps = arg("--fee-bps", 5);

const dir = resolve(process.cwd(), "data", "funding");
type Tick = { time: number; rate: number; hour: number };
function loadFunding(coin: string): Tick[] {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => { const d = JSON.parse(l) as { time: number; rate: number }; return { time: d.time, rate: d.rate, hour: new Date(d.time * 1000).getUTCHours() }; })
    .sort((a, b) => a.time - b.time);
}

const coins = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", ""))
  : [];
if (!coins.length) { console.log("\n  no data/funding/*.binance.jsonl\n"); process.exit(0); }

// ---- classify coins by their dominant cadence (slot set) ----
const data = new Map<string, Tick[]>();
for (const c of coins) { const t = loadFunding(c); if (t.length) data.set(c, t); }
function slotSet(ticks: Tick[]): number[] { return [...new Set(ticks.map((t) => t.hour))].sort((a, b) => a - b); }
const GROUP_8H = [0, 8, 16];
const GROUP_4H = [0, 4, 8, 12, 16, 20];
const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const coins8h = [...data.keys()].filter((c) => eq(slotSet(data.get(c)!), GROUP_8H));
const coins4h = [...data.keys()].filter((c) => eq(slotSet(data.get(c)!), GROUP_4H));

// =====================================================================================
// (1) PER-SLOT MEAN FUNDING — pure seasonality description
// =====================================================================================
function perSlotMeans(coinList: string[], slots: number[]) {
  // pool all ticks across coins, group by hour
  const byHour = new Map<number, number[]>(slots.map((h) => [h, []]));
  for (const c of coinList) for (const t of data.get(c)!) if (byHour.has(t.hour)) byHour.get(t.hour)!.push(t.rate);
  return slots.map((h) => { const v = byHour.get(h)!; return { hour: h, n: v.length, mean: v.length ? mean(v) : 0, meanAbs: v.length ? mean(v.map(Math.abs)) : 0, sd: v.length ? std(v) : 0 }; });
}
const slots8 = perSlotMeans(coins8h, GROUP_8H);
const slots4 = perSlotMeans(coins4h, GROUP_4H);

console.log(`\n=== FUNDING SETTLEMENT SEASONALITY ===`);
console.log(`8-hourly universe (00/08/16): ${coins8h.length} coins   |   4-hourly universe (00/04/08/12/16/20): ${coins4h.length} coins\n`);
console.log(`  --- 8-hourly per-slot funding (pooled across ${coins8h.length} coins) ---`);
console.log(`  ${"slot".padEnd(8)} ${"n".padEnd(7)} ${"mean rate".padEnd(13)} ${"mean|rate|".padEnd(13)} ${"sd".padEnd(11)} ann.carry%`);
for (const s of slots8) console.log(`  ${(s.hour + "h UTC").padEnd(8)} ${String(s.n).padEnd(7)} ${s.mean.toExponential(3).padEnd(13)} ${s.meanAbs.toExponential(3).padEnd(13)} ${s.sd.toExponential(2).padEnd(11)} ${(s.meanAbs * 365 * 100).toFixed(1)}%`);
const fat8 = slots8.reduce((a, b) => (b.meanAbs > a.meanAbs ? b : a));
const totalAbs8 = slots8.reduce((s, x) => s + x.meanAbs, 0);
console.log(`  fattest |rate| slot: ${fat8.hour}h UTC  (share of harvestable carry: ${((fat8.meanAbs / totalAbs8) * 100).toFixed(1)}% vs even 33.3%)`);

console.log(`\n  --- 4-hourly per-slot funding (pooled across ${coins4h.length} coins) ---`);
console.log(`  ${"slot".padEnd(8)} ${"n".padEnd(7)} ${"mean rate".padEnd(13)} ${"mean|rate|".padEnd(13)} ${"sd".padEnd(11)} ann.carry%`);
for (const s of slots4) console.log(`  ${(s.hour + "h UTC").padEnd(8)} ${String(s.n).padEnd(7)} ${s.mean.toExponential(3).padEnd(13)} ${s.meanAbs.toExponential(3).padEnd(13)} ${s.sd.toExponential(2).padEnd(11)} ${(s.meanAbs * 365 * 100).toFixed(1)}%`);
const fat4 = slots4.reduce((a, b) => (b.meanAbs > a.meanAbs ? b : a));
const totalAbs4 = slots4.reduce((s, x) => s + x.meanAbs, 0);
console.log(`  fattest |rate| slot: ${fat4.hour}h UTC  (share of harvestable carry: ${((fat4.meanAbs / totalAbs4) * 100).toFixed(1)}% vs even ${(100 / 6).toFixed(1)}%)`);

// =====================================================================================
// (2) TIMED DELTA-NEUTRAL CARRY — fat slot (train-chosen, NO-LOOKAHEAD) vs all slots
//     We work on the 8-hourly universe (the canonical 00/08/16 settlement) — the cleanest test.
// =====================================================================================
// Build per-coin daily-aligned funding-by-slot. A "day" = a UTC date. For each coin and day we
// store the rate at each of its 3 slots (undefined if missing). The ALL-slots carry harvests the
// sum of that day's slots; the FAT-slot carry harvests only the chosen slot. Both via
// deltaNeutralCarryReturns so fees/turnover are modeled identically.
type DayRow = { day: number; bySlot: Map<number, number> };
function dailyBySlot(ticks: Tick[], slots: number[]): DayRow[] {
  const m = new Map<number, Map<number, number>>();
  for (const t of ticks) {
    if (!slots.includes(t.hour)) continue;
    const day = Math.floor(t.time / DAY) * DAY;
    if (!m.has(day)) m.set(day, new Map());
    m.get(day)!.set(t.hour, t.rate);
  }
  return [...m.entries()].map(([day, bySlot]) => ({ day, bySlot })).sort((a, b) => a.day - b.day);
}

const ANN = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;

// per coin: daily series of (allSlotsSum, perSlotRate[slot])
type CoinCarry = { coin: string; days: number[]; allSum: Array<number | undefined>; bySlot: Map<number, Array<number | undefined>> };
const carries: CoinCarry[] = [];
for (const coin of coins8h) {
  const rows = dailyBySlot(data.get(coin)!, GROUP_8H);
  if (rows.length < 90) continue;
  const days = rows.map((r) => r.day);
  const allSum = rows.map((r) => { let s = 0, n = 0; for (const h of GROUP_8H) if (r.bySlot.has(h)) { s += r.bySlot.get(h)!; n++; } return n ? s : undefined; });
  const bySlot = new Map<number, Array<number | undefined>>();
  for (const h of GROUP_8H) bySlot.set(h, rows.map((r) => (r.bySlot.has(h) ? r.bySlot.get(h)! : undefined)));
  carries.push({ coin, days, allSum, bySlot });
}
console.log(`\n  timed-carry universe: ${carries.length} coins with >=90 days of 8-hourly funding`);

// Union calendar across coins so we can equal-weight per day.
const allDays = [...new Set(carries.flatMap((c) => c.days))].sort((a, b) => a - b);
const dayIdx = new Map(allDays.map((d, i) => [d, i]));
const T = allDays.length;
const split = Math.floor(T * 0.6); // 60% train (pick fat slot), 40% OOS
const trainDays = new Set(allDays.slice(0, split));

// Choose the FAT slot on TRAIN only: the slot with the largest mean |rate| pooled across coins.
function fatSlotFromTrain(): number {
  const acc = new Map<number, number[]>(GROUP_8H.map((h) => [h, []]));
  for (const c of carries) c.days.forEach((d, i) => {
    if (!trainDays.has(d)) return;
    for (const h of GROUP_8H) { const v = c.bySlot.get(h)![i]; if (v != null) acc.get(h)!.push(Math.abs(v)); }
  });
  let best = GROUP_8H[0], bestVal = -Infinity;
  for (const h of GROUP_8H) { const v = acc.get(h)!.length ? mean(acc.get(h)!) : 0; if (v > bestVal) { bestVal = v; best = h; } }
  return best;
}
const fatSlot = fatSlotFromTrain();
console.log(`  TRAIN-chosen fat slot (mean|rate| over first ${split} days): ${fatSlot}h UTC`);

// Build a delta-neutral carry book per coin for ALL slots and for a SINGLE slot, then equal-weight.
// deltaNeutralCarryReturns takes a per-interval funding stream; here each "interval" is a day.
// ALL: feed the day's summed rate (3 settlements harvested). SINGLE: feed only that slot's rate.
function carryBook(pick: (c: CoinCarry) => Array<number | undefined>): number[] {
  // per coin daily carry returns, aligned to union calendar, equal-weighted
  const perCoinRet = carries.map((c) => {
    const ret = deltaNeutralCarryReturns(pick(c), { minFunding: 0, feeBps });
    return { days: c.days, ret };
  });
  const out = new Array(T).fill(0).map(() => ({ s: 0, n: 0 }));
  perCoinRet.forEach(({ days, ret }) => days.forEach((d, i) => { const k = dayIdx.get(d)!; out[k].s += ret[i]; out[k].n++; }));
  return out.map((o) => (o.n ? o.s / o.n : 0));
}
const allCarry = carryBook((c) => c.allSum);
const fatCarry = carryBook((c) => c.bySlot.get(fatSlot)!);

// Walk-forward: compute everything full + OOS (post-split).
function report(label: string, r: number[]) {
  const full = ANN(sharpe(r)); const oos = ANN(sharpe(r.slice(split)));
  return { label, full, oos, cum: cum(r) * 100, r };
}
const rAll = report("ALL slots", allCarry);
const rFat = report(`FAT slot (${fatSlot}h)`, fatCarry);

console.log(`\n  --- TIMED CARRY (delta-neutral, ${feeBps}bps/turn, equal-weight ${carries.length} coins, ${T} days) ---`);
console.log(`  ${"book".padEnd(16)} ${"ann.Sharpe".padEnd(12)} ${"OOS-Sharpe".padEnd(13)} cum`);
for (const x of [rAll, rFat]) console.log(`  ${x.label.padEnd(16)} ${x.full.toFixed(2).padEnd(12)} ${`${x.oos.toFixed(2)}${x.oos > 0 ? " ✓" : " ✗"}`.padEnd(13)} ${(x.cum >= 0 ? "+" : "")}${x.cum.toFixed(1)}%`);
console.log(`  timed improvement (FAT full Sharpe − ALL full Sharpe): ${(rFat.full - rAll.full).toFixed(2)}`);

// =====================================================================================
// (3) GAUNTLET + CONTROL
//   PBO + DSR across the slot-choice variants (each single slot is a config + the all-slots book).
//   Permutation control: is the FAT slot's carry-Sharpe special vs a RANDOM slot choice?
// =====================================================================================
const slotBooks = GROUP_8H.map((h) => ({ h, r: carryBook((c) => c.bySlot.get(h)!) }));
const variantSeries = [allCarry, ...slotBooks.map((b) => b.r)];
const variantSharpes = variantSeries.map((r) => sharpe(r));
const bestIdx = variantSharpes.reduce((bi, x, i) => (x > variantSharpes[bi] ? i : bi), 0);
const M: number[][] = Array.from({ length: T }, (_, i) => variantSeries.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(variantSeries[bestIdx], variantSharpes).dsr;

// PERMUTATION CONTROL: the "edge" claim is "the FAT slot beats the others". Null = slot choice is
// random. Compare observed (full-sample Sharpe of the fat-slot carry) vs the distribution of Sharpes
// from EACH slot — i.e. is the fat slot's Sharpe an outlier among the 3 slots? With only 3 slots a
// direct test is weak, so we also block-shuffle which slot each DAY's harvest is drawn from to build
// a proper null of "no slot is special".
const rng = lcgRng(20260604);
const nullSharpes: number[] = [];
const N_PERM = 500;
// each permutation: pick a random slot per coin (could differ by coin) → carry book → Sharpe
for (let p = 0; p < N_PERM; p++) {
  const series = carryBook((c) => { const h = GROUP_8H[Math.floor(rng() * GROUP_8H.length)]; return c.bySlot.get(h)!; });
  nullSharpes.push(sharpe(series));
}
const obsFatSharpe = sharpe(fatCarry);
const perm = permutationTest(obsFatSharpe, nullSharpes, "greater");

console.log(`\n  --- GAUNTLET ---`);
console.log(`  best variant: ${bestIdx === 0 ? "ALL slots" : `${GROUP_8H[bestIdx - 1]}h slot`} (Sharpe ${variantSharpes[bestIdx].toFixed(3)})`);
console.log(`  PBO ${PBO.toFixed(2)} (overfit if >=0.5)   DSR ${dsr.toFixed(2)} (clean if >0.5)`);
console.log(`  permutation control (fat-slot Sharpe ${obsFatSharpe.toFixed(3)} vs ${N_PERM} random-slot draws): p=${perm.pValue.toFixed(3)}  null-mean=${mean(nullSharpes).toFixed(3)}`);
console.log(`    → ${perm.pValue < 0.05 ? "fat slot is a SIGNIFICANT outlier" : "fat slot is NOT special — random slot does about as well"}`);

// =====================================================================================
// ADVISOR — one voice. Benchmark = ALL-slots carry (does timing the fat slot ADD over harvesting all?)
// =====================================================================================
const betaSh = ANN(sharpe(allCarry));
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `timed funding carry (fat slot ${fatSlot}h vs all slots)`,
  strategyReturns: fatCarry,
  benchmarkReturns: allCarry,
  pbo: PBO, dsr, oosFrac: 0.4,
  search: { hypothesesScanned: GROUP_8H.length, bonferroniSurvivors: perm.pValue < 0.05 / GROUP_8H.length ? 1 : 0 },
  betaAttractive: betaSh > 0.5,
})) + "\n");

// machine-readable summary line
console.log(`SUMMARY annSharpe_fat=${rFat.full.toFixed(3)} annSharpe_all=${rAll.full.toFixed(3)} oos_fat=${rFat.oos.toFixed(3)} pbo=${PBO.toFixed(2)} dsr=${dsr.toFixed(2)} perm_p=${perm.pValue.toFixed(3)} fatSlot=${fatSlot}h coins=${carries.length} days=${T}`);
