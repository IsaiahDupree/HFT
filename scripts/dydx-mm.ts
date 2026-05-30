/**
 * dYdX testnet market-making loop (CLI wrapper around MmEngine).
 *
 *   npm run dydx:mm                              # ETH-USD, 30 bps spread, $25/side, 5min
 *   npm run dydx:mm -- --market BTC-USD --tick-ms 5000 --ttl 120
 *   npm run dydx:mm -- --half-spread 25 --per-side 50 --max-inventory 200
 *   npm run dydx:mm -- --dry-run                 # print quotes, don't place
 *
 * Risk caps default to small testnet values. Ctrl-C (or --ttl) triggers a
 * clean shutdown — all open orders cancelled, summary printed.
 */
import "./_env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MmEngine, resolveNet, type MmConfig } from "../src/lib/hft/dydx";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const net = resolveNet();
const market = argValue("market", "ETH-USD");
const tickMs = Number(argValue("tick-ms", "8000"));
const ttlSec = Number(argValue("ttl", "300"));
const goodTilSec = Number(argValue("good-til-sec", "120"));
const dryRun = process.argv.includes("--dry-run");

const cfg: MmConfig = {
  halfSpreadBps: Number(argValue("half-spread", "15")),
  perSideUsd: Number(argValue("per-side", "25")),
  maxInventoryUsd: Number(argValue("max-inventory", "100")),
  driftBps: Number(argValue("drift", "5")),
  skewBpsPerDollar: Number(argValue("skew", "0.1")),
};

console.log(`dYdX market-maker • net=${net} • market=${market} • tick=${tickMs}ms • ttl=${ttlSec}s`);
console.log(`  cfg=${JSON.stringify(cfg)}  dryRun=${dryRun}`);

if (dryRun) {
  // Quick demo: build the engine without starting it; just print computed
  // quotes once from a single snapshot.
  const engine = await MmEngine.create({ net, market, cfg, tickMs, goodTilSec });
  const before = engine.getStatus();
  console.log(`  address=${before.address} subaccount=${before.subaccountNumber}`);
  console.log("[dry-run] Engine created; not starting. Run without --dry-run to live-quote.");
  process.exit(0);
}

const engine = await MmEngine.create({ net, market, cfg, tickMs, goodTilSec });
const initial = engine.getStatus();
console.log(`  address=${initial.address} subaccount=${initial.subaccountNumber}`);
engine.start();

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n── Shutdown (${reason}) ──`);
  await engine.stop(reason);
  const s = engine.getStatus();
  const summary = {
    net: s.net, market: s.market, cycles: s.cycles, runtimeMs: (s.stoppedAt ?? Date.now()) - (s.startedAt ?? Date.now()),
    fills: s.fillsCount,
    realisedUsd: +s.pnl.realisedUsd.toFixed(4),
    feesUsd: +s.pnl.feesUsd.toFixed(4),
    unrealisedUsd: +s.pnl.unrealisedUsd.toFixed(4),
    totalUsd: +(s.pnl.realisedUsd + s.pnl.unrealisedUsd).toFixed(4),
    finalPosition: s.pnl.position, finalVwap: s.pnl.vwap, finalOracle: s.pnl.mark,
  };
  console.log("\n── Summary ──");
  console.log(JSON.stringify(summary, null, 2));
  const outPath = resolve(process.cwd(), "docs", "dydx-mm-results.json");
  writeFileSync(outPath, JSON.stringify({ ...summary, recentCycles: s.recentCycles, recentFills: s.recentFills }, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
setTimeout(() => shutdown("ttl"), ttlSec * 1000).unref?.();

// Periodic console heartbeat so CLI users see progress.
const heartbeat = setInterval(() => {
  const s = engine.getStatus();
  const last = s.recentCycles.at(-1);
  if (!last) return;
  console.log(
    `  cyc=${last.cycle} oracle=${last.oracle.toFixed(4)} pos=${last.position} ` +
      `invUsd=${last.inventoryUsd.toFixed(2)} bid=${last.bid ?? "-"} ask=${last.ask ?? "-"} ` +
      `skewBps=${last.skewBps.toFixed(2)} fills=${s.fillsCount} pnl=${s.pnl.realisedUsd.toFixed(2)}`,
  );
  if (s.lastError) console.warn(`  err: ${s.lastError}`);
}, Math.max(tickMs, 1000));
heartbeat.unref?.();
