/**
 * _carry-interexchange-funding-carry — INTER-EXCHANGE FUNDING CARRY (Binance − OKX).
 *
 * Same shape as backtest-funding-xvenue (Binance − Hyperliquid) but the SECOND venue is OKX.
 * The funding DIFFERENCE between two perp venues for the same coin is collectable delta-neutral:
 * short the higher-funding perp + long the lower-funding perp → collect |Δfunding| per interval,
 * price-neutral (both perps track the same USDT-margined spot). Residual risk = the perp-vs-perp
 * basis (tighter than perp-vs-spot). This is genuine CARRY: realized return ≈ the structural
 * funding spread we observed, not a price bet.
 *
 * DATA:
 *   - Binance funding: data/funding/<COIN>.binance.jsonl = {time(sec),rate} 8-hourly (already on disk).
 *   - OKX funding: fetched here via direct fetch (OKX is NOT geo-blocked from US; Binance proxy not
 *     needed). https://www.okx.com/api/v5/public/funding-rate-history?instId=<C>-USDT-SWAP&limit=100
 *     paginated with after=<oldest fundingTime ms> to walk backwards. Cached to data/funding/<C>.okx.jsonl.
 *
 * NO-LOOKAHEAD: both venues aligned to UTC-day funding sums; spread[i] = binance[i] − okx[i] is
 * known at day i; deltaNeutralCarryReturns takes position from spread[i], realizes the harvest over
 * day i→i+1 (it pushes collect[i] − fee, reads only spread ≤ i). Annualize Sharpe sqrt(365).
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_carry-interexchange-funding-carry.ts
 *   flags: --fee-bps N (per-leg taker fee, default 3) · --refetch (ignore cache)
 */
