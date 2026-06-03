/**
 * meta-allocate — apply the strategy-of-strategies meta-layer to REAL arena data:
 * compute a DE-CORRELATED inverse-vol allocation across the genome strategies + a
 * per-strategy health readout (live Sharpe, trailing Sharpe, drawdown, decay flag).
 * This is the "intelligence between combining and detecting strategies" running on
 * the live arena's realized returns — a smarter allocation than fitness-weighting
 * because it accounts for correlation (don't double-bet) and decay.
 *
 *   npm run meta:allocate
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { closeTsdb } from "../src/lib/db/candle-store.ts";
import { metaAllocate, strategyHealth, diversificationRatio, type StratReturns } from "../src/lib/meta/strategy-allocator.ts";

// per-genome-kind DAILY realized return from paper_trades (PnL ÷ capital), aligned by day.
const rows = db().prepare(`
  SELECT date(pt.tick_at) d, json_extract(pa.genome_json,'$.kind') kind, SUM(pt.realized_pnl_usd) pnl
    FROM paper_trades pt JOIN paper_agents pa ON pa.id = pt.paper_agent_id
   WHERE pt.intent='exit' AND pt.realized_pnl_usd IS NOT NULL
   GROUP BY d, kind ORDER BY d`).all() as Array<{ d: string; kind: string; pnl: number }>;
const cap = new Map<string, number>();
for (const r of db().prepare(`SELECT json_extract(genome_json,'$.kind') kind, COUNT(*)*1000.0 c FROM paper_agents GROUP BY kind`).all() as Array<{ kind: string; c: number }>) cap.set(r.kind, r.c);

const days = [...new Set(rows.map((r) => r.d))].sort();
const byKind = new Map<string, Map<string, number>>();
for (const r of rows) { (byKind.get(r.kind) ?? byKind.set(r.kind, new Map()).get(r.kind)!).set(r.d, r.pnl / (cap.get(r.kind) || 1000)); }
const strats: StratReturns[] = [...byKind].map(([kind, m]) => ({ strategy: kind, returns: days.map((d) => m.get(d) ?? 0) }));

console.log(`\nmeta-allocate — de-correlated allocation across ${strats.length} arena genome-strategies · ${days.length} days\n`);
if (strats.length === 0) { console.log("  no realized arena returns yet — run the arena loop to accrue data.\n"); await closeTsdb(); process.exit(0); }

const w = metaAllocate(strats, { corrPenalty: 1 });
console.log(`  ${"strategy".padEnd(30)} ${"alloc%".padEnd(8)} ${"annSh".padEnd(7)} ${"trailSh".padEnd(8)} ${"maxDD".padEnd(7)} flag`);
for (const s of [...strats].sort((a, b) => (w[b.strategy] ?? 0) - (w[a.strategy] ?? 0))) {
  const h = strategyHealth(s.returns, {});
  console.log(`  ${s.strategy.padEnd(30)} ${((w[s.strategy] ?? 0) * 100).toFixed(1).padEnd(8)} ${h.annSharpe.toFixed(2).padEnd(7)} ${h.trailingSharpe.toFixed(2).padEnd(8)} ${(h.maxDrawdown * 100).toFixed(1).padEnd(7)} ${h.decaying ? "DECAYING" : ""}`);
}
console.log(`\n  diversification ratio: ${diversificationRatio(strats, w).toFixed(2)} (>1 ⇒ de-correlation reduces portfolio risk vs the weighted average)`);
if (days.length < 10) console.log(`  NOTE: only ${days.length} days of arena returns — thin; correlation/decay sharpen as the loop accrues. Allocation falls back toward inverse-vol.`);
console.log(`  (de-correlated risk-parity-lite: penalize strategies correlated with the pack, boost the independent ones; drop decaying edges.)\n`);
await closeTsdb();
