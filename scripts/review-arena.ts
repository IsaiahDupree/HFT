/**
 * review-arena — on-demand readout of the running arena: evolution history, the
 * fitness leaderboard, PnL by strategy KIND and by SOURCE (random grid vs
 * research-targeted vs adaptive-refresh), capsule allocations, and recent
 * allocation rationale. Answers "which researched edge actually paid?"
 *
 *   npx tsx scripts/review-arena.ts
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { rankAgents } from "../src/lib/arena/score.ts";
import { listAliveAgentsAcrossGens, listGenerations } from "../src/lib/arena/db.ts";

const one = <T>(s: string, ...a: unknown[]) => db().prepare(s).get(...a) as T;
const all = <T>(s: string, ...a: unknown[]) => db().prepare(s).all(...a) as T[];

function sourceOf(introduced_by: string): string {
  if (introduced_by?.includes("strategy-factory")) return "random-grid";
  if (introduced_by?.includes("research-seed")) return "workflow-targeted";
  if (introduced_by?.includes("research-refresh")) return "adaptive-refresh";
  return introduced_by || "init";
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function main(): void {
  console.log("\n══════════════ ARENA REVIEW ══════════════");

  // Generations / evolution history
  const gens = listGenerations(10).reverse();
  const curGen = gens[gens.length - 1];
  console.log(`\nGENERATIONS (${gens.length} shown):`);
  for (const g of gens) {
    const sealed = g.sealed_at ? `sealed top_score=${(g.top_score ?? 0).toFixed(4)}` : `OPEN tick=${(g as any).tick_count ?? "?"}/50`;
    console.log(`  gen ${g.gen_number}: ${g.n_agents} agents · ${sealed}`);
  }

  // Population
  const alive = listAliveAgentsAcrossGens();
  const totalEver = one<{ n: number }>("SELECT COUNT(*) n FROM paper_agents").n;
  console.log(`\nPOPULATION: ${alive.length} alive / ${totalEver} ever created (retired = risk-culled or evolve-culled)`);
  const bySource: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const a of alive) {
    bySource[sourceOf(a.introduced_by)] = (bySource[sourceOf(a.introduced_by)] ?? 0) + 1;
    const kind = (() => { try { return JSON.parse(a.genome_json).kind; } catch { return "?"; } })();
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  console.log("  by source:", Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join("  "));
  console.log("  by kind:  ", Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));

  // Leaderboard (risk-adjusted fitness)
  const ranked = rankAgents(alive);
  console.log(`\nLEADERBOARD — top 12 by fitness (pnl% − 2·maxDD% + activity):`);
  console.log(`  ${"#".padStart(2)} ${"agent".padEnd(30)} ${"kind".padEnd(22)} ${"fit".padStart(7)} ${"pnl%".padStart(7)} ${"dd%".padStart(6)} ${"tr".padStart(3)} src`);
  for (let i = 0; i < Math.min(12, ranked.length); i++) {
    const { agent, score } = ranked[i];
    const kind = (() => { try { return JSON.parse(agent.genome_json).kind; } catch { return "?"; } })();
    console.log(`  ${String(i + 1).padStart(2)} ${agent.name.slice(0, 30).padEnd(30)} ${kind.slice(0, 22).padEnd(22)} ${score.fitness.toFixed(3).padStart(7)} ${pct(score.pnl_pct).padStart(7)} ${(score.max_dd_pct * 100).toFixed(1).padStart(6)} ${String(score.trades_count).padStart(3)} ${sourceOf(agent.introduced_by)}`);
  }

  // PnL by kind and by source (the real "what paid?")
  const pnlByKind: Record<string, { pnl: number; n: number; trades: number }> = {};
  const pnlBySource: Record<string, { pnl: number; n: number }> = {};
  for (const { agent, score } of ranked) {
    const realized = agent.realized_pnl_usd + agent.unrealized_pnl_usd;
    const kind = (() => { try { return JSON.parse(agent.genome_json).kind; } catch { return "?"; } })();
    (pnlByKind[kind] ??= { pnl: 0, n: 0, trades: 0 });
    pnlByKind[kind].pnl += realized; pnlByKind[kind].n += 1; pnlByKind[kind].trades += score.trades_count;
    const src = sourceOf(agent.introduced_by);
    (pnlBySource[src] ??= { pnl: 0, n: 0 });
    pnlBySource[src].pnl += realized; pnlBySource[src].n += 1;
  }
  console.log(`\nPnL BY KIND (realized+unrealized, alive agents):`);
  for (const [k, v] of Object.entries(pnlByKind).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k.padEnd(28)} $${v.pnl.toFixed(2).padStart(9)}  (${v.n} agents, ${v.trades} trades)`);
  }
  console.log(`\nPnL BY SOURCE:`);
  for (const [k, v] of Object.entries(pnlBySource).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k.padEnd(20)} $${v.pnl.toFixed(2).padStart(9)}  (${v.n} agents)`);
  }

  // Capsules + allocation
  const caps = all<{ name: string; status: string; cap: number; pa: number | null }>(
    "SELECT name, status, capital_allocated_usd cap, paper_agent_id pa FROM capsules WHERE paper_agent_id IS NOT NULL ORDER BY capital_allocated_usd DESC LIMIT 8");
  if (caps.length) {
    console.log(`\nCAPSULES funded by the allocator (${caps.length} shown):`);
    for (const c of caps) console.log(`  ${c.name.slice(0, 40).padEnd(40)} ${c.status} $${c.cap.toFixed(0)}`);
  }
  const lastAlloc = one<{ summary: string; created_at: string }>(
    "SELECT summary, created_at FROM evolution_log WHERE event_type='capital-allocation' ORDER BY id DESC LIMIT 1");
  if (lastAlloc) console.log(`\nLAST ALLOCATION: ${lastAlloc.summary}  (${lastAlloc.created_at})`);

  // Settlement / activity
  const tr = one<{ n: number; pnl: number }>("SELECT COUNT(*) n, COALESCE(ROUND(SUM(realized_pnl_usd),2),0) pnl FROM paper_trades WHERE realized_pnl_usd IS NOT NULL AND realized_pnl_usd!=0");
  console.log(`\nREALIZED TRADES: ${tr.n} closed with PnL, net $${tr.pnl}`);
  console.log("══════════════════════════════════════════\n");
}

main();
