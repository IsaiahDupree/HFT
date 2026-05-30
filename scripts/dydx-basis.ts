/**
 * Spot-perp basis monitor: Coinbase BTC-USD spot mid vs dYdX BTC-USD perp
 * oracle, plus dYdX's published next funding rate. No auth, no orders.
 *
 *   npm run dydx:basis                                # default BTC, 5s tick, 120s
 *   npm run dydx:basis -- --asset ETH
 *   npm run dydx:basis -- --tick-ms 2000 --ttl 600 --alert 5
 *
 * `--alert N` triggers a console alert when |basisBps| > N. Writes a JSON
 * history to docs/dydx-basis-results.json.
 */
import "./_env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeBasis } from "../src/lib/hft/basis";
import { makeIndexerClient, resolveNet } from "../src/lib/hft/dydx";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const net = resolveNet();
if (net === "testnet") {
  console.warn("[basis] note: dYdX testnet has thin perp liquidity. Use --mainnet for meaningful basis.");
}
const asset = argValue("asset", "BTC").toUpperCase();
const tickMs = Number(argValue("tick-ms", "5000"));
const ttlSec = Number(argValue("ttl", "120"));
const alertBps = Number(argValue("alert", "10"));

const perpTicker = `${asset}-USD`;
const coinbaseProduct = `${asset}-USD`;
const COINBASE_PUBLIC = "https://api.coinbase.com/api/v3/brokerage/market";

const indexer = makeIndexerClient(net);

type Sample = {
  ts: number; cycle: number;
  spot: number; perp: number;
  basis: number; basisBps: number;
  fundingBpsHourly: number; fundingApr: number;
  preferredLeg: string;
};

const samples: Sample[] = [];
let cycle = 0;
let stop = false;

console.log(`Basis monitor • ${coinbaseProduct} (Coinbase) vs ${perpTicker} (dYdX ${net}) • tick=${tickMs}ms • ttl=${ttlSec}s • alert=${alertBps}bps`);

process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });
setTimeout(() => { stop = true; }, ttlSec * 1000).unref?.();

async function coinbaseSpotMid(productId: string): Promise<number> {
  const r = await fetch(`${COINBASE_PUBLIC}/products/${encodeURIComponent(productId)}/ticker?limit=1`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`coinbase ticker ${r.status}`);
  const j: any = await r.json();
  const bid = Number(j.best_bid);
  const ask = Number(j.best_ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (j.price) return Number(j.price);
  throw new Error("coinbase ticker missing bid/ask/price");
}

(async () => {
  while (!stop) {
    cycle++;
    const t0 = Date.now();
    try {
      const [spot, m] = await Promise.all([
        coinbaseSpotMid(coinbaseProduct),
        indexer.markets.getPerpetualMarkets(perpTicker),
      ]);
      const mInfo = (m as any)?.markets?.[perpTicker];
      if (!mInfo) throw new Error(`dYdX market ${perpTicker} not found`);
      const perp = Number(mInfo.oraclePrice);
      const fundingRate = Number(mInfo.nextFundingRate ?? 0);

      const r = computeBasis({ spot, perp, nextFundingRate: fundingRate, fundingHorizonHours: 1 });

      const s: Sample = {
        ts: Date.now(), cycle, spot, perp,
        basis: r.basis, basisBps: r.basisBps,
        fundingBpsHourly: r.fundingBpsHourly, fundingApr: r.fundingApr,
        preferredLeg: r.preferredLeg,
      };
      samples.push(s);

      const alertTag = Math.abs(r.basisBps) > alertBps ? "⚠ " : "  ";
      const dir = r.preferredLeg === "long-basis" ? "↑LONG-BASIS" : r.preferredLeg === "short-basis" ? "↓SHORT-BASIS" : "·flat";
      console.log(
        `${alertTag}cyc=${cycle.toString().padStart(3)} ` +
        `spot=$${spot.toFixed(2).padStart(10)} perp=$${perp.toFixed(2).padStart(10)} ` +
        `basis=$${r.basis.toFixed(2).padStart(6)} (${r.basisBps.toFixed(2).padStart(6)}bps) ` +
        `funding=${r.fundingBpsHourly.toFixed(3)}bps/h (${(r.fundingApr * 100).toFixed(1)}% APR) ${dir}`
      );
    } catch (e) {
      console.warn(`  cyc=${cycle} error: ${(e as Error).message.slice(0, 120)}`);
    }
    if (stop) break;
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(0, tickMs - elapsed)));
  }

  // Summary.
  const bps = samples.map((s) => s.basisBps);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const stdev = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };
  const summary = {
    asset, net, cycles: samples.length, tickMs,
    basisBps: bps.length ? {
      mean: +mean(bps).toFixed(3), stdev: +stdev(bps).toFixed(3),
      min: +Math.min(...bps).toFixed(3), max: +Math.max(...bps).toFixed(3),
    } : null,
    alertTriggers: samples.filter((s) => Math.abs(s.basisBps) > alertBps).length,
    when: new Date().toISOString(),
  };
  console.log("\n── Summary ──");
  console.log(JSON.stringify(summary, null, 2));
  const outPath = resolve(process.cwd(), "docs", "dydx-basis-results.json");
  writeFileSync(outPath, JSON.stringify({ ...summary, samples }, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0);
})();
