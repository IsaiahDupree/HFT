/**
 * capture-l2-dydx — record REAL dYdX v4 perp L2 (top-of-book + trades) into the
 * same MarketEvent JSONL the event-driven L2 backtester consumes, and report the
 * depth/spread profile + the OFI signal's predictive power (calibrateOfiAlpha) on
 * the captured deep-book data.
 *
 * Read-only public indexer — NO wallet needed (trading needs one; market data
 * does not). This tests the central thesis: dYdX perps have deep liquidity where
 * market-making can fill, unlike Polymarket's thin binary books.
 *
 *   npm run capture:dydx -- --markets BTC-USD,ETH-USD,SOL-USD --duration 90 --interval 1
 *
 * NOTE: the existing asMmSignalStrategy is logit/(0,1)-space (Polymarket binaries);
 * a dollar-space AS-MM adapter to backtest dYdX fills/PnL is a follow-up. OFI/VPIN
 * signals are price-agnostic, so the calibration here is valid on dYdX dollar prices.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { calibrateOfiAlpha } from "../src/lib/backtest/l2/signals.ts";
import type { MarketEvent } from "../src/lib/backtest/l2/engine.ts";

const INDEXER = process.env.DYDX_INDEXER ?? "https://indexer.dydx.trade/v4";
const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const markets = arg("--markets", "BTC-USD,ETH-USD,SOL-USD").split(",").map((s) => s.trim());
const intervalMs = Math.max(250, Number(arg("--interval", "1")) * 1000);
const durationSec = Number(arg("--duration", "90"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

async function getJson(path: string): Promise<any | null> {
  try {
    const r = await fetch(`${INDEXER}${path}`, { headers: { "User-Agent": "hft/dydx-capture" }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(process.cwd(), "data", "captures-dydx", date);
mkdirSync(outDir, { recursive: true });

const events: Record<string, MarketEvent[]> = {};
const seenTrades: Record<string, Set<string>> = {};
const bookDepth: Record<string, { bidUsd: number[]; askUsd: number[]; levels: number[] }> = {};

console.log(`capture-l2-dydx: ${markets.join(",")} · every ${intervalMs / 1000}s for ${durationSec}s → ${outDir}\n`);
const start = Date.now();
let polls = 0;
while ((Date.now() - start) / 1000 < durationSec) {
  for (const m of markets) {
    const book = await getJson(`/orderbooks/perpetualMarket/${m}`);
    const bids = book?.bids ?? [], asks = book?.asks ?? [];
    if (bids.length && asks.length) {
      const ts = Date.now() / 1000;
      const ev: MarketEvent = { ts, kind: "book", bidPx: +bids[0].price, bidSz: +bids[0].size, askPx: +asks[0].price, askSz: +asks[0].size };
      if (ev.bidPx > 0 && ev.askPx > ev.bidPx) {
        (events[m] ??= []).push(ev);
        appendFileSync(`${outDir}/${m}.jsonl`, JSON.stringify(ev) + "\n");
        // depth within ±5 bps of mid (the liquidity a maker actually rests against)
        const mid = (ev.bidPx + ev.askPx) / 2, band = mid * 0.0005;
        const bidUsd = bids.filter((l: any) => +l.price >= mid - band).reduce((s: number, l: any) => s + +l.size * +l.price, 0);
        const askUsd = asks.filter((l: any) => +l.price <= mid + band).reduce((s: number, l: any) => s + +l.size * +l.price, 0);
        (bookDepth[m] ??= { bidUsd: [], askUsd: [], levels: [] });
        bookDepth[m].bidUsd.push(bidUsd); bookDepth[m].askUsd.push(askUsd); bookDepth[m].levels.push(Math.min(bids.length, asks.length));
      }
    }
    const tr = await getJson(`/trades/perpetualMarket/${m}?limit=50`);
    for (const t of (tr?.trades ?? [])) {
      const id = String(t.id ?? `${t.createdAt}-${t.price}-${t.size}`);
      const seen = (seenTrades[m] ??= new Set());
      if (seen.has(id)) continue;
      seen.add(id);
      const ts = Date.parse(t.createdAt) / 1000;
      if (!Number.isFinite(ts)) continue;
      const ev: MarketEvent = { ts, kind: "trade", price: +t.price, size: +t.size, aggressor: (t.side === "BUY" ? "BUY" : "SELL") };
      (events[m] ??= []).push(ev);
      appendFileSync(`${outDir}/${m}.jsonl`, JSON.stringify(ev) + "\n");
    }
    await sleep(120); // gentle per-market spacing
  }
  polls++;
  if (polls % 10 === 0) process.stdout.write(`  ${polls} polls (${Math.round((Date.now() - start) / 1000)}s)\r`);
  await sleep(intervalMs);
}

console.log(`\n\n  ${"market".padEnd(10)} ${"books".padEnd(7)} ${"trades".padEnd(7)} ${"spread".padEnd(9)} ${"depth±5bps (bid/ask USD)".padEnd(26)} OFI signal (β · R² · n)`);
for (const m of markets) {
  const evs = (events[m] ?? []).slice().sort((a, b) => a.ts - b.ts);
  const books = evs.filter((e) => e.kind === "book");
  const trades = evs.filter((e) => e.kind === "trade");
  if (!books.length) { console.log(`  ${m.padEnd(10)} (no book data)`); continue; }
  const spr = mean(books.map((b: any) => (b.askPx - b.bidPx) / ((b.askPx + b.bidPx) / 2) * 1e4));
  const d = bookDepth[m] ?? { bidUsd: [0], askUsd: [0], levels: [0] };
  const cal = calibrateOfiAlpha(evs, { horizonSec: 3, ofiWindowSec: 3, space: "logprice" });
  const depthStr = `$${(mean(d.bidUsd) / 1000).toFixed(0)}k / $${(mean(d.askUsd) / 1000).toFixed(0)}k`;
  console.log(`  ${m.padEnd(10)} ${String(books.length).padEnd(7)} ${String(trades.length).padEnd(7)} ${`${spr.toFixed(2)}bps`.padEnd(9)} ${depthStr.padEnd(26)} β=${cal.alphaBeta.toExponential(2)} R²=${cal.r2.toFixed(3)} n=${cal.n}`);
}
console.log(`\n  JSONL written to ${outDir} — replay with the L2 backtester (loadCaptureJsonl).`);
console.log(`  R² = how much of the next-second price move OFI explains; higher = more tradeable microstructure alpha.\n`);
