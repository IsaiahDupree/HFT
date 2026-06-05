/**
 * discover-high-funding — rank ALL Binance perps by current funding (fapi/v1/premiumIndex via the
 * proxy) so we can test the carry thesis where funding is actually big (small-cap alts spike to
 * 50-100%+ APR), not the majors where it's ~0. Prints the top |funding| symbols + suggested coins.
 *
 *   npm run discover:high-funding [-- --top 30 --min-apr 30]
 */
import "./_env.ts";
import { proxiedFetch, dataProxyStatus } from "../src/lib/data/proxy-fetch.ts";

const flag = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const top = Number(flag("--top", "30"));
const minApr = Number(flag("--min-apr", "30"));

const st = dataProxyStatus();
console.log(`\ndiscover-high-funding — Binance perps by |funding| · proxy ${st.enabled ? "ON" : "OFF"}\n`);

const r = await proxiedFetch("https://fapi.binance.com/fapi/v1/premiumIndex", { signal: AbortSignal.timeout(20_000) });
if (!r.ok) { console.log(`  premiumIndex → HTTP ${r.status}`); process.exit(1); }
const all = (await r.json()) as Array<{ symbol: string; lastFundingRate: string }>;

// USDT perps only, APR = rate × 3 funding/day × 365.
const ranked = all
  .filter((x) => /USDT$/.test(x.symbol) && Number.isFinite(+x.lastFundingRate))
  .map((x) => ({ symbol: x.symbol, coin: x.symbol.replace(/USDT$/, ""), rate: +x.lastFundingRate, apr: +x.lastFundingRate * 3 * 365 * 100 }))
  .sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));

console.log(`  ${ranked.length} USDT perps · showing top ${top} by |current funding APR|\n`);
console.log(`  ${"coin".padEnd(14)} ${"funding(8h)".padEnd(13)} APR`);
for (const x of ranked.slice(0, top)) {
  console.log(`  ${x.coin.padEnd(14)} ${(x.rate * 100).toFixed(4).padEnd(13)}% ${x.apr >= 0 ? "+" : ""}${x.apr.toFixed(1)}%`);
}
const picks = ranked.filter((x) => Math.abs(x.apr) >= minApr).slice(0, top).map((x) => x.coin);
console.log(`\n  ${picks.length} coins with |APR| ≥ ${minApr}% → fetch with:`);
console.log(`  npm run fetch:funding:binance -- --days 500 --coins ${picks.join(",")}\n`);
