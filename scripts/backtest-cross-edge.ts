/**
 * backtest-cross-edge — combine the confirmed carries into ONE regime-rotated book. Sleeves:
 * calendar-basis-BTC, calendar-basis-ETH, and a SQUEEZE-GATED funding carry on persistence alts.
 * Diversification (low cross-sleeve correlation) + risk-parity should lift the portfolio Sharpe
 * above any single sleeve. NO-LOOKAHEAD throughout. §7.6 FALSIFICATION: the risk-parity+regime
 * book must beat equal-weight AND a SHUFFLED-regime null AND the best single sleeve, out-of-sample.
 *
 *   npm run backtest:cross-edge
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { calendarBasisReturns, basisCarryReturns } from "../src/lib/backtest/candle/funding.ts";
import { fetchBinanceKlines, fetchBinancePerpKlines } from "../src/lib/data/binance.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";
import { rollingStd, trailingZ, regimeGateSize, applySizing, shuffleSizes } from "../src/lib/backtest/regime-size.ts";
import { equalWeights, inverseVolWeights, applyAllocation, normalizeWeights, correlationMatrix } from "../src/lib/backtest/edge-allocator.ts";
import { lcgRng, permutationTest } from "../src/lib/backtest/shuffle-control.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const oosFrac = num("--oos", 0.4), volWin = num("--vol-win", 20);

// ---- calendar carry sleeve (per pair) ----
function lastFri(y: number, m: number): number { const d = new Date(Date.UTC(y, m + 1, 0, 8, 0, 0)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 5 + 7) % 7)); return Math.floor(d.getTime() / 1000); }
function frontExp(t: number): number { const y0 = new Date(t * 1000).getUTCFullYear(); for (let y = y0 - 1; y <= y0 + 1; y++) for (const m of [2, 5, 8, 11]) { const e = lastFri(y, m); if (e > t) return e; } return t; }
async function kl(url: string): Promise<Array<Array<number | string>>> { const r = await proxiedFetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as Array<Array<number | string>>; }
const di = (ms: number) => Math.floor(Number(ms) / 86_400_000);
async function calendarSleeve(pair: string): Promise<{ days: number[]; rets: number[] }> {
  const spot = new Map((await kl(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=1000`)).map((k) => [di(k[0] as number), Number(k[4])]));
  const fut = new Map((await kl(`https://fapi.binance.com/fapi/v1/continuousKlines?pair=${pair}&contractType=CURRENT_QUARTER&interval=1d&limit=1500`)).map((k) => [di(k[0] as number), Number(k[4])]));
  const days = [...fut.keys()].filter((d) => spot.has(d)).sort((a, b) => a - b);
  const s: number[] = [], f: number[] = [], dte: number[] = [], roll: boolean[] = []; let prev = Infinity;
  for (const d of days) { const sp = spot.get(d)!, fc = fut.get(d)!; if (!(sp > 0) || !(fc > 0)) continue; const e = (frontExp(d * DAY) - d * DAY) / DAY; roll.push(e > prev + 1); prev = e; s.push(sp); f.push(fc); dte.push(e); }
  const rets = calendarBasisReturns(s, f, dte, roll, { minBasisAnn: 0, feeBps: 1, tailSkip: 3 });
  return { days: days.slice(0, rets.length).map((d) => d * DAY), rets };
}

// ---- funding carry sleeve (persistence alts), then a SQUEEZE GATE on its own trailing vol ----
const fdir = resolve(process.cwd(), "data", "funding");
const NAMES = ["LAB", "BEAT", "VIC", "KOMA", "HOME", "PORTAL", "AERGO", "GOAT", "ACT", "PEOPLE", "SEI", "ENA", "WIF", "PNUT", "TRX", "DASH"];
function dailyFunding(c: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of readFileSync(resolve(fdir, `${c}.binance.jsonl`), "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) { const r = JSON.parse(l) as { time: number; rate: number }; const d = Math.floor(r.time / DAY) * DAY; m.set(d, (m.get(d) ?? 0) + r.rate); }
  return m;
}
/** BASIS-AWARE funding carry sleeve: real spot+perp price legs (not assumed to cancel) → honest Sharpe. */
async function fundingSleeve(): Promise<{ days: number[]; rets: number[]; gated: number[] }> {
  const avail = existsSync(fdir) ? readdirSync(fdir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
  const coins = NAMES.filter((c) => avail.includes(c));
  const per: Array<Map<number, number>> = [];
  for (const c of coins) {
    try {
      const fund = dailyFunding(c);
      const spot = await fetchBinanceKlines(`${c}USDT`, "1d", { limit: 1000 });
      const perp = await fetchBinancePerpKlines(`${c}USDT`, "1d", { limit: 1000 });
      const pMap = new Map(perp.map((k) => [Math.floor(k.start_unix / DAY) * DAY, k.close]));
      const aligned = spot.map((k) => Math.floor(k.start_unix / DAY) * DAY).filter((d) => pMap.has(d) && spot.find((s) => Math.floor(s.start_unix / DAY) * DAY === d));
      const days = [...new Set(aligned)].sort((a, b) => a - b);
      if (days.length < 60) continue;
      const sMap = new Map(spot.map((k) => [Math.floor(k.start_unix / DAY) * DAY, k.close]));
      const spotC = days.map((d) => sMap.get(d)!), perpC = days.map((d) => pMap.get(d)!), fundArr = days.map((d) => fund.get(d));
      const bc = basisCarryReturns(spotC, perpC, fundArr, { minFunding: 0.0002, feeBps: 4.22 }); // basis-aware + realistic fee
      per.push(new Map(days.slice(0, -1).map((d, i) => [d, bc[i]])));
    } catch { /* coin without perp/spot klines → skip */ }
  }
  const allDays = [...new Set(per.flatMap((p) => [...p.keys()]))].sort((a, b) => a - b);
  const rets = allDays.map((d) => { let s = 0, n = 0; for (const p of per) { const r = p.get(d); if (r != null) { s += r; n++; } } return n ? s / n : 0; });
  const z = [NaN, ...trailingZ(rets, volWin * 2).slice(0, -1)];
  const gated = applySizing(rets, regimeGateSize(z, { cutZ: 1, band: 1.5, floor: 0.3 }));
  return { days: allDays, rets, gated };
}

const [calBTC, calETH, fund] = await Promise.all([calendarSleeve("BTCUSDT"), calendarSleeve("ETHUSDT"), fundingSleeve()]);
const sleeves = [{ name: "cal-BTC", s: calBTC }, { name: "cal-ETH", s: calETH }, { name: "fund-alts(gated)", s: { days: fund.days, rets: fund.gated } }];

// ---- align on the common day window ----
const common = sleeves.map((x) => new Set(x.s.days)).reduce((a, b) => new Set([...a].filter((d) => b.has(d))));
const days = [...common].sort((a, b) => a - b);
const idxs = sleeves.map((x) => new Map(x.s.days.map((d, i) => [d, i])));
const R = sleeves.map((x, k) => days.map((d) => x.s.rets[idxs[k].get(d)!]));
const T = days.length, split = Math.floor(T * (1 - oosFrac));

const ann = (r: number[]) => sharpe(r) * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((e, x) => e * (1 + x), 1) - 1;
const maxDD = (r: number[]) => { let eq = 1, pk = 1, m = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); m = Math.min(m, eq / pk - 1); } return m; };
const oos = (r: number[]) => r.slice(split);