import "./_env.ts";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const has = (n: string): boolean => process.argv.includes(n);
const feeBps = arg("--fee-bps", 3); // per perp leg; cross-venue entry = 2 legs (one per venue)
const refetch = has("--refetch");
const dir = resolve(process.cwd(), "data", "funding");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- OKX funding fetch (direct; paginate backwards via after=<oldest ms>) ----
type OkxRow = { time: number; rate: number }; // time in SECONDS, rate per 8h
async function fetchOkxFunding(coin: string, sinceSec: number): Promise<OkxRow[]> {
  const inst = `${coin}-USDT-SWAP`;
  const out: OkxRow[] = [];
  let after: number | undefined = undefined; // ms cursor; rows OLDER than this
  let pages = 0;
  while (pages < 60) { // 60 pages * 100 = 6000 rows = ~5.5 years of 8h funding — plenty
    const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100${after ? `&after=${after}` : ""}`;
    let json: any;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      json = await res.json();
    } catch (e) {
      throw new Error(`OKX fetch failed for ${inst}: ${(e as Error).message}`);
    }
    if (json?.code !== "0" || !Array.isArray(json.data) || json.data.length === 0) break;
    for (const r of json.data) {
      const ms = Number(r.fundingTime);
      const rate = Number(r.realizedRate ?? r.fundingRate);
      if (Number.isFinite(ms) && Number.isFinite(rate)) out.push({ time: Math.floor(ms / 1000), rate });
    }
    const oldestMs = Math.min(...json.data.map((r: any) => Number(r.fundingTime)));
    after = oldestMs; // next page: older than this
    pages++;
    if (Math.floor(oldestMs / 1000) <= sinceSec) break; // reached our window
    await sleep(120); // be polite to OKX
  }
  // dedup + sort ascending
  const m = new Map<number, number>();
  for (const r of out) m.set(r.time, r.rate);
  return [...m.entries()].map(([time, rate]) => ({ time, rate })).sort((a, b) => a.time - b.time);
}

async function loadOkxCached(coin: string, sinceSec: number): Promise<OkxRow[]> {
  const path = resolve(dir, `${coin}.okx.jsonl`);
  if (!refetch && existsSync(path)) {
    const rows = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as OkxRow);
    if (rows.length > 200 && rows[0].time <= sinceSec + 7 * DAY) return rows; // cache covers our window
  }
  const rows = await fetchOkxFunding(coin, sinceSec);
  if (rows.length) writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

// ---- Binance funding (on disk) ----
const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
function loadBinance(coin: string): Array<{ time: number; rate: number }> {
  return lines(resolve(dir, `${coin}.binance.jsonl`)).map((l) => JSON.parse(l) as { time: number; rate: number });
}
function dailySum(rows: Array<{ time: number; rate: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) { const d = Math.floor(r.time / DAY) * DAY; m.set(d, (m.get(d) ?? 0) + r.rate); }
  return m;
}

// coins with Binance funding on disk
const binanceCoins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
// liquid majors that reliably exist on OKX (skip exotic Binance-only listings)
const OKX_CANDIDATES = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "AVAX", "LINK", "DOT", "TRX", "WIF", "ENA", "PYTH", "TIA", "STRK", "ORDI", "SEI", "JUP", "PEOPLE", "1000PEPE"];
const coins = binanceCoins.filter((c) => OKX_CANDIDATES.includes(c));

console.log(`\nfetching OKX funding for ${coins.length} coins (cached to data/funding/<C>.okx.jsonl)...`);

const VARIANTS = [
  { label: ">0@3bp", minF: 0, fee: 3 },
  { label: ">1bp@3bp", minF: 0.0001, fee: 3 },
  { label: ">2bp@3bp", minF: 0.0002, fee: 3 },
  { label: ">2bp@1bp", minF: 0.0002, fee: 1 },
  { label: ">3bp@3bp", minF: 0.0003, fee: 3 },
];

type PerCoin = { coin: string; days: number[]; spread: number[]; byV: Record<string, Map<number, number>>; absMeanBps: number; n: number };
const perCoin: PerCoin[] = [];
let dataAvailable = false;

for (const coin of coins) {
  const binRows = loadBinance(coin);
  if (!binRows.length) continue;
  const sinceSec = binRows[0].time;
  let okxRows: OkxRow[];
  try {
    okxRows = await loadOkxCached(coin, sinceSec);
  } catch (e) {
    console.log(`  ${coin}: OKX fetch error — ${(e as Error).message}`);
    continue;
  }
  if (okxRows.length < 100) { console.log(`  ${coin}: OKX too few rows (${okxRows.length}) — skip`); continue; }
  dataAvailable = true;
  const binD = dailySum(binRows), okxD = dailySum(okxRows);
  const days = [...binD.keys()].filter((d) => okxD.has(d)).sort((a, b) => a - b);
  if (days.length <= 30) { console.log(`  ${coin}: only ${days.length} overlapping days — skip`); continue; }
  const spread = days.map((d) => binD.get(d)! - okxD.get(d)!); // Binance − OKX daily funding
  const byV: Record<string, Map<number, number>> = {};
  for (const v of VARIANTS) {
    const ret = deltaNeutralCarryReturns(spread, { minFunding: v.minF, feeBps: v.fee });
    byV[v.label] = new Map(days.slice(0, -1).map((d, i) => [d, ret[i]]));
  }
  const absMean = spread.reduce((a, x) => a + Math.abs(x), 0) / Math.max(1, spread.length);
  perCoin.push({ coin, days, spread, byV, absMeanBps: absMean * 1e4, n: days.length });
  console.log(`  ${coin.padEnd(9)} okx=${okxRows.length} rows · ${days.length} overlap days · |spread| ${(absMean * 1e4).toFixed(2)}bp/day`);
}

if (!dataAvailable) {
  console.log("\n  DATA_UNAVAILABLE: OKX funding history unreachable for all coins.\n");
  process.exit(0);
}
if (!perCoin.length) {
  console.log("\n  no coins with ≥30 overlapping funding days\n");
  process.exit(0);
}

// ---- portfolio (equal-weight across coins, same as xvenue) ----
const allDays = [...new Set(perCoin.flatMap((p) => p.days.slice(0, -1)))].sort((a, b) => a - b);
function portfolio(label: string): number[] {
  return allDays.map((d) => { let s = 0, c = 0; for (const p of perCoin) { const r = p.byV[label].get(d); if (r != null) { s += r; c++; } } return c ? s / c : 0; });
}
const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const series = VARIANTS.map((v) => portfolio(v.label));
const T = allDays.length, split = Math.floor(T * 0.7);
const fullSh = series.map((r) => sharpe(r));
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const M: number[][] = Array.from({ length: T }, (_, i) => series.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(series[isBest], fullSh).dsr;
const avgSpread = perCoin.reduce((a, p) => a + p.absMeanBps, 0) / perCoin.length;

console.log(`\n_carry-interexchange-funding-carry — Binance − OKX funding arb · ${perCoin.length} coins · ${T} days\n`);
console.log(`  avg |daily funding spread| ${avgSpread.toFixed(2)}bps  (vs ~2.5bp/day Binance−HL benchmark)\n`);
console.log(`  ${"variant".padEnd(11)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ${"cum".padEnd(8)} ann.return`);
for (const { v, i, sh } of VARIANTS.map((v, i) => ({ v, i, sh: fullSh[i] })).sort((a, b) => b.sh - a.sh)) {
  const oos = ann(sharpe(series[i].slice(split)));
  const annRet = (Math.pow(1 + cum(series[i]), 365 / T) - 1) * 100;
  console.log(`  ${v.label.padEnd(11)} ${ann(sh).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " OK" : " X"}`.padEnd(9)} ${`${(cum(series[i]) * 100).toFixed(1)}%`.padEnd(8)} ${annRet.toFixed(1)}%`);
}

// ---- CONTROL: RANDOM-SIDE harvest. Real carry = you must take the CORRECT side of the spread
// (short the higher-funding venue). If you instead pick the side at random each day, a genuine
// structural carry COLLAPSES (you pay fees + half the time you pay the spread instead of collecting).
// Build it from the real per-coin spreads, averaged over seeds. minFunding/fee = best variant. ----
function randomSideControl(seed: number): number {
  const v = VARIANTS[isBest];
  let rng = seed >>> 0;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const perDay = new Map<number, { s: number; c: number }>();
  for (const p of perCoin) {
    let side = 0; // previous random side, for fee accounting
    for (let i = 0; i < p.spread.length - 1; i++) {
      const f = p.spread[i];
      const active = Math.abs(f) >= v.minF ? 1 : 0;
      const dir = active ? (rand() < 0.5 ? -1 : 1) : 0; // RANDOM side, not sign(f)
      // collect = dir * (−sign convention): collecting requires shorting the +funding venue, i.e. dir = −sign(f).
      // here dir is random, so realized harvest = (−dir) * f  (you receive +f if you happened to short the high side)
      const harvest = -dir * f;
      const fee = Math.abs(dir - side) * 2 * (v.fee / 1e4);
      side = dir;
      const d = p.days[i];
      const cur = perDay.get(d) ?? { s: 0, c: 0 };
      cur.s += harvest - fee; cur.c += 1; perDay.set(d, cur);
    }
  }
  const ret = allDays.map((d) => { const e = perDay.get(d); return e && e.c ? e.s / e.c : 0; });
  return ann(sharpe(ret));
}
const ctrlSeeds = [12345, 67890, 24680, 13579, 99999];
const ctrlSh = ctrlSeeds.reduce((a, s) => a + randomSideControl(s), 0) / ctrlSeeds.length;

console.log(`\n  best ${VARIANTS[isBest].label} · PBO ${PBO.toFixed(2)} · DSR ${dsr.toFixed(2)} · random-side control ann.Sharpe ${ctrlSh.toFixed(2)} (real carry should beat this clearly)`);
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `interexchange funding arb (Binance−OKX) ${VARIANTS[isBest].label}`,
  strategyReturns: series[isBest], benchmarkReturns: allDays.map(() => 0),
  pbo: PBO, dsr, oosFrac: 0.3, betaAttractive: false,
})) + "\n");
console.log(`  NOTE: assumes perp-perp basis ~ 0 (tighter than perp-spot, nonzero). Residual = the venue basis;`);
console.log(`  needs simultaneous execution on BOTH Binance and OKX. Both are USDT-margined linear perps.\n`);

// machine-readable summary line for the harness
const bestAnn = ann(fullSh[isBest]);
const bestAnnRet = (Math.pow(1 + cum(series[isBest]), 365 / T) - 1) * 100;
console.log(`RESULT_JSON ${JSON.stringify({ dataAvailable: true, coins: perCoin.length, days: T, avgSpreadBps: Number(avgSpread.toFixed(2)), bestVariant: VARIANTS[isBest].label, annSharpe: Number(bestAnn.toFixed(3)), annReturnPct: Number(bestAnnRet.toFixed(2)), pbo: Number(PBO.toFixed(3)), dsr: Number(dsr.toFixed(3)), controlSharpe: Number(ctrlSh.toFixed(3)) })}`);
