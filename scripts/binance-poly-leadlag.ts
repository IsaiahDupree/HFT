/**
 * binance-poly-leadlag — measure TODAY's actual lag between Binance price moves
 * and Polymarket crypto-binary repricing. The viral article claims 2.7s; this
 * measures it instead of trusting it.
 *
 * Two measurements:
 *   1. Cross-correlation lead-lag (same machinery as analyze:ws-leadlag):
 *      Binance trade returns vs Polymarket mid returns on a uniform grid.
 *   2. Event study (the actionable number): for each Binance move ≥ --move-bps
 *      within a 5s window, how many seconds until the Polymarket mid moves
 *      ≥ 1¢ in the implied direction — and how often it NEVER reprices (the
 *      stale quote you could lift).
 *
 *   npx tsx scripts/binance-poly-leadlag.ts -- --token <clobTokenId> --symbol ETH \
 *       --seconds 180 --bucket-ms 250 --move-bps 5
 *
 * Polymarket side: CLOB market WS (book + price_change events, exchange ts).
 * Binance side: trade WS (exchange ts), DATA_PROXY_URL honored like ws-leadlag.
 */
import "./_env.ts";
import WebSocket from "ws";
import { createRequire } from "node:module";
import { resampleLastPrice, trimToCommon, toReturns, leadLag } from "../src/lib/data/lead-lag.ts";

const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

const flag = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const TOKEN = flag("--token", "");
const SYM = flag("--symbol", "ETH").toUpperCase();
const SECONDS = Number(flag("--seconds", "180"));
const BUCKET_MS = Number(flag("--bucket-ms", "250"));
const MOVE_BPS = Number(flag("--move-bps", "5"));
if (!TOKEN) { console.error("need --token <clobTokenId>"); process.exit(1); }

type Tick = { ts: number; price: number };
const binance: Tick[] = [];
const poly: Tick[] = [];

const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

console.log(`binance-poly-leadlag — ${SYM}USDT vs Polymarket token …${TOKEN.slice(-8)}`);
console.log(`  capture ${SECONDS}s · grid ${BUCKET_MS}ms · event threshold ${MOVE_BPS}bps · binance proxy ${agent ? "ON" : "OFF"}\n`);

// ── Binance trades ──
const bn = new WebSocket(
  `wss://stream.binance.com:9443/ws/${SYM.toLowerCase()}usdt@trade`,
  agent ? { agent } : undefined,
);
bn.on("message", (d: WebSocket.RawData) => {
  try {
    const m = JSON.parse(d.toString());
    if (m?.p && m?.T) binance.push({ ts: Number(m.T), price: Number(m.p) });
  } catch { /* */ }
});
bn.on("error", (e) => console.log(`  binance ws error: ${(e as Error).message.slice(0, 80)}`));

// ── Polymarket CLOB market channel ──
let polyBid = NaN, polyAsk = NaN;
function pushPolyMid(ts: number): void {
  if (Number.isFinite(polyBid) && Number.isFinite(polyAsk) && polyBid > 0 && polyAsk > 0) {
    poly.push({ ts, price: (polyBid + polyAsk) / 2 });
  }
}
const pm = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
pm.on("open", () => {
  pm.send(JSON.stringify({ assets_ids: [TOKEN], type: "market" }));
  console.log("  polymarket ws subscribed");
});
pm.on("message", (d: WebSocket.RawData) => {
  const recv = Date.now();
  try {
    const arr = JSON.parse(d.toString());
    for (const m of Array.isArray(arr) ? arr : [arr]) {
      const ts = Number(m?.timestamp) || recv;
      if (m?.event_type === "book") {
        const bb = (m.bids ?? m.buys ?? []).reduce((mx: number, l: any) => Math.max(mx, Number(l.price)), -Infinity);
        const ba = (m.asks ?? m.sells ?? []).reduce((mn: number, l: any) => Math.min(mn, Number(l.price)), Infinity);
        if (Number.isFinite(bb)) polyBid = bb;
        if (Number.isFinite(ba)) polyAsk = ba;
        pushPolyMid(ts);
      } else if (m?.event_type === "price_change") {
        for (const ch of m.changes ?? []) {
          const px = Number(ch.price);
          if (!Number.isFinite(px)) continue;
          if (ch.side === "BUY" && (px > polyBid || !Number.isFinite(polyBid))) polyBid = px;
          if (ch.side === "SELL" && (px < polyAsk || !Number.isFinite(polyAsk))) polyAsk = px;
        }
        pushPolyMid(ts);
      } else if (m?.event_type === "last_trade_price" && m?.price) {
        poly.push({ ts, price: Number(m.price) });
      }
    }
  } catch { /* */ }
});
pm.on("error", (e) => console.log(`  polymarket ws error: ${(e as Error).message.slice(0, 80)}`));

