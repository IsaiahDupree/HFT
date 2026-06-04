/**
 * ws-leadlag-capture — the DEFINITIVE "which source is ahead" measurement. Captures live trade/
 * ticker ticks from Coinbase (direct) + Binance (via proxy), then cross-correlates their returns
 * at sub-second resolution. Reports lead-lag TWO ways:
 *   • EXCHANGE-clock  — uses each venue's own timestamp → true price-discovery lead (the honest one)
 *   • RECEIVE-clock   — uses local arrival time → confounded by network path (proxy adds latency to
 *                       Binance), shown only to demonstrate why recv-time lead-lag is misleading.
 *
 *   npm run analyze:ws-leadlag [-- --seconds 60 --bucket-ms 200 --symbol BTC]
 */
import "./_env.ts";
import WebSocket from "ws";
import { createRequire } from "node:module";
import { resampleLastPrice, trimToCommon, toReturns, leadLag } from "../src/lib/data/lead-lag.ts";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

const flag = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const seconds = Number(flag("--seconds", "60"));
const bucketMs = Number(flag("--bucket-ms", "200"));
const sym = flag("--symbol", "BTC").toUpperCase();
const maxLagBuckets = Math.max(4, Math.round(2000 / bucketMs)); // ±2s search window

type Sample = { exTs: number; recvTs: number; price: number };
const cap: Record<string, Sample[]> = { coinbase: [], binance: [] };
const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

console.log(`\nws-leadlag-capture — ${sym} · ${seconds}s · ${bucketMs}ms buckets · Coinbase(direct) vs Binance(proxy ${agent ? "ON" : "OFF"})\n  capturing…`);

const cb = new WebSocket("wss://advanced-trade-ws.coinbase.com");
cb.on("open", () => cb.send(JSON.stringify({ type: "subscribe", channel: "ticker", product_ids: [`${sym}-USD`] })));
cb.on("message", (d: WebSocket.RawData) => {
  const recvTs = Date.now();
  try {
    const m = JSON.parse(d.toString());
    const tk = m?.events?.[0]?.tickers?.[0];
    if (tk?.price != null) {
      const exTs = m.timestamp ? Date.parse(m.timestamp) : recvTs;
      cap.coinbase.push({ exTs: Number.isFinite(exTs) ? exTs : recvTs, recvTs, price: +tk.price });
    }
  } catch { /* */ }
});
cb.on("error", (e) => console.log(`  coinbase ws error: ${(e as Error).message.slice(0, 60)}`));

const bn = new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}usdt@trade`, agent ? { agent } : undefined);
bn.on("message", (d: WebSocket.RawData) => {
  const recvTs = Date.now();
  try {
    const m = JSON.parse(d.toString());
    if (m?.p != null) cap.binance.push({ exTs: Number(m.T) || recvTs, recvTs, price: +m.p });
  } catch { /* */ }
});
bn.on("error", (e) => console.log(`  binance ws error: ${(e as Error).message.slice(0, 60)}`));

function analyze(label: string, key: "exTs" | "recvTs"): void {
  const cbT = cap.coinbase.map((s) => ({ ts: s[key], price: s.price })).sort((a, b) => a.ts - b.ts);
  const bnT = cap.binance.map((s) => ({ ts: s[key], price: s.price })).sort((a, b) => a.ts - b.ts);
  if (cbT.length < 10 || bnT.length < 10) { console.log(`  ${label}: too few ticks (cb ${cbT.length}, bn ${bnT.length})`); return; }
  const t0 = Math.max(cbT[0].ts, bnT[0].ts), t1 = Math.min(cbT[cbT.length - 1].ts, bnT[bnT.length - 1].ts);
  if (t1 - t0 < bucketMs * 20) { console.log(`  ${label}: overlap too short (${t1 - t0}ms)`); return; }
  const { a, b } = trimToCommon(resampleLastPrice(cbT, bucketMs, t0, t1), resampleLastPrice(bnT, bucketMs, t0, t1));
  const ll = leadLag(toReturns(a), toReturns(b), maxLagBuckets);
  const ms = ll.bestLag * bucketMs;
  const who = ll.leader === "A" ? `COINBASE leads by ${ms}ms` : ll.leader === "B" ? `BINANCE leads by ${-ms}ms` : "SYNCHRONOUS (no sub-second lead)";
  console.log(`  ${label.padEnd(16)} ${who} · peak corr ${ll.bestCorr.toFixed(3)} · lag0 ${ll.zeroCorr.toFixed(3)} · ${a.length} buckets`);
}

setTimeout(() => {
  try { cb.close(); } catch {} try { bn.close(); } catch {}
  console.log(`\n  captured: coinbase ${cap.coinbase.length} ticks · binance ${cap.binance.length} ticks\n`);
  analyze("EXCHANGE-clock", "exTs");   // the honest price-discovery lead
  analyze("RECEIVE-clock", "recvTs");  // confounded by proxy/network path
  console.log(`\n  (+lag = Coinbase first, −lag = Binance first. EXCHANGE-clock is the price-discovery answer;`);
  console.log(`   RECEIVE-clock is biased by the proxy hop on Binance — the gap between them ≈ that path latency.)\n`);
  process.exit(0);
}, seconds * 1000);
