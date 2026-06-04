/**
 * probe-binance-proxy — verify the Webshare proxy unlocks the FULL Binance API (api.binance.com
 * is HTTP 451 from US direct; fapi funding is the prize the public mirror can't serve).
 *
 *   npm run probe:binance-proxy
 */
import "./_env.ts";
import { proxiedFetch, dataProxyStatus, willProxy } from "../src/lib/data/proxy-fetch.ts";
import { fetchBinanceKlines, fetchBinanceFunding } from "../src/lib/data/binance.ts";

const st = dataProxyStatus();
console.log(`\nprobe-binance-proxy — proxy ${st.enabled ? `ON (${st.host})` : "OFF"} · routing ${st.hostsRouted.length} hosts\n`);

const targets = [
  { name: "api.binance.com klines (was 451)", url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2" },
  { name: "fapi funding rate (THE UNLOCK)", url: "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=3" },
  { name: "fapi premiumIndex (mark+funding)", url: "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT" },
  { name: "data-api.binance.vision (mirror, direct)", url: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2" },
];

for (const t of targets) {
  const via = willProxy(t.url) ? "proxy" : "direct";
  try {
    const r = await proxiedFetch(t.url, { signal: AbortSignal.timeout(20_000) });
    const body = (await r.text()).slice(0, 90);
    console.log(`  [${via.padEnd(6)}] ${r.status === 200 ? "✓" : "✗"} HTTP ${r.status}  ${t.name}`);
    console.log(`            ${body}${body.length >= 90 ? "…" : ""}`);
  } catch (e) {
    console.log(`  [${via.padEnd(6)}] ✗ ERROR ${t.name}: ${(e as Error).message.slice(0, 70)}`);
  }
}

// End-to-end through the typed adapter (parsers + proxied fetch).
console.log("\n  adapter end-to-end:");
try {
  const kl = await fetchBinanceKlines("BTCUSDT", "1d", { limit: 5 });
  console.log(`    fetchBinanceKlines BTCUSDT 1d → ${kl.length} bars, last close ${kl.at(-1)?.close}`);
  const fr = await fetchBinanceFunding("BTCUSDT", { limit: 5 });
  const ann = fr.length ? (fr.reduce((a, p) => a + p.rate, 0) / fr.length) * 3 * 365 * 100 : 0; // 3 funding/day
  console.log(`    fetchBinanceFunding BTCUSDT → ${fr.length} points, last rate ${fr.at(-1)?.rate} (~${ann.toFixed(1)}% APR annualized)`);
} catch (e) {
  console.log(`    adapter ERROR: ${(e as Error).message.slice(0, 90)}`);
}
console.log("");
