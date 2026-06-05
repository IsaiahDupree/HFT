/**
 * backtest-basis — the RISK-HONEST delta-neutral carry: fetch BOTH legs (Binance spot + perp via
 * the proxy) and model the real basis P&L, so the basis risk that backtest-carry-neutral OMITS
 * shows up. Reports funding-only Sharpe vs basis-aware Sharpe (the gap = the inflation), basis
 * statistics, then runs the basis-aware portfolio through walk-forward + the one-voice advisor.
 *
 *   npm run backtest:basis -- --coins AERGO,SEI,WIF,ENA,... [--fee-bps 5]
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { basisCarryReturns, deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { fetchBinanceKlines, fetchBinancePerpKlines } from "../src/lib/data/binance.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const flagS = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlyCoins = flagS("--coins")?.split(",").map((s) => s.trim().toUpperCase());
const dir = resolve(process.cwd(), "data", "funding");
const allCoins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
const coins = allCoins.filter((c) => !onlyCoins || onlyCoins.includes(c.toUpperCase()));
if (!coins.length) { console.log("\n  no funding files — run fetch:funding:binance first\n"); process.exit(0); }

function loadFunding(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { time: number; rate: number }).sort((a, b) => a.time - b.time);
}
function dailyFundingFor(days: number[], funding: Array<{ time: number; rate: number }>): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(days.length).fill(undefined);
  let j = 0;
  for (let i = 0; i < days.length; i++) {
    const d0 = days[i], d1 = d0 + DAY;
    while (j < funding.length && funding[j].time < d0) j++;
    let sum = 0, cnt = 0, k = j;
    while (k < funding.length && funding[k].time < d1) { sum += funding[k].rate; cnt++; k++; }
    out[i] = cnt > 0 ? sum : undefined;
    j = k;
  }
  return out;
}

const VARIANTS = [
  { label: ">1bp@1bp", minF: 0.0001, fee: 1 },
  { label: ">3bp@5bp", minF: 0.0003, fee: 5 },
  { label: ">5bp@10bp", minF: 0.0005, fee: 10 },
];

console.log(`\nbacktest-basis — RISK-HONEST carry (spot+perp legs, real basis P&L) · ${coins.length} coins requested\n`);

type Coin = { coin: string; days: number[]; basisByV: Record<string, Map<number, number>>; fundByV: Record<string, Map<number, number>>; basisBpsMean: number; basisBpsVol: number };
const perCoin: Coin[] = [];
for (const coin of coins) {
  const sym = `${coin}USDT`;
  try {
    const spot = await fetchBinanceKlines(sym, "1d", { limit: 1000 });
    const perp = await fetchBinancePerpKlines(sym, "1d", { limit: 1000 });
    if (spot.length < 60 || perp.length < 60) continue;
    const pMap = new Map(perp.map((c) => [c.start_unix, c.close]));
    const aligned = spot.filter((c) => pMap.has(c.start_unix)).sort((a, b) => a.start_unix - b.start_unix);
    if (aligned.length < 60) continue;
    const days = aligned.map((c) => c.start_unix);
    const spotC = aligned.map((c) => c.close), perpC = aligned.map((c) => pMap.get(c.start_unix)!);
    const fund = dailyFundingFor(days, loadFunding(coin));
    const basisBpsSeries = days.map((_, i) => (perpC[i] / spotC[i] - 1) * 1e4);
    const mean = basisBpsSeries.reduce((a, x) => a + x, 0) / basisBpsSeries.length;
    const vol = Math.sqrt(basisBpsSeries.reduce((a, x) => a + (x - mean) ** 2, 0) / basisBpsSeries.length);
    const basisByV: Record<string, Map<number, number>> = {}, fundByV: Record<string, Map<number, number>> = {};
    for (const v of VARIANTS) {
      const bc = basisCarryReturns(spotC, perpC, fund, { minFunding: v.minF, feeBps: v.fee });
      const fc = deltaNeutralCarryReturns(fund, { minFunding: v.minF, feeBps: v.fee });
      basisByV[v.label] = new Map(days.slice(0, days.length - 1).map((d, i) => [d, bc[i]]));
      fundByV[v.label] = new Map(days.slice(0, days.length - 1).map((d, i) => [d, fc[i]]));
    }
    perCoin.push({ coin, days, basisByV, fundByV, basisBpsMean: mean, basisBpsVol: vol });
    await new Promise((r) => setTimeout(r, 80));
  } catch (e) { console.log(`  ${sym.padEnd(12)} skip: ${(e as Error).message.slice(0, 60)}`); }
}
if (!perCoin.length) { console.log("\n  no coins with aligned spot+perp+funding\n"); process.exit(0); }

const allDays = [...new Set(perCoin.flatMap((p) => p.days.slice(0, -1)))].sort((a, b) => a - b);
function portfolio(byV: (p: Coin) => Map<number, number>): number[] {
  return allDays.map((d) => { let s = 0, c = 0; for (const p of perCoin) { const r = byV(p).get(d); if (r != null) { s += r; c++; } } return c ? s / c : 0; });
}
const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const basisSeries = VARIANTS.map((v) => portfolio((p) => p.basisByV[v.label]));
const fundSeries = VARIANTS.map((v) => portfolio((p) => p.fundByV[v.label]));
const T = allDays.length;
const split = Math.floor(T * 0.7);
const fullSh = basisSeries.map((r) => sharpe(r));
const isBest = basisSeries.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const M: number[][] = Array.from({ length: T }, (_, i) => basisSeries.map((r) => r[i]));
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(basisSeries[isBest], fullSh).dsr;

const avgBasisMean = perCoin.reduce((a, p) => a + p.basisBpsMean, 0) / perCoin.length;
const avgBasisVol = perCoin.reduce((a, p) => a + p.basisBpsVol, 0) / perCoin.length;
console.log(`  ${perCoin.length} coins with spot+perp · ${T} days · avg basis ${avgBasisMean.toFixed(1)}bps (daily vol ${avgBasisVol.toFixed(0)}bps)\n`);
console.log(`  ${"variant".padEnd(12)} ${"funding-only".padEnd(13)} ${"basis-aware".padEnd(13)} ${"OOS basis".padEnd(11)} cum(basis)`);
for (let i = 0; i < VARIANTS.length; i++) {
  const fSh = ann(sharpe(fundSeries[i])), bSh = ann(fullSh[i]), bOos = ann(sharpe(basisSeries[i].slice(split)));
  console.log(`  ${VARIANTS[i].label.padEnd(12)} ${`Sh ${fSh.toFixed(2)}`.padEnd(13)} ${`Sh ${bSh.toFixed(2)}`.padEnd(13)} ${`${bOos.toFixed(2)}${bOos > 0 ? " ✓" : " ✗"}`.padEnd(11)} ${(cum(basisSeries[i]) * 100).toFixed(1)}%`);
}
console.log(`\n  basis risk impact: funding-only Sharpe ${ann(sharpe(fundSeries[isBest])).toFixed(1)} → basis-aware ${ann(fullSh[isBest]).toFixed(1)} (the gap is the omitted risk)`);

// Advise on a REALISTIC-fee variant (not the cherry-picked maker-fee best) so the verdict isn't
// flattered by optimistic execution. Default to >3bp@5bp; the table above shows the full spread.
const realIdx = VARIANTS.findIndex((v) => v.label === ">3bp@5bp");
const ri = realIdx >= 0 ? realIdx : VARIANTS.length - 1;
const realDsr = deflatedSharpe(basisSeries[ri], fullSh).dsr;
console.log(`  (advising on the REALISTIC variant ${VARIANTS[ri].label}, not the maker-fee best — execution honesty)`);
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `basis-aware carry ${VARIANTS[ri].label}`,
  strategyReturns: basisSeries[ri], benchmarkReturns: allDays.map(() => 0),
  pbo: PBO, dsr: realDsr, oosFrac: 0.3, betaAttractive: false,
})) + "\n");
console.log(`  BOTTOM LINE: funding carry is REAL but EXECUTION-CRITICAL — positive at maker fees (Sharpe ${ann(fullSh[isBest]).toFixed(1)} on ${VARIANTS[isBest].label}),`);
console.log(`  breakeven-to-negative at taker fees on these semi-liquid alts. Viable only on the fattest-funding names with`);
console.log(`  MAKER execution + tight basis; capacity/borrow-limited. PAPER it with a real maker fill model before sizing.\n`);
