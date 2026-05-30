/**
 * dYdX microstructure-signal stream. Polls the indexer orderbook for a market
 * and prints (and persists) order-book imbalance, microprice, and the
 * microprice-vs-oracle deviation. Useful as a research probe and as a smoke
 * test for the toxic-flow filter wired into the MM engine.
 *
 *   npm run dydx:obi                                  # mainnet BTC-USD, 2s tick, 60s
 *   npm run dydx:obi -- --testnet --market ETH-USD
 *   npm run dydx:obi -- --tick-ms 1000 --ttl 300 --levels 10
 *
 * Writes a JSON history to docs/dydx-obi-results.json.
 */
import "./_env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeMicroprice,
  computeOBI,
  makeIndexerClient,
  quotedSpreadBps,
  resolveNet,
  type BookLevel,
} from "../src/lib/hft/dydx";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const net = resolveNet();
const market = argValue("market", net === "mainnet" ? "BTC-USD" : "ETH-USD");
const tickMs = Number(argValue("tick-ms", "2000"));
const ttlSec = Number(argValue("ttl", "60"));
const levels = Number(argValue("levels", "5"));

const indexer = makeIndexerClient(net);

type Sample = {
  ts: number; cycle: number;
  oracle: number;
  bestBid: number | null; bestAsk: number | null;
  spreadBps: number | null;
  microprice: number | null;
  micropriceDevBps: number | null;
  obi: number;
  topBidSize: number; topAskSize: number;
};

const samples: Sample[] = [];
let cycle = 0;
let stop = false;

console.log(`dYdX OBI/microprice probe • net=${net} • market=${market} • tick=${tickMs}ms • ttl=${ttlSec}s • levels=${levels}`);

process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });

setTimeout(() => { stop = true; }, ttlSec * 1000).unref?.();

(async () => {
  while (!stop) {
    cycle++;
    const t0 = Date.now();
    try {
      const [m, ob] = await Promise.all([
        indexer.markets.getPerpetualMarkets(market),
        indexer.markets.getPerpetualMarketOrderbook(market),
      ]);
      const mInfo = (m as any)?.markets?.[market];
      const oracle = Number(mInfo?.oraclePrice ?? 0);
      const bids: BookLevel[] = ((ob as any)?.bids ?? []).slice(0, levels).map((b: any) => ({ price: Number(b.price), size: Number(b.size) }));
      const asks: BookLevel[] = ((ob as any)?.asks ?? []).slice(0, levels).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }));

      const microprice = computeMicroprice(bids, asks);
      const obi = computeOBI(bids, asks, levels);
      const spreadBps = quotedSpreadBps(bids, asks);
      const micropriceDevBps = (microprice !== null && oracle > 0)
        ? ((microprice - oracle) / oracle) * 10000
        : null;

      const s: Sample = {
        ts: Date.now(), cycle, oracle,
        bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null,
        spreadBps, microprice, micropriceDevBps, obi,
        topBidSize: bids[0]?.size ?? 0, topAskSize: asks[0]?.size ?? 0,
      };
      samples.push(s);

      const dirArrow = obi > 0.05 ? "↑" : obi < -0.05 ? "↓" : "·";
      console.log(
        `  ${dirArrow} cyc=${cycle.toString().padStart(3)} oracle=${oracle.toFixed(2).padStart(10)} ` +
        `bid=${(bids[0]?.price ?? 0).toFixed(2).padStart(10)}×${(bids[0]?.size ?? 0).toString().padEnd(6)} ` +
        `ask=${(asks[0]?.price ?? 0).toFixed(2).padStart(10)}×${(asks[0]?.size ?? 0).toString().padEnd(6)} ` +
        `spread=${(spreadBps ?? 0).toFixed(2).padStart(6)}bps ` +
        `OBI=${obi.toFixed(3).padStart(7)} ` +
        `µpDev=${(micropriceDevBps ?? 0).toFixed(2).padStart(7)}bps`
      );
    } catch (e) {
      console.warn(`  cyc=${cycle} error: ${(e as Error).message.slice(0, 100)}`);
    }

    if (stop) break;
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(0, tickMs - elapsed)));
  }

  // Summary stats.
  const obs = samples.map((s) => s.obi);
  const devs = samples.map((s) => s.micropriceDevBps).filter((v): v is number => v !== null);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const stdev = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };

  const summary = {
    net, market, cycles: samples.length, tickMs,
    obi: { mean: +mean(obs).toFixed(4), stdev: +stdev(obs).toFixed(4), min: Math.min(...obs), max: Math.max(...obs) },
    micropriceDevBps: devs.length ? { mean: +mean(devs).toFixed(3), stdev: +stdev(devs).toFixed(3), min: Math.min(...devs), max: Math.max(...devs) } : null,
    when: new Date().toISOString(),
  };
  console.log("\n── Summary ──");
  console.log(JSON.stringify(summary, null, 2));

  const outPath = resolve(process.cwd(), "docs", "dydx-obi-results.json");
  writeFileSync(outPath, JSON.stringify({ ...summary, samples }, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0);
})();