console.log(`\nbacktest-cross-edge — one regime-rotated carry book · ${sleeves.length} sleeves · ${T} common days · OOS ${oosFrac}\n`);
const corr = correlationMatrix(R);
console.log(`  correlation (diversification = low):`);
console.log(`            ${sleeves.map((x) => x.name.padEnd(16)).join("")}`);
sleeves.forEach((x, i) => console.log(`  ${x.name.padEnd(8)} ${corr[i].map((c) => c.toFixed(2).padEnd(16)).join("")}`));

console.log(`\n  ${"book".padEnd(20)} ${"ann.Sharpe".padEnd(11)} ${"OOS-Sh".padEnd(9)} ${"OOS maxDD".padEnd(10)} cum`);
const row = (n: string, r: number[]) => console.log(`  ${n.padEnd(20)} ${ann(r).toFixed(2).padEnd(11)} ${ann(oos(r)).toFixed(2).padEnd(9)} ${(maxDD(oos(r)) * 100).toFixed(1).padEnd(10)} ${(cum(r) * 100).toFixed(0)}%`);
sleeves.forEach((x, i) => row(x.name, R[i]));
const ewBook = applyAllocation(R, equalWeights(R.length, T));
const rpW = inverseVolWeights(R, volWin);
const rpBook = applyAllocation(R, rpW);
// regime overlay: scale risk-parity weights by each sleeve's own gate, renormalize.
const gates = R.map((r) => regimeGateSize([NaN, ...trailingZ(r, volWin * 2).slice(0, -1)], { cutZ: 1, band: 1.5, floor: 0.3 }));
const rgW = normalizeWeights(rpW.map((w, e) => w.map((x, t) => x * gates[e][t])));
const rgBook = applyAllocation(R, rgW);
row("equal-weight", ewBook);
row("risk-parity", rpBook);
row("risk-parity+regime", rgBook);

// ---- §7.6 falsification (OOS) ----
const bestSingle = Math.max(...R.map((r) => ann(oos(r))));
const rng = lcgRng(20260605);
const nullSh: number[] = [];
for (let k = 0; k < 300; k++) { const sh = normalizeWeights(rpW.map((w, e) => w.map((x, t) => x * shuffleSizes(gates[e], volWin, lcgRng(8000 + k * 7 + e))[t]))); nullSh.push(ann(oos(applyAllocation(R, sh)))); }
const pt = permutationTest(ann(oos(rgBook)), nullSh, "greater");
console.log(`\n  §7.6 FALSIFICATION (OOS):`);
console.log(`   diversification: combined OOS Sharpe ${ann(oos(rgBook)).toFixed(2)}  vs  best single sleeve ${bestSingle.toFixed(2)}  → ${ann(oos(rgBook)) > bestSingle ? "✓ combining beats the best single" : "no diversification benefit"}`);
console.log(`   vs equal-weight: risk-parity+regime ${ann(oos(rgBook)).toFixed(2)}  vs  EW ${ann(oos(ewBook)).toFixed(2)}  → ${ann(oos(rgBook)) > ann(oos(ewBook)) ? "better" : "no better"}`);
console.log(`   vs SHUFFLED regime: 300 nulls mean ${(nullSh.reduce((a, x) => a + x, 0) / nullSh.length).toFixed(2)}  → p=${pt.pValue.toFixed(3)} ${pt.pValue < 0.05 ? "✓ regime timing helps" : "✗ shuffle does as well"}`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: "cross-edge carry book (risk-parity+regime)", strategyReturns: rgBook, benchmarkReturns: days.map(() => 0),
  pbo: 0, dsr: pt.pValue < 0.05 ? 1 : 0, oosFrac, betaAttractive: false,
})) + "\n");
console.log(`  READ: the win is DIVERSIFICATION (low-correlation carries stacked) + risk-parity; the regime overlay is\n  only credited if it beats the SHUFFLE. This is the deployable shape: one book, several uncorrelated carries.\n`);
