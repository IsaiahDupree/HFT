/**
 * backtest-mm — run the event-driven L2 backtester on synthetic data and the
 * delay-injection validation sweep (handbook §10). Compares AS-logit MM vs the
 * constant-spread baseline vs do-nothing, in the Finance fee category (50% maker
 * rebate). SYNTHETIC data → validates the engine MECHANICS, not live edge.
 *
 *   npx tsx scripts/backtest-mm.ts
 */
import { L2Backtester, type BacktestSummary, type Strategy } from "../src/lib/backtest/l2/engine.ts";
import { asMmStrategy, constantSpreadStrategy, doNothingStrategy } from "../src/lib/backtest/l2/strategies.ts";
import { generateSyntheticEvents } from "../src/lib/backtest/l2/synthetic.ts";
import type { ASParams, FeeCategory } from "../src/lib/strategies/as-market-maker.ts";

const CAT: FeeCategory = "finance";
// Spread-calibrated AS params: quote INSIDE the 0.03 synthetic spread so the maker
// improves the book and fills. (σ=0.4 etc. quote far outside → 0 fills — calibration
// IS the alpha; see docs/blueprint/HFT-MARKET-MAKING.md.)
const AS: ASParams = { gamma: 1, sigma: 0.05, kappa: 80, T: 1 };
const events = generateSyntheticEvents({ n: 4000, seed: 42, spread: 0.03, tradeProb: 0.45 });

const fmt = (s: BacktestSummary) =>
  `pnl=$${s.pnl.toFixed(2)} fills=${s.nFills}(mk${s.nMakerFills}/tk${s.nTakerFills}) inv=${s.finalInventory.toFixed(0)} fees=$${s.feesPaid.toFixed(3)} rebates=$${s.rebatesReceived.toFixed(3)}`;
const run = (lat: number, strat: Strategy) => new L2Backtester({ latencyMs: lat, feeCategory: CAT }).run(events, strat);

console.log(`\nL2 backtest — ${events.length} synthetic events, ${CAT} category (50% maker rebate)\n`);
console.log("  do-nothing    ", fmt(run(50, doNothingStrategy)), " (acceptance: pnl ≈ 0)");
console.log("  const-spread  ", fmt(run(50, constantSpreadStrategy(0.008, 20))));
console.log("  AS-logit MM   ", fmt(run(50, asMmStrategy(AS, { size: 20 }))));

console.log("\n  delay-injection (AS-MM) — PnL must degrade SMOOTHLY, not collapse (→ look-ahead):");
for (const lat of [0, 50, 100, 500, 2000]) {
  const s = run(lat, asMmStrategy(AS, { size: 20 }));
  console.log(`   +${String(lat).padStart(4)}ms   pnl=$${s.pnl.toFixed(2)}  fills=${s.nFills}`);
}

console.log("\n  NOTE: synthetic data validates engine MECHANICS only (queue, latency, fees).");
console.log("  Real edge needs real V2 L2 captures + calibrated β_OFI/κ/σ_b, gated on");
console.log("  delay-injection + purged-CV (PBO<0.3, Deflated Sharpe>0.95). See");
console.log("  docs/blueprint/HFT-MARKET-MAKING.md.\n");
