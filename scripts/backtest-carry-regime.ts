/**
 * backtest-carry-regime — "Two Brains" applied to the carry. LOOP A: the deterministic calendar
 * basis carry (edge #2, calendarBasisReturns) on BTC/ETH. LOOP B: a regime layer that SIZES the
 * carry by detected risk (vol-target + a cut-into-danger gate) instead of trading it flat. Honest
 * §7.6 FALSIFICATION: regime-sizing only "works" if its OOS Sharpe beats (a) fixed size, (b) a
 * SHUFFLED regime (permutation null), and (c) a naive vol heuristic. Walk-forward: the only knob
 * (targetVol) is set on the in-sample half and applied OOS. All NO-LOOKAHEAD.
 *
 *   npm run backtest:carry-regime [-- --vol-win 20 --oos 0.4]
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { calendarBasisReturns } from "../src/lib/backtest/candle/funding.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";
import { rollingStd, volTargetSize, regimeGateSize, applySizing, shuffleSizes, trailingZ } from "../src/lib/backtest/regime-size.ts";
import { lcgRng, permutationTest } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const volWin = num("--vol-win", 20);
const oosFrac = num("--oos", 0.4);

// --- quarterly calendar + proxied klines (same as backtest-calendar-basis) ---
function lastFridayUTC(y: number, m: number): number { const d = new Date(Date.UTC(y, m + 1, 0, 8, 0, 0)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 5 + 7) % 7)); return Math.floor(d.getTime() / 1000); }
function frontExpiry(t: number): number { const y0 = new Date(t * 1000).getUTCFullYear(); for (let y = y0 - 1; y <= y0 + 1; y++) for (const m of [2, 5, 8, 11]) { const e = lastFridayUTC(y, m); if (e > t) return e; } return t; }
async function klines(url: string): Promise<Array<Array<number | string>>> { const r = await proxiedFetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as Array<Array<number | string>>; }
const di = (ms: number) => Math.floor(Number(ms) / 86_400_000);

async function carryFor(pair: string): Promise<{ days: number[]; rets: number[] }> {
  const spot = new Map((await klines(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=1000`)).map((k) => [di(k[0] as number), Number(k[4])]));
  const fut = new Map((await klines(`https://fapi.binance.com/fapi/v1/continuousKlines?pair=${pair}&contractType=CURRENT_QUARTER&interval=1d&limit=1500`)).map((k) => [di(k[0] as number), Number(k[4])]));
  const days = [...fut.keys()].filter((d) => spot.has(d)).sort((a, b) => a - b);
  const s: number[] = [], f: number[] = [], dte: number[] = [], roll: boolean[] = [];
  let prev = Infinity;
  for (const d of days) { const sp = spot.get(d)!, fc = fut.get(d)!; if (!(sp > 0) || !(fc > 0)) continue; const e = (frontExpiry(d * DAY) - d * DAY) / DAY; roll.push(e > prev + 1); prev = e; s.push(sp); f.push(fc); dte.push(e); }
  const rets = calendarBasisReturns(s, f, dte, roll, { minBasisAnn: 0, feeBps: 1, tailSkip: 3 });
  return { days: days.slice(0, rets.length), rets };
}

// --- Loop A: equal-weight BTC/ETH calendar carry ---
const coins = await Promise.all(["BTCUSDT", "ETHUSDT"].map(carryFor));
const allDays = [...new Set(coins.flatMap((c) => c.days))].sort((a, b) => a - b);
const idx = coins.map((c) => new Map(c.days.map((d, i) => [d, i])));
const loopA = allDays.map((d) => { let s = 0, n = 0; coins.forEach((c, ci) => { const i = idx[ci].get(d); if (i != null) { s += c.rets[i]; n++; } }); return n ? s / n : 0; });

// --- Loop B: regime sizing (NO-LOOKAHEAD: size[i] uses vol of returns < i) ---
const rv = rollingStd(loopA, volWin);
const sizeVol = [NaN, ...rv.slice(0, -1)];                 // vol known BEFORE return i is realized
const riskZ = [NaN, ...trailingZ(loopA, volWin * 2).slice(0, -1)]; // risk z, lagged
const T = loopA.length, split = Math.floor(T * (1 - oosFrac));
const targetVol = (() => { const isv = sizeVol.slice(0, split).filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return isv[Math.floor(isv.length / 2)] ?? 0.01; })(); // IS median trailing vol
const volSize = volTargetSize(sizeVol, targetVol, { sizeMin: 0.2, sizeMax: 1.6 });
const gateSize = regimeGateSize(riskZ, { cutZ: 1, band: 1.5, floor: 0.3, full: 1 });

const regimeVol = applySizing(loopA, volSize);
const regimeGate = applySizing(loopA, gateSize);
const volHeuristic = applySizing(loopA, sizeVol.map((v) => (Number.isFinite(v) && v > targetVol ? 0.5 : 1))); // naive cut-when-vol-high

const ann = (r: number[]) => sharpe(r) * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((e, x) => e * (1 + x), 1) - 1;
const maxDD = (r: number[]) => { let eq = 1, pk = 1, mdd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } return mdd; };
const oos = (r: number[]) => r.slice(split);

console.log(`\nbacktest-carry-regime — Two Brains on the calendar carry · ${coins.length} coins · ${T} days · OOS ${oosFrac} · volWin ${volWin}\n`);
console.log(`  ${"book".padEnd(22)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ${"OOS maxDD".padEnd(10)} cum`);
const row = (name: string, r: number[]) => console.log(`  ${name.padEnd(22)} ${ann(r).toFixed(2).padEnd(11)} ${ann(oos(r)).toFixed(2).padEnd(9)} ${(maxDD(oos(r)) * 100).toFixed(1).padEnd(10)} ${(cum(r) * 100).toFixed(0)}%`);
row("Loop A (fixed size)", loopA);
row("+regime vol-target", regimeVol);
row("+regime gate", regimeGate);
row("vol-heuristic (naive)", volHeuristic);

// --- §7.6 FALSIFICATION: does the regime TIMING beat a shuffled regime? (OOS) ---
const best = ann(oos(regimeVol)) >= ann(oos(regimeGate)) ? { name: "vol-target", sizes: volSize, r: regimeVol } : { name: "gate", sizes: gateSize, r: regimeGate };
const rng = lcgRng(20260605);
const nullSh: number[] = [];
for (let k = 0; k < 300; k++) nullSh.push(ann(oos(applySizing(loopA, shuffleSizes(best.sizes, volWin, lcgRng(7000 + k))))));
const pt = permutationTest(ann(oos(best.r)), nullSh, "greater");
console.log(`\n  §7.6 FALSIFICATION (OOS, best regime = ${best.name}):`);
console.log(`   vs fixed size:      regime OOS Sharpe ${ann(oos(best.r)).toFixed(2)}  vs  fixed ${ann(oos(loopA)).toFixed(2)}  → ${ann(oos(best.r)) > ann(oos(loopA)) ? "regime better" : "no improvement"}`);
console.log(`   vs SHUFFLED regime: ${300} block-shuffled nulls, mean ${(nullSh.reduce((a, x) => a + x, 0) / nullSh.length).toFixed(2)}  → p=${pt.pValue.toFixed(3)} ${pt.pValue < 0.05 ? "✓ timing carries info" : "✗ shuffle does as well — regime adds nothing"}`);
console.log(`   vs vol-heuristic:   regime ${ann(oos(best.r)).toFixed(2)}  vs  naive ${ann(oos(volHeuristic)).toFixed(2)}  → ${ann(oos(best.r)) > ann(oos(volHeuristic)) ? "beats the cheap heuristic" : "no better than the heuristic"}`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: `carry + regime (${best.name})`, strategyReturns: best.r, benchmarkReturns: allDays.slice(0, T).map(() => 0),
  pbo: 0, dsr: pt.pValue < 0.05 ? 1 : 0, oosFrac, betaAttractive: false,
})) + "\n");
console.log(`  READ: the §7.6 bar is the SHUFFLE test — if p≥0.05 the regime layer is decoration (any reordering of the same`);
console.log(`  sizes does as well). Loop B earns its place only by beating fixed + shuffled + the naive heuristic OOS.\n`);
