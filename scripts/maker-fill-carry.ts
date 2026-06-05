/**
 * maker-fill-carry — the go/no-go: re-cost the funding carry with a REALISTIC effective fee
 * measured from real L2, instead of an assumed 1bp maker. Calibrates the touch-order fill rate on
 * the recorded dYdX books (BTC/ETH/SOL), blends maker/taker into an effective fee, and re-runs the
 * delta-neutral carry on the best-persistence alts with THAT fee. Verdict from the one-voice advisor.
 *
 * CAVEAT: the fill rate is calibrated on LIQUID dYdX majors → an OPTIMISTIC upper bound for the
 * illiquid alts the carry trades (alts fill worse). So if the carry dies even here, it's dead on
 * alts; if it survives, haircut further for alt illiquidity.
 *
 *   npm run carry:maker-fill [-- --coins LAB,BEAT,... --maker-bps 1 --taker-bps 5]
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadCaptureJsonl } from "../src/lib/backtest/l2/replay.ts";
import { calibrateMakerFillRate, effectiveFeeBps } from "../src/lib/backtest/maker-fill.ts";
import { deltaNeutralCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const flag = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const makerBps = Number(flag("--maker-bps", "1"));
const takerBps = Number(flag("--taker-bps", "5"));
const date = flag("--date", new Date().toISOString().slice(0, 10));
// best-persistence carry names (from discover:funding-persistence) + a few liquid alts
const coinsArg = flag("--coins", "LAB,BEAT,VIC,KOMA,HOME,PORTAL,AERGO,GOAT,ACT,PEOPLE,SEI,ENA,WIF,PNUT,GUN,SOON").split(",").map((s) => s.trim().toUpperCase());

// 1) Calibrate the maker fill rate from the recorded dYdX L2.
const capDir = resolve(process.cwd(), "data", "captures-dydx", date);
const events = ["BTC-USD", "ETH-USD", "SOL-USD"].flatMap((m) => { const p = resolve(capDir, `${m}.ws.jsonl`); return existsSync(p) ? loadCaptureJsonl(p) : []; }).sort((a, b) => a.ts - b.ts);
if (events.length < 200) { console.log(`\n  too few L2 events (${events.length}) at ${capDir} — record more: npm run record:dydx:cron\n`); process.exit(0); }
const cal = calibrateMakerFillRate(events, { windowSec: 2, sampleEverySec: 0.5 });
const effFee = effectiveFeeBps(cal.fillRate, makerBps, takerBps);

console.log(`\nmaker-fill-carry — realistic re-cost of the carry\n`);
console.log(`  L2 calibration (dYdX BTC/ETH/SOL, ${events.length} events): maker fill rate ${(cal.fillRate * 100).toFixed(0)}% over ${cal.windowSec}s (${cal.fills}/${cal.opportunities} posts, avg ${cal.avgTimeToFillSec.toFixed(2)}s to fill)`);
console.log(`  → effective fee = ${(cal.fillRate * 100).toFixed(0)}%·${makerBps}bp + ${((1 - cal.fillRate) * 100).toFixed(0)}%·${takerBps}bp = ${effFee.toFixed(2)}bp/leg (vs the optimistic ${makerBps}bp assumed before)\n`);

// 2) Re-run the carry on the best-persistence alts with the calibrated effective fee.
const dir = resolve(process.cwd(), "data", "funding");
const avail = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
const coins = coinsArg.filter((c) => avail.includes(c));
function loadFund(coin: string): Array<{ time: number; rate: number }> {
  return readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as { time: number; rate: number });
}
function dailySum(rows: Array<{ time: number; rate: number }>): Map<number, number> {
  const m = new Map<number, number>(); for (const r of rows) { const d = Math.floor(r.time / DAY) * DAY; m.set(d, (m.get(d) ?? 0) + r.rate); } return m;
}
const MINF = [0.0001, 0.0002, 0.0005];
const perCoin = coins.map((coin) => {
  const dd = dailySum(loadFund(coin)); const days = [...dd.keys()].sort((a, b) => a - b); const spread = days.map((d) => dd.get(d)!);
  const byMin: Record<string, Map<number, number>> = {};
  for (const mf of MINF) byMin[String(mf)] = new Map(days.slice(0, -1).map((d, i) => [d, deltaNeutralCarryReturns(spread, { minFunding: mf, feeBps: effFee })[i]]));
  return { coin, days, byMin };
}).filter((p) => p.days.length > 60);
if (!perCoin.length) { console.log("  no carry coins available — run fetch:funding:binance\n"); process.exit(0); }

const allDays = [...new Set(perCoin.flatMap((p) => p.days.slice(0, -1)))].sort((a, b) => a - b);
const portfolio = (mf: number) => allDays.map((d) => { let s = 0, c = 0; for (const p of perCoin) { const r = p.byMin[String(mf)].get(d); if (r != null) { s += r; c++; } } return c ? s / c : 0; });
const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((eq, x) => eq * (1 + x), 1) - 1;
const series = MINF.map(portfolio);
const T = allDays.length, split = Math.floor(T * 0.7);
const fullSh = series.map((r) => sharpe(r));
const isBest = series.map((r) => sharpe(r.slice(0, split))).reduce((bi, x, i, a) => (x > a[bi] ? i : bi), 0);
const PBO = pbo(Array.from({ length: T }, (_, i) => series.map((r) => r[i])), 6);
const dsr = deflatedSharpe(series[isBest], fullSh).dsr;

console.log(`  carry on ${perCoin.length} best-persistence alts at the REALISTIC ${effFee.toFixed(2)}bp fee · ${T} days\n`);
console.log(`  ${"min funding".padEnd(13)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ann.return`);
for (let i = 0; i < MINF.length; i++) {
  const oos = ann(sharpe(series[i].slice(split)));
  const annRet = (Math.pow(1 + cum(series[i]), 365 / T) - 1) * 100;
  console.log(`  >${(MINF[i] * 1e4).toFixed(0)}bp/8h${" ".repeat(6)} ${ann(fullSh[i]).toFixed(2).padEnd(11)} ${`${oos.toFixed(2)}${oos > 0 ? " ✓" : " ✗"}`.padEnd(9)} ${annRet.toFixed(1)}%`);
}
console.log("\n" + renderTradeMemo(adviseTrade({
  label: `carry @ realistic ${effFee.toFixed(1)}bp`,
  strategyReturns: series[isBest], benchmarkReturns: allDays.map(() => 0),
  pbo: PBO, dsr, oosFrac: 0.3, betaAttractive: false,
})) + "\n");
console.log(`  GO/NO-GO: this is the carry at a DATA-MEASURED fee (${effFee.toFixed(1)}bp), not an assumed 1bp. The L2 fill rate is`);
console.log(`  from liquid majors → optimistic for alts; if the verdict is BUY/PAPER here, haircut for alt illiquidity before sizing.\n`);
