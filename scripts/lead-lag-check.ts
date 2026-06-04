/**
 * lead-lag-check — which crypto source is AHEAD, on minute candles. Aligns Coinbase (warehouse)
 * vs Binance (live, via proxy) vs Kraken (live) by timestamp, reports (1) cross-venue AGREEMENT
 * — does the price even match? resolves the "13% gap" question — and (2) minute-scale LEAD-LAG:
 * whose returns predict whose. NOTE: minute bars can only see leads ≥1 minute; for the real
 * sub-second answer use the WS tick capture. Binance minute klines come through the proxy.
 *
 *   npm run analyze:lead-lag [-- --coins BTC,ETH --max-lag 5]
 */
import "./_env.ts";
import { getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { fetchBinanceKlines } from "../src/lib/data/binance.ts";
import { fetchKrakenOHLC } from "../src/lib/data/kraken.ts";
import { crossVenueAgreement, alignVenueCloses } from "../src/lib/data/cross-venue.ts";
import { toReturns, leadLag } from "../src/lib/data/lead-lag.ts";
import { dataProxyStatus } from "../src/lib/data/proxy-fetch.ts";
import type { VenueCandle } from "../src/lib/data/venue-candles.ts";

const flag = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const coins = flag("--coins", "BTC,ETH").split(",").map((s) => s.trim().toUpperCase());
const maxLag = Number(flag("--max-lag", "5"));

const st = dataProxyStatus();
console.log(`\nlead-lag-check — Coinbase(warehouse) vs Binance(proxy ${st.enabled ? "ON" : "OFF"}) vs Kraken · ONE_MINUTE · maxLag ${maxLag}m\n`);

function leadLine(name: string, cb: VenueCandle[], bn: VenueCandle[]): void {
  const aligned = alignVenueCloses(cb, bn); // {start_unix, a=cb, b=bn}
  if (aligned.length < 30) { console.log(`    ${name}: only ${aligned.length} overlapping min — too few for lead-lag`); return; }
  const ll = leadLag(toReturns(aligned.map((x) => x.a)), toReturns(aligned.map((x) => x.b)), maxLag);
  const who = ll.leader === "A" ? "Coinbase leads" : ll.leader === "B" ? "Binance leads" : "synchronous (no minute-scale lead)";
  console.log(`    ${name}: ${who} · peak lag ${ll.bestLag}m corr ${ll.bestCorr.toFixed(3)} · lag0 corr ${ll.zeroCorr.toFixed(3)} · ${ll.samples} min`);
}

for (const c of coins) {
  console.log(`  ${c}-USD:`);
  try {
    const cb = await getCandles(`${c}-USD`, "ONE_MINUTE");
    const bn = await fetchBinanceKlines(`${c}USDT`, "1m", { limit: 1000 });
    let kr: VenueCandle[] = [];
    try { kr = await fetchKrakenOHLC(`${c}-USD`, "ONE_MINUTE"); } catch (e) { /* kraken minute may be absent for some */ }

    // (1) agreement — does the price match across venues? (resolve the 13% gap)
    const cbVbn = crossVenueAgreement(cb, bn, { maxBps: 50 });
    console.log(`    agree CB↔BN: overlap ${cbVbn.overlap}m · median ${cbVbn.medianBps.toFixed(1)}bps · p95 ${cbVbn.p95Bps.toFixed(1)} · max ${cbVbn.maxBps.toFixed(0)} · ${cbVbn.verdict}`);
    if (kr.length) {
      const cbVkr = crossVenueAgreement(cb, kr, { maxBps: 50 });
      console.log(`    agree CB↔KR: overlap ${cbVkr.overlap}m · median ${cbVkr.medianBps.toFixed(1)}bps · ${cbVkr.verdict}`);
    }

    // (2) lead-lag (only meaningful if they agree)
    if (cbVbn.verdict === "suspect" && cbVbn.medianBps > 100) {
      console.log(`    ⚠ CB & BN disagree by ${cbVbn.medianBps.toFixed(0)}bps median — different feeds; lead-lag is meaningless.`);
    } else {
      leadLine("lead CB↔BN", cb, bn);
    }
  } catch (e) {
    console.log(`    ERROR: ${(e as Error).message.slice(0, 100)}`);
  }
}
console.log("");
await closeTsdb();
