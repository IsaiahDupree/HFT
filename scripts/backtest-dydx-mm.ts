/**
 * backtest-dydx-mm — run the dollar-space AS market-maker (asMmDollar) over the
 * recorded dYdX WS L2 stream, through the event-driven L2 backtester with flat-bps
 * dYdX fees. Answers: does a simple inventory-aware maker capture spread net of fees
 * + adverse selection on dYdX deep books? (vs Polymarket's thin binaries where the
 * binary asMm strategies can't fill.)
 *
 *   npm run backtest:dydx:mm -- --market BTC-USD
 *
 * NOTE: a single short WS recording is a TINY, noisy sample — this proves the
 * plumbing + gives a first read, not a hardened edge. Run a long recording (cron)
 * for a real measurement.
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { L2Backtester } from "../src/lib/backtest/l2/engine.ts";
import { asMmDollar } from "../src/lib/backtest/l2/strategies.ts";
import { loadCaptureJsonl } from "../src/lib/backtest/l2/replay.ts";
import { proofCouncil, renderProofCouncil } from "../src/lib/backtest/proof-council.ts";

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const market = arg("--market", "BTC-USD");
// --date YYYY-MM-DD (default today) or --dir to point at an explicit capture folder.
const date = arg("--date", new Date().toISOString().slice(0, 10));
const dir = arg("--dir", resolve(process.cwd(), "data", "captures-dydx", date));
const path = resolve(dir, `${market}.ws.jsonl`);
if (!existsSync(path)) { console.error(`no WS capture at ${path} — run: npm run capture:dydx (or pass --date/--dir)`); process.exit(1); }
const evs = loadCaptureJsonl(path);
const books = evs.filter((e) => e.kind === "book"), trades = evs.filter((e) => e.kind === "trade");
// dYdX price tick + a small maker clip size per market.
const TICK: Record<string, number> = { "BTC-USD": 1, "ETH-USD": 0.1, "SOL-USD": 0.01 };
const SIZE: Record<string, number> = { "BTC-USD": 0.01, "ETH-USD": 0.1, "SOL-USD": 5 };
const tick = TICK[market] ?? 0.01, size = SIZE[market] ?? 1;
const mid0 = books.length ? (books[0] as any).bidPx : 0;

console.log(`\nbacktest-dydx-mm — ${market} · ${books.length} book moves · ${trades.length} trades · tick $${tick} · clip ${size}\n`);
console.log(`  ${"maker fee".padEnd(12)} ${"PnL($)".padEnd(9)} ${"fills".padEnd(13)} ${"endInv".padEnd(9)} ${"fees".padEnd(8)} rebates`);
let rebateRun: ReturnType<L2Backtester["run"]> | undefined;
for (const makerBps of [2, 1, 0, -1.1]) { // dYdX tiers: base maker ~2bps → high-vol rebate ~-1.1bps; taker ~5bps
  const bt = new L2Backtester({ latencyMs: 50, tick, feeBps: { maker: makerBps, taker: 5 } });
  const s = bt.run(evs, asMmDollar({ size, baseSpreadBps: 1.5, maxNotional: 20_000, gamma: 1.0 }));
  if (makerBps === -1.1) rebateRun = s;
  const label = makerBps < 0 ? `${makerBps}bps reb` : `+${makerBps}bps`;
  console.log(`  ${label.padEnd(12)} ${s.pnl.toFixed(2).padEnd(9)} ${`${s.nFills}(${s.nMakerFills}m/${s.nTakerFills}t)`.padEnd(13)} ${s.finalInventory.toFixed(3).padEnd(9)} ${s.feesPaid.toFixed(2).padEnd(8)} ${s.rebatesReceived.toFixed(2)}`);
}
console.log(`\n  (PnL marks final inventory to mid. Maker fills = captured spread − fee/+rebate; taker fills + inventory MtM = adverse selection cost.)`);
console.log(`  Sample is one ${(books.length && (books.at(-1)!.ts - books[0].ts).toFixed(0)) || "?"}s recording — illustrative, not hardened. Accumulate via cron for a real verdict.`);

// Proof Council — over the rebate tier. The honest "sample" is MAKER FILLS, not book
// moves; a short recording fills far too few times to test a spread-capture edge → it
// should land REPAIR_FIRST (accumulate recordings), not a premature edge claim.
if (rebateRun) {
  console.log("\n" + renderProofCouncil(proofCouncil({
    label: `${market} asMmDollar @-1.1bps rebate`,
    bars: rebateRun.nMakerFills, sampleUnit: "maker fills", feeBps: -1.1,
  })) + "\n");
}