// keepalive ping (CLOB WS drops silent connections)
const ka = setInterval(() => { if (pm.readyState === WebSocket.OPEN) pm.send("PING"); }, 10_000);

// REST /book poller fallback — the WS market channel can be silent on quiet books;
// 2Hz top-of-book sampling still resolves multi-second repricing lags fine.
let lastRestMid = NaN;
const restPoll = setInterval(async () => {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${TOKEN}`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return;
    const b = (await r.json()) as { bids?: { price: string }[]; asks?: { price: string }[] };
    const bb = (b.bids ?? []).reduce((mx, l) => Math.max(mx, Number(l.price)), -Infinity);
    const ba = (b.asks ?? []).reduce((mn, l) => Math.min(mn, Number(l.price)), Infinity);
    if (!Number.isFinite(bb) || !Number.isFinite(ba) || bb <= 0 || ba <= 0) return;
    const mid = (bb + ba) / 2;
    if (mid !== lastRestMid) {
      lastRestMid = mid;
      poly.push({ ts: Date.now(), price: mid });
    }
  } catch { /* */ }
}, 500);

await new Promise<void>((r) => setTimeout(r, SECONDS * 1000));
clearInterval(ka);
clearInterval(restPoll);
try { bn.close(); } catch { /* */ }
try { pm.close(); } catch { /* */ }

console.log(`\ncaptured: binance ${binance.length} trades · polymarket ${poly.length} mid updates`);
if (binance.length < 50 || poly.length < 5) {
  console.log("not enough ticks on one side — try a longer window, a livelier market, or check the proxy.");
  process.exit(0);
}

// ── 1. cross-correlation lead-lag ──
const t0 = Math.max(binance[0]!.ts, poly[0]!.ts);
const t1 = Math.min(binance[binance.length - 1]!.ts, poly[poly.length - 1]!.ts);
const gb = resampleLastPrice(binance, BUCKET_MS, t0, t1);
const gp = resampleLastPrice(poly, BUCKET_MS, t0, t1);
const { a, b } = trimToCommon(gb, gp);
const ra = toReturns(a), rb = toReturns(b);
const maxLag = Math.max(4, Math.round(15_000 / BUCKET_MS)); // ±15s search
const ll = leadLag(ra, rb, maxLag);
console.log(`\n— cross-correlation (±${(maxLag * BUCKET_MS / 1000).toFixed(0)}s window) —`);
console.log(`  best lag: ${(ll.bestLag * BUCKET_MS / 1000).toFixed(2)}s (positive = Binance LEADS Polymarket) · corr ${ll.bestCorr.toFixed(3)}`);

// ── 2. event study: Binance impulse → Polymarket response time ──
const W_MS = 5_000;
const events: { ts: number; dir: 1 | -1; bps: number }[] = [];
let lastEventTs = 0;
for (let i = 0; i < binance.length; i++) {
  const now = binance[i]!;
  if (now.ts - lastEventTs < W_MS) continue; // non-overlapping events
  let j = i;
  while (j > 0 && now.ts - binance[j - 1]!.ts <= W_MS) j--;
  const past = binance[j]!;
  const bps = ((now.price - past.price) / past.price) * 10_000;
  if (Math.abs(bps) >= MOVE_BPS) {
    events.push({ ts: now.ts, dir: bps > 0 ? 1 : -1, bps });
    lastEventTs = now.ts;
  }
}
console.log(`\n— event study: ${events.length} Binance moves ≥${MOVE_BPS}bps in ${W_MS / 1000}s —`);
const responses: number[] = [];
let stale = 0;
const RESP_CENTS = 0.01, RESP_WINDOW_MS = 30_000;
for (const ev of events) {
  const before = poly.filter((p) => p.ts <= ev.ts).at(-1);
  if (!before) continue;
  const after = poly.find(
    (p) => p.ts > ev.ts && p.ts <= ev.ts + RESP_WINDOW_MS && (p.price - before.price) * ev.dir >= RESP_CENTS,
  );
  if (after) responses.push((after.ts - ev.ts) / 1000);
  else stale++;
}
if (responses.length) {
  responses.sort((x, y) => x - y);
  const med = responses[Math.floor(responses.length / 2)]!;
  console.log(`  responded within 30s: ${responses.length} · median response ${med.toFixed(1)}s · fastest ${responses[0]!.toFixed(1)}s · slowest ${responses.at(-1)!.toFixed(1)}s`);
}
console.log(`  NO ≥1¢ reprice within 30s: ${stale}/${events.length} events (the stale-quote pool — but check spread before calling it edge)`);

console.log(`\nNote: cross-correlation on a daily-strike market mostly reflects how often anyone quotes; the`);
console.log(`event-study median is the actionable number. 5-min Up/Down markets reprice differently — rerun there.`);
