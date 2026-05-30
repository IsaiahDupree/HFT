/**
 * One-shot cleanup: force-close any open positions on RETIRED paper_agents.
 *
 * Before evolve.ts learned to realize positions at seal time, three agents got
 * retired with open positions still on their books (entries that never got an
 * exit signal because the agent itself was culled mid-position). This script
 * walks every retired agent with a non-empty position basket and runs the same
 * realize-on-retire path the new evolve uses.
 *
 * Run: `npx tsx scripts/arena-close-orphans.ts`
 * Idempotent — second run is a no-op once positions are closed.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { buildLiveTickContext } from "../src/lib/arena/context.ts";
import { applySignal, markToMarket } from "../src/lib/arena/sim.ts";
import { insertPaperTrade, persistAgentTick, toLiveAgent } from "../src/lib/arena/db.ts";
import type { PaperAgentRow } from "../src/lib/arena/types.ts";

const orphans = db().prepare(
  `SELECT * FROM paper_agents
    WHERE alive = 0
      AND position_basket_json IS NOT NULL
      AND position_basket_json != '[]'
      AND position_basket_json != ''`,
).all() as PaperAgentRow[];

if (orphans.length === 0) {
  console.log("arena:close-orphans — no retired agents with open positions. Nothing to do.");
  process.exit(0);
}

const ctx = buildLiveTickContext();
if (ctx.snapshots.size === 0) {
  console.error("arena:close-orphans — no recent snapshots; run `npm run worker:snapshot` first.");
  process.exit(1);
}

console.log(`arena:close-orphans — found ${orphans.length} retired agents with open positions; pricing against ${ctx.snapshots.size} markets.`);

let totalClosed = 0;
let totalSkipped = 0;
for (const row of orphans) {
  const agent = toLiveAgent(row);
  const marketIds = agent.positions.map((p) => p.market_id);
  let closed = 0;
  let skipped = 0;
  for (const mid of marketIds) {
    const pos = agent.positions.find((p) => p.market_id === mid);
    if (!pos) continue;
    if (!ctx.snapshots.has(mid)) { skipped += 1; continue; }
    const res = applySignal(agent, { kind: "exit", venue: pos.venue, market_id: mid, rationale: "backfill: close orphan on retired agent" }, ctx, row.generation);
    if (res.trade) {
      insertPaperTrade(res.trade);
      closed += 1;
    }
  }
  markToMarket(agent, ctx);
  persistAgentTick(agent);
  totalClosed += closed;
  totalSkipped += skipped;
  console.log(`  agent ${row.id} (${row.name}, gen${row.generation}) — closed ${closed}, skipped ${skipped} (no snapshot), realized=${agent.realized_pnl_usd.toFixed(2)} cash=${agent.cash_usd_current.toFixed(2)}`);
}
console.log(`arena:close-orphans — done. ${totalClosed} positions closed, ${totalSkipped} skipped (no live snapshot for that market).`);
