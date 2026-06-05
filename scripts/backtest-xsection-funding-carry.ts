/**
 * backtest-xsection-funding-carry — the RISK-HONEST cross-sectional funding carry. The discovery
 * version (_carry-xsection-funding-carry.ts) harvests the funding DISPERSION assuming the long/short
 * price legs perfectly cancel → an inflated Sharpe (it only sees funding variance). This adds the
 * REAL price P&L of the notional-balanced book (long bottom-funding tercile / short top), so the
 * cross-sectional TRACKING ERROR the funding-only model omits shows up. Reports funding-only Sharpe
 * vs price-aware Sharpe (the gap = the omitted risk), then the one-voice advisor on the honest series.
 *
 *   npm run backtest:xsection-carry [-- --frac 0.33 --fee-bps 10 --hold 3]
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { fetchBinancePerpKlines } from "../src/lib/data/binance.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";

const DAY = 86_400;
const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const frac = num("--frac", 0.33);
const feeBps = num("--fee-bps", 10);
const hold = num("--hold", 3);

const dir = resolve(process.cwd(), "data", "funding");
const coins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".binance.jsonl")).map((f) => f.replace(".binance.jsonl", "")) : [];
if (coins.length < 9) { console.log("\n  need ≥9 funding files — run fetch:funding:binance\n"); process.exit(0); }

function dailyFunding(coin: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of readFileSync(resolve(dir, `${coin}.binance.jsonl`), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) {
    const r = JSON.parse(l) as { time: number; rate: number };
    const d = Math.floor(r.time / DAY) * DAY;
    m.set(d, (m.get(d) ?? 0) + r.rate);
  }
  return m;
}

// Load funding + fetch perp daily closes for each coin (price leg, via the proxy).
console.log(`\nbacktest-xsection-funding-carry — funding-only vs PRICE-AWARE · frac ${frac} · ${feeBps}bps · ${hold}d hold\n  fetching perp klines for ${coins.length} coins…`);
type C = { coin: string; fund: Map<number, number>; close: Map<number, number> };
const data: C[] = [];
for (const coin of coins) {
  try {
    const kl = await fetchBinancePerpKlines(`${coin}USDT`, "1d", { limit: 1000 });
    if (kl.length < 120) continue;
    data.push({ coin, fund: dailyFunding(coin), close: new Map(kl.map((c) => [Math.floor(c.start_unix / DAY) * DAY, c.close])) });
    await new Promise((r) => setTimeout(r, 60));
  } catch { /* coin without a perp / klines → skip */ }
}
if (data.length < 9) { console.log(`\n  only ${data.length} coins with perp klines — too few\n`); process.exit(0); }

// Common day grid where ≥6 coins have both funding(d) and funding+close(d+1).
const allDays = [...new Set(data.flatMap((c) => [...c.fund.keys()]))].sort((a, b) => a - b);

/** Build funding-only AND price-aware daily return series for one (frac, hold) book. */
function run(): { fundOnly: number[]; priceAware: number[] } {
  const fundOnly: number[] = [], priceAware: number[] = [];
  let prevW = new Map<string, number>();
  let held = 0, curW = new Map<string, number>();
  for (let t = 0; t < allDays.length - 1; t++) {
    const dSig = allDays[t], dReal = allDays[t + 1];
    // rebalance every `hold` days; otherwise keep the book
    if (held === 0) {
      const elig = data.filter((c) => c.fund.has(dSig) && c.fund.has(dReal) && c.close.has(dSig) && c.close.has(dReal))
        .map((c) => ({ c: c.coin, f: c.fund.get(dSig)! }))
        .sort((a, b) => a.f - b.f);
      const k = Math.max(1, Math.floor(elig.length * frac));
      if (elig.length >= 6) {
        const w = new Map<string, number>();
        for (const x of elig.slice(0, k)) w.set(x.c, +1 / k);                    // LONG bottom funding
        for (const x of elig.slice(elig.length - k)) w.set(x.c, -1 / k);         // SHORT top funding
        curW = w;
      }
    }
    held = (held + 1) % hold;
    // realize over dSig→dReal: funding accrual + price P&L of the balanced book
    let fNet = 0, pNet = 0;
    for (const [coin, w] of curW) {
      const c = data.find((x) => x.coin === coin)!;
      const fReal = c.fund.get(dReal); const p0 = c.close.get(dSig), p1 = c.close.get(dReal);
      if (fReal == null || p0 == null || p1 == null || !(p0 > 0)) continue;
      // SHORT perp (w<0) collects +funding; LONG perp (w>0) pays it → funding pnl = -w·funding.
      fNet += -w * fReal;
      // price pnl: long perp earns +ret, short earns -ret → w·ret.
      pNet += w * (p1 / p0 - 1);
    }
    let turn = 0; for (const c of new Set([...prevW.keys(), ...curW.keys()])) turn += Math.abs((curW.get(c) ?? 0) - (prevW.get(c) ?? 0));
    const fee = turn * (feeBps / 1e4);
    fundOnly.push(fNet - fee);
    priceAware.push(fNet + pNet - fee);
    prevW = new Map(curW);
  }
  return { fundOnly, priceAware };
}

const { fundOnly, priceAware } = run();
const ann = (s: number) => s * Math.sqrt(365);
const cum = (r: number[]) => r.reduce((e, x) => e * (1 + x), 1) - 1;
const T = priceAware.length, split = Math.floor(T * 0.7);
const M: number[][] = Array.from({ length: T }, (_, i) => [priceAware[i], fundOnly[i]]);
const PBO = pbo(M, 6);
const dsr = deflatedSharpe(priceAware, [sharpe(priceAware), sharpe(fundOnly)]).dsr;

console.log(`\n  ${data.length} coins · ${T} days\n`);
console.log(`  funding-only:  ann.Sharpe ${ann(sharpe(fundOnly)).toFixed(2)}  cum ${(cum(fundOnly) * 100).toFixed(0)}%  (the inflated view — price legs assumed to cancel)`);
console.log(`  PRICE-AWARE:   ann.Sharpe ${ann(sharpe(priceAware)).toFixed(2)}  cum ${(cum(priceAware) * 100).toFixed(0)}%  OOS ${ann(sharpe(priceAware.slice(split))).toFixed(2)}  (real basket tracking error included)`);
console.log(`  → basket tracking error knocks Sharpe ${ann(sharpe(fundOnly)).toFixed(1)} → ${ann(sharpe(priceAware)).toFixed(1)}`);

console.log("\n" + renderTradeMemo(adviseTrade({
  label: `xsection funding carry (price-aware, frac ${frac})`,
  strategyReturns: priceAware, benchmarkReturns: allDays.slice(0, T).map(() => 0),
  pbo: PBO, dsr, oosFrac: 0.3, betaAttractive: false,
})) + "\n");
console.log(`  NOTE: PRICE-AWARE is the honest series (funding dispersion harvested + the real long/short price P&L). If it`);
console.log(`  stays positive the funding carry survives the cross-sectional tracking error; the gap to funding-only is the\n  risk the discovery model omitted. Still execution/borrow-limited on the extreme-funding short legs.\n`);
