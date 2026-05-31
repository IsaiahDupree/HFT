/**
 * Replay a historical window through every alive agent in the current
 * generation — bootstraps fitness without waiting for live ticks.
 *
 * Usage:
 *   tsx scripts/arena-replay.ts --start 2026-05-20T00:00:00Z --end 2026-05-25T00:00:00Z --interval 5
 *
 * Per tick: builds the same TickContext shape as live, walks every agent's
 * decide() function, applies signals, persists. Writes the replay window into
 * the current generation row.
 */
import "./_env.ts";
import { listAliveAgentsForGen, getCurrentGeneration, persistAgentTick, persistTradeWithLink, toLiveAgent } from "../src/lib/arena/db.ts";
import { applySignal, decide, markToMarket } from "../src/lib/arena/sim.ts";
import { iterTickContexts } from "../src/lib/arena/context.ts";
import { db } from "../src/lib/db/client.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const startArg = arg("start") ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
const endArg = arg("end") ?? new Date().toISOString();
const intervalMin = Number(arg("interval") ?? "5");

const gen = getCurrentGeneration();
if (!gen) { console.error("arena:replay — no open generation."); process.exit(1); }

const agents = listAliveAgentsForGen(gen.gen_number).map(toLiveAgent);
const rng = Math.random;

let nTicks = 0;
const stats = { entries: 0, exits: 0, holds: 0 };
for (const ctx of iterTickContexts({ start: startArg, end: endArg, tickIntervalMin: intervalMin })) {
  nTicks += 1;
  for (const agent of agents) {
    const signal = decide(agent, ctx, rng);
    if (signal.kind === "hold") { stats.holds += 1; continue; }
    const res = applySignal(agent, signal, ctx, gen.gen_number);
    if (res.trade) {
      persistTradeWithLink(res); // stamps entry_trade_id so exits link back (linked_entry_id)
      if (res.trade.intent === "entry") stats.entries += 1;
      if (res.trade.intent === "exit")  stats.exits   += 1;
    }
    markToMarket(agent, ctx);
  }
}
// Persist final state.
for (const agent of agents) persistAgentTick(agent);
db().prepare(`UPDATE paper_generations SET replay_window_start = ?, replay_window_end = ? WHERE id = ?`)
  .run(startArg, endArg, gen.id);

console.log(`arena:replay gen=${gen.gen_number} ticks=${nTicks} agents=${agents.length} → entries=${stats.entries} exits=${stats.exits} holds=${stats.holds}  window=[${startArg.slice(0, 19)} .. ${endArg.slice(0, 19)}]`);
