/**
 * probe-ws — does real-time WS streaming work here? Coinbase direct + Binance through the same
 * Webshare proxy (the `ws` lib accepts { agent }). Prints first ticks + receive timestamps so we
 * know whether a sub-second lead-lag capture is even possible in this environment.
 *
 *   npm run probe:ws
 */
import "./_env.ts";
import WebSocket from "ws";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

const RUN_MS = 12_000;
const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const counts: Record<string, number> = { coinbase: 0, binance: 0 };
const firstPrice: Record<string, number | undefined> = {};
const lastPrice: Record<string, number | undefined> = {};

console.log(`\nprobe-ws — 12s · Coinbase direct · Binance via proxy ${agent ? "ON" : "OFF"}\n`);

// --- Coinbase ticker (direct) ---
const cb = new WebSocket("wss://advanced-trade-ws.coinbase.com");
cb.on("open", () => { console.log("  coinbase: open → subscribe ticker BTC-USD"); cb.send(JSON.stringify({ type: "subscribe", channel: "ticker", product_ids: ["BTC-USD"] })); });
cb.on("message", (d: WebSocket.RawData) => {
  const recv = Date.now();
  try {
    const m = JSON.parse(d.toString());
    const px = m?.events?.[0]?.tickers?.[0]?.price;
    if (px != null) { counts.coinbase++; if (firstPrice.coinbase === undefined) { firstPrice.coinbase = +px; console.log(`  coinbase: first tick ${px} @ recv ${recv}`); } lastPrice.coinbase = +px; }
  } catch { /* non-JSON */ }
});
cb.on("error", (e) => console.log(`  coinbase: ERROR ${(e as Error).message.slice(0, 80)}`));

// --- Binance trade stream (via proxy) ---
const bn = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade", agent ? { agent } : undefined);
bn.on("open", () => console.log("  binance: open (btcusdt@trade)"));
bn.on("message", (d: WebSocket.RawData) => {
  const recv = Date.now();
  try {
    const m = JSON.parse(d.toString());
    if (m?.p != null) { counts.binance++; if (firstPrice.binance === undefined) { firstPrice.binance = +m.p; console.log(`  binance: first tick ${m.p} @ recv ${recv} (trade time ${m.T})`); } lastPrice.binance = +m.p; }
  } catch { /* non-JSON */ }
});
bn.on("error", (e) => console.log(`  binance: ERROR ${(e as Error).message.slice(0, 80)}`));

setTimeout(() => {
  console.log(`\n  ${RUN_MS / 1000}s summary: coinbase ${counts.coinbase} ticks (last ${lastPrice.coinbase}) · binance ${counts.binance} ticks (last ${lastPrice.binance})`);
  console.log(`  → WS streaming ${counts.coinbase > 0 && counts.binance > 0 ? "WORKS on both — sub-second lead-lag is possible" : counts.coinbase > 0 || counts.binance > 0 ? "works on ONE venue only" : "did NOT stream (sandbox may block WS)"}\n`);
  try { cb.close(); } catch {} try { bn.close(); } catch {}
  process.exit(0);
}, RUN_MS);
