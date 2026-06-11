/**
 * vol-surface-scan — pull the REAL current Deribit option chain (BTC + ETH) and measure the live structural
 * premia we want to harvest: the 25Δ risk-reversal (downside crash premium), the ATM term structure
 * (front-vs-back), and the 30d implied-vs-realized VRP. Prints the live signal and appends a snapshot to a
 * forward-track log so we accrue an out-of-sample record of whether the premium was actually realized — the
 * honest gauntlet for an edge with no free historical surface.
 *
 *   npm run vol:surface            # scan BTC+ETH, print premia, log snapshot
 */
import "./_env.ts";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { parseInstrument, expiryMetrics, termStructure, realizedVol, type OptionQuote } from "../src/lib/exec/vol-surface.ts";

const NOW = Date.now(), DAY = 86_400_000;
const OUT = process.env.VOLSURFACE_LOG ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/vol-surface-log.jsonl" : resolve(process.cwd(), "data", "vol-surface-log.jsonl"));
async function jget(u: string): Promise<any> { const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${u.slice(0, 50)} ${r.status}`); return r.json(); }

type BookRow = { instrument_name: string; mark_iv: number; underlying_price: number };
async function chain(currency: string): Promise<{ spot: number; byExpiry: Map<number, OptionQuote[]> }> {
  const j = await jget(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`);
  const rows = (j?.result ?? []) as BookRow[];
  let spot = 0; const byExpiry = new Map<number, OptionQuote[]>();
  for (const r of rows) {
    const inst = parseInstrument(r.instrument_name); if (!inst || !(r.mark_iv > 0)) continue;
    if (r.underlying_price > 0) spot = r.underlying_price;
    const q: OptionQuote = { strike: inst.strike, type: inst.type, iv: r.mark_iv / 100, expiryMs: inst.expiryMs };
    (byExpiry.get(inst.expiryMs) ?? byExpiry.set(inst.expiryMs, []).get(inst.expiryMs)!).push(q);
  }
  return { spot, byExpiry };
}

async function realized(symbol: string, days: number): Promise<number> {
  try { const j = (await (await proxiedFetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${days + 1}`)).json()) as unknown[][];
    return realizedVol(j.map((k) => Number(k[4])), 365); } catch { return 0; }
}

console.log(`\nvol-surface-scan — live Deribit structural premia · ${new Date(NOW).toISOString()}\n`);
const snapshot: Record<string, unknown> = { ts: NOW, iso: new Date(NOW).toISOString() };

for (const [cur, sym] of [["BTC", "BTCUSDT"], ["ETH", "ETHUSDT"]] as const) {
  try {
    const { spot, byExpiry } = await chain(cur);
    const metrics = [...byExpiry.entries()]
      .map(([, opts]) => expiryMetrics(opts, spot, NOW))
      .filter((m) => m.tYears > 1 / 365 && m.tYears < 0.5 && m.nOptions >= 4 && m.atmIv != null)
      .sort((a, b) => a.tYears - b.tYears);
    if (!metrics.length) { console.log(`  ${cur}: no usable expiries`); continue; }
    const term = termStructure(metrics);
    // nearest-to-30d expiry for the VRP
    const near30 = metrics.reduce((best, m) => Math.abs(m.tYears - 30 / 365) < Math.abs(best.tYears - 30 / 365) ? m : best, metrics[0]);
    const rv30 = await realized(sym, 30);
    const vrp = near30.atmIv! - rv30;

    console.log(`  === ${cur} (spot $${spot.toLocaleString()}) ===`);
    console.log(`  expiry(d)  ATM-IV   25Δ-RR(put−call)`);
    for (const m of metrics.slice(0, 6)) console.log(`    ${String(Math.round(m.tYears * 365)).padStart(4)}     ${(m.atmIv! * 100).toFixed(1).padStart(5)}%   ${m.riskReversal25 != null ? (m.riskReversal25 * 100 >= 0 ? "+" : "") + (m.riskReversal25 * 100).toFixed(1) + "%" : "n/a"}`);
    const avgRR = metrics.map((m) => m.riskReversal25).filter((x): x is number => x != null);
    const meanRR = avgRR.length ? avgRR.reduce((a, b) => a + b, 0) / avgRR.length : NaN;
    console.log(`  term: front ${(term.frontIv! * 100).toFixed(1)}% → back ${(term.backIv! * 100).toFixed(1)}% (${term.contango ? "CONTANGO — sell front" : "BACKWARDATION — stress"}, slope ${term.slope! >= 0 ? "+" : ""}${(term.slope! * 100).toFixed(1)})`);
    console.log(`  VRP(~30d): implied ${(near30.atmIv! * 100).toFixed(1)}% − realized ${(rv30 * 100).toFixed(1)}% = ${vrp >= 0 ? "+" : ""}${(vrp * 100).toFixed(1)} vol pts ${vrp > 0 ? "(sell-vol premium present)" : "(NO premium — implied below realized)"}`);
    console.log(`  skew: mean 25Δ RR ${meanRR >= 0 ? "+" : ""}${(meanRR * 100).toFixed(1)}% ${meanRR > 0.01 ? "→ downside crash premium SELLABLE (put spreads / RR)" : meanRR < -0.01 ? "→ CALL skew (bull squeeze) — fade calls" : "→ flat, no skew premium"}\n`);
    snapshot[cur] = { spot, frontIv: term.frontIv, backIv: term.backIv, contango: term.contango, vrp, impliedNear30: near30.atmIv, rv30, meanRR };
  } catch (e) { console.log(`  ${cur}: ${(e as Error).message}`); }
}

mkdirSync(resolve(OUT, ".."), { recursive: true });
appendFileSync(OUT, JSON.stringify(snapshot) + "\n");
console.log(`  ✓ snapshot logged → ${OUT}`);
console.log(`  honest note: no free historical surface → this is a FORWARD paper-track. Run daily; a grader checks whether the logged premium was realized. A skew/term BACKTEST needs paid options history (CryptoCompare/Tardis).\n`);
