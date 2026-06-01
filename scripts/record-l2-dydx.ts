/**
 * record-l2-dydx — dYdX v4 WebSocket L2 recorder. Unlike capture-l2-dydx (REST
 * polled ~2.5s, too coarse for OFI), this subscribes to the indexer's
 * `v4_orderbook` + `v4_trades` channels, maintains the full book from the
 * snapshot + incremental deltas, and emits a top-of-book MarketEvent on EVERY
 * update — sub-second resolution — so the OFI signal is measured on real book
 * deltas. Public market data; NO wallet. Writes the same MarketEvent JSONL the
 * L2 backtester consumes, then reports price-space OFI on the recorded stream.
 *
 *   npm run record:dydx -- --markets BTC-USD,ETH-USD,SOL-USD --duration 120
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { calibrateOfiAlpha } from "../src/lib/backtest/l2/signals.ts";
import type { MarketEvent } from "../src/lib/backtest/l2/engine.ts";

const WS_URL = process.env.DYDX_WS ?? "wss://indexer.dydx.trade/v4/ws";
const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const markets = arg("--markets", "BTC-USD,ETH-USD,SOL-USD").split(",").map((s) => s.trim());
const durationSec = Number(arg("--duration", "120"));
const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(process.cwd(), "data", "captures-dydx", date);
mkdirSync(outDir, { recursive: true });

// per-market book: price → size (only resting levels). best bid = max price, ask = min.
type Book = { bids: Map<number, number>; asks: Map<number, number> };
const books: Record<string, Book> = {};
const events: Record<string, MarketEvent[]> = {};
const counts: Record<string, { book: number; trade: number }> = {};
for (const m of markets) { books[m] = { bids: new Map(), asks: new Map() }; events[m] = []; counts[m] = { book: 0, trade: 0 }; }

function applyLevels(side: Map<number, number>, levels: any[]) {
  for (const lv of levels) {
    const px = Array.isArray(lv) ? +lv[0] : +lv.price;
    const sz = Array.isArray(lv) ? +lv[1] : +lv.size;
    if (!Number.isFinite(px)) continue;
    if (sz > 0) side.set(px, sz); else side.delete(px);
  }
}
function best(side: Map<number, number>, max: boolean): [number, number] | null {
  let bp: number | null = null;
  for (const p of side.keys()) { if (bp === null || (max ? p > bp : p < bp)) bp = p; }
  return bp === null ? null : [bp, side.get(bp)!];
}
function emitBook(m: string) {
  const bb = best(books[m].bids, true), ba = best(books[m].asks, false);
  if (!bb || !ba || bb[0] >= ba[0]) return;
  const ev: MarketEvent = { ts: Date.now() / 1000, kind: "book", bidPx: bb[0], bidSz: bb[1], askPx: ba[0], askSz: ba[1] };
  events[m].push(ev); counts[m].book++;
  appendFileSync(`${outDir}/${m}.ws.jsonl`, JSON.stringify(ev) + "\n");
}

const ws = new WebSocket(WS_URL);
ws.addEventListener("open", () => {
  console.log(`record-l2-dydx: connected ${WS_URL} · ${markets.join(",")} · ${durationSec}s\n`);
  for (const m of markets) {
    ws.send(JSON.stringify({ type: "subscribe", channel: "v4_orderbook", id: m }));
    ws.send(JSON.stringify({ type: "subscribe", channel: "v4_trades", id: m }));
  }
});
ws.addEventListener("message", (e: MessageEvent) => {
  let msg: any; try { msg = JSON.parse(e.data as string); } catch { return; }
  const m = msg.id as string;
  if (msg.channel === "v4_orderbook" && (msg.type === "subscribed" || msg.type === "channel_data") && m in books) {
    const c = msg.contents ?? {};
    if (c.bids) applyLevels(books[m].bids, c.bids);
    if (c.asks) applyLevels(books[m].asks, c.asks);
    emitBook(m);
  } else if (msg.channel === "v4_trades" && (msg.type === "subscribed" || msg.type === "channel_data") && m in books) {
    for (const t of (msg.contents?.trades ?? [])) {
      const ts = Date.parse(t.createdAt) / 1000;
      if (!Number.isFinite(ts)) continue;
      const ev: MarketEvent = { ts, kind: "trade", price: +t.price, size: +t.size, aggressor: (t.side === "BUY" ? "BUY" : "SELL") };
      events[m].push(ev); counts[m].trade++;
      appendFileSync(`${outDir}/${m}.ws.jsonl`, JSON.stringify(ev) + "\n");
    }
  } else if (msg.type === "error") {
    console.error(`  WS error: ${msg.message ?? JSON.stringify(msg)}`);
  }
});
ws.addEventListener("error", (e: any) => console.error(`  WS connection error: ${e?.message ?? e}`));

await new Promise((r) => setTimeout(r, durationSec * 1000));
try { ws.close(); } catch { /* noop */ }

console.log(`  ${"market".padEnd(10)} ${"book evts".padEnd(10)} ${"trades".padEnd(8)} ${"upd/s".padEnd(7)} OFI (price-space)`);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
for (const m of markets) {
  const evs = events[m].slice().sort((a, b) => a.ts - b.ts);
  const cal = calibrateOfiAlpha(evs, { horizonSec: 1, ofiWindowSec: 1, space: "logprice" });
  const updPerSec = (counts[m].book / Math.max(1, durationSec)).toFixed(1);
  console.log(`  ${m.padEnd(10)} ${String(counts[m].book).padEnd(10)} ${String(counts[m].trade).padEnd(8)} ${updPerSec.padEnd(7)} β=${cal.alphaBeta.toExponential(2)} R²=${cal.r2.toFixed(3)} n=${cal.n}`);
}
console.log(`\n  → sub-second book deltas (vs REST ~2.5s): n and R² should be far higher than capture-l2-dydx.`);
console.log(`  JSONL: ${outDir}/<market>.ws.jsonl\n`);
process.exit(0);
