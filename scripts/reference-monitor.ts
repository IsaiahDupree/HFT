/**
 * reference-monitor — live use of the lead-lag finding: Binance (leader) is the reference price;
 * watch Coinbase (follower) and flag when it diverges (a transient mispricing it should close) or
 * goes STALE (data-quality alert). Streams both venues' WS (Binance via the proxy).
 *
 *   npm run monitor:reference [-- --seconds 45 --symbol BTC --align-bps 5 --stale-bps 100]
 */
import "./_env.ts";
import WebSocket from "ws";
import { createRequire } from "node:module";
import { referenceSignal, isStaleByAge, basisBps, ewma, type RefState } from "../src/lib/data/reference-price.ts";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

const flag = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const seconds = Number(flag("--seconds", "45"));
const sym = flag("--symbol", "BTC").toUpperCase();
const alignBps = Number(flag("--align-bps", "5"));
const staleBps = Number(flag("--stale-bps", "100"));

const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
let leader = { px: NaN, ts: NaN };   // Binance (price-discovery)
let follower = { px: NaN, ts: NaN }; // Coinbase
const tally: Record<RefState, number> = { aligned: 0, follower_rich: 0, follower_cheap: 0, stale: 0 };
let checks = 0, maxDevBps = 0, lastState: RefState | "" = "", lastPrintMs = 0;
let baseline = NaN, warmup = 0; // EWMA of the structural basis (e.g. USDT/USD) — de-mean against it

console.log(`\nreference-monitor — ${sym} · ${seconds}s · leader=Binance(proxy ${agent ? "ON" : "OFF"}) follower=Coinbase · align ${alignBps}bps · stale ${staleBps}bps\n`);

function evaluate(nowMs: number): void {
  if (!Number.isFinite(leader.px) || !Number.isFinite(follower.px)) return;
  checks++;
  // Track the STRUCTURAL basis (e.g. USDT/USD ~13bps) with a slow EWMA, then judge DEVIATIONS
  // from it — a persistent offset is not a convergence trade; a sudden widening is.
  const rawBasis = basisBps(leader.px, follower.px);
  baseline = ewma(baseline, rawBasis, 0.01);
  warmup++;
  const ageStale = isStaleByAge(follower.ts, nowMs, 3000);
  const sig = referenceSignal(leader.px, follower.px, { alignBps, staleBps, baselineBps: baseline });
  const dev = rawBasis - baseline;
  const state: RefState = ageStale ? "stale" : warmup < 100 ? "aligned" : sig.state; // warm the baseline first
  tally[state]++;
  if (Math.abs(dev) > maxDevBps && warmup >= 100) maxDevBps = Math.abs(dev);
  const changed = state !== lastState;
  if (((sig.actionable && warmup >= 100) || state === "stale") && (changed || nowMs - lastPrintMs > 500)) {
    lastPrintMs = nowMs;
    const tag = state === "stale" ? "⚠ STALE/feed" : sig.expectedFollowerMove === "down" ? "↓ CB rich vs usual → expect down" : "↑ CB cheap vs usual → expect up";
    console.log(`  ${new Date(nowMs).toISOString().slice(11, 23)}  BN ${leader.px.toFixed(2)}  CB ${follower.px.toFixed(2)}  basis ${rawBasis.toFixed(1)} (norm ${baseline.toFixed(1)}) dev ${dev >= 0 ? "+" : ""}${dev.toFixed(1)}bps  ${tag}${ageStale ? " (age>3s)" : ""}`);
  }
  lastState = state;
}

const bn = new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}usdt@trade`, agent ? { agent } : undefined);
bn.on("message", (d: WebSocket.RawData) => { try { const m = JSON.parse(d.toString()); if (m?.p != null) { leader = { px: +m.p, ts: Date.now() }; evaluate(Date.now()); } } catch { /* */ } });
bn.on("error", (e) => console.log(`  binance ws error: ${(e as Error).message.slice(0, 60)}`));

const cb = new WebSocket("wss://advanced-trade-ws.coinbase.com");
cb.on("open", () => cb.send(JSON.stringify({ type: "subscribe", channel: "ticker", product_ids: [`${sym}-USD`] })));
cb.on("message", (d: WebSocket.RawData) => { try { const m = JSON.parse(d.toString()); const px = m?.events?.[0]?.tickers?.[0]?.price; if (px != null) { follower = { px: +px, ts: Date.now() }; evaluate(Date.now()); } } catch { /* */ } });
cb.on("error", (e) => console.log(`  coinbase ws error: ${(e as Error).message.slice(0, 60)}`));

setTimeout(() => {
  try { bn.close(); } catch {} try { cb.close(); } catch {}
  const pct = (n: number) => checks ? `${(n / checks * 100).toFixed(0)}%` : "0%";
  console.log(`\n  ${checks} checks · structural basis ~${Number.isFinite(baseline) ? baseline.toFixed(1) : "?"}bps · max DEVIATION ${maxDevBps.toFixed(1)}bps`);
  console.log(`  at-baseline ${pct(tally.aligned)} · dev-rich ${pct(tally.follower_rich)} · dev-cheap ${pct(tally.follower_cheap)} · stale ${pct(tally.stale)}`);
  console.log(`  → reference = Binance; ${tally.follower_rich + tally.follower_cheap} basis-deviation events, ${tally.stale} stale-feed flags in ${seconds}s (persistent ${Number.isFinite(baseline) ? baseline.toFixed(0) : "?"}bps offset de-meaned)\n`);
  process.exit(0);
}, seconds * 1000);
