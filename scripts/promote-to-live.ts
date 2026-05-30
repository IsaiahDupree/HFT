/**
 * Promote a paper agent to a live capsule.
 *
 * Creates a capsule row bound to the paper agent with real-money limits and
 * flips it to status='live'. From that point, the arena tick will route the
 * agent's signals through ExecutionRouter → PolymarketAdapter when ALLOW_TRADE=1.
 *
 *   npx tsx scripts/promote-to-live.ts <agent_id> \
 *     [--capital=50] [--max-trade=5] [--max-daily-loss=10] [--max-total-dd=25] \
 *     [--max-open=3] [--max-trades=20] [--venues=polymarket]
 *
 * Defaults: $50 capital, $5 per-trade cap, $10 daily-loss cap, $25 total-DD
 * cap, 3 concurrent positions max, 20 trades/day max, polymarket only.
 *
 * Safety: ALLOW_TRADE=1 must also be set in the environment for orders to
 * actually fire. Without it the entire pipeline runs in DRY_RUN mode (audit-
 * logged but no real CLOB orders).
 *
 * The script REFUSES to promote an agent that:
 *   - Doesn't exist
 *   - Is retired (alive=0)
 *   - Has no entries_count (no proof it actually trades)
 *   - Already has a live capsule bound
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { getPaperAgent } from "../src/lib/arena/db.ts";
import { createCapsule, setStatus, getCapsule } from "../src/lib/capsules/store.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

type Opts = {
  capitalUsd: number;
  maxTradeUsd: number;
  maxDailyLossUsd: number;
  maxTotalDdUsd: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  allowedVenues: string[];
};

function parseFlag(name: string, defaultVal: number): number {
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return defaultVal;
  const raw = process.argv[idx].includes("=")
    ? process.argv[idx].split("=", 2)[1]
    : process.argv[idx + 1];
  const v = Number(raw);
  return Number.isFinite(v) ? v : defaultVal;
}
function parseStringList(name: string, defaultVal: string[]): string[] {
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return defaultVal;
  const raw = process.argv[idx].includes("=")
    ? process.argv[idx].split("=", 2)[1]
    : process.argv[idx + 1];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

(async () => {
  const agentArg = process.argv[2];
  if (!agentArg || agentArg.startsWith("--")) {
    console.error("Usage: tsx scripts/promote-to-live.ts <agent_id> [--capital=50] [...]");
    process.exit(1);
  }
  const agentId = Number(agentArg);
  if (!Number.isFinite(agentId)) {
    console.error(`Invalid agent_id: ${agentArg}`);
    process.exit(1);
  }

  const opts: Opts = {
    capitalUsd:        parseFlag("capital", 50),
    maxTradeUsd:       parseFlag("max-trade", 5),
    maxDailyLossUsd:   parseFlag("max-daily-loss", 10),
    maxTotalDdUsd:     parseFlag("max-total-dd", 25),
    maxOpenPositions:  parseFlag("max-open", 3),
    maxTradesPerDay:   parseFlag("max-trades", 20),
    allowedVenues:     parseStringList("venues", ["polymarket"]),
  };

  // Validation chain — fail fast before creating any DB rows.
  const agent = getPaperAgent(agentId);
  if (!agent) {
    console.error(`agent ${agentId} not found`);
    process.exit(1);
  }
  if (!agent.alive) {
    console.error(`agent ${agent.name} (${agentId}) is retired (reason: ${agent.retire_reason ?? "—"}). Refusing to promote.`);
    process.exit(1);
  }
  if (agent.entries_count === 0) {
    console.error(`agent ${agent.name} has never traded (entries=0). Refusing to promote — no proof of life.`);
    process.exit(1);
  }
  const existing = db().prepare(
    `SELECT id, status FROM capsules WHERE paper_agent_id = ? AND status IN ('paper','live')`,
  ).get(agentId) as { id: string; status: string } | undefined;
  if (existing) {
    console.error(`agent ${agent.name} already has a ${existing.status} capsule (${existing.id}). Refusing to create a second one.`);
    process.exit(1);
  }

  // Banner for the operator. Live promotion is meant to be deliberate.
  console.log("\n=== Promoting paper agent to live capsule ===");
  console.log(`  agent: ${agent.name} (#${agentId}) · gen ${agent.generation} · ${agent.is_elite ? "ELITE" : "alive"}`);
  console.log(`  realized PnL: $${agent.realized_pnl_usd.toFixed(2)} · entries=${agent.entries_count} · round-trips=${agent.trades_count}`);
  console.log(`  capital: $${opts.capitalUsd} · max-trade: $${opts.maxTradeUsd} · max-daily-loss: $${opts.maxDailyLossUsd} · max-total-DD: $${opts.maxTotalDdUsd}`);
  console.log(`  venues: ${opts.allowedVenues.join(", ")} · max-open: ${opts.maxOpenPositions} · max-trades/day: ${opts.maxTradesPerDay}`);
  console.log(`  ALLOW_TRADE: ${process.env.ALLOW_TRADE === "1" ? "1 (LIVE)" : "unset (DRY_RUN — no real orders fire)"}\n`);

  // Create capsule (status='draft').
  const capsule = createCapsule({
    name: `live-${agent.name}`,
    agentId: null,                                     // legacy column; we bind via paper_agent_id below
    capitalUsd: opts.capitalUsd,
    allowedVenues: opts.allowedVenues,
    maxDailyLossUsd: opts.maxDailyLossUsd,
    maxTotalDrawdownUsd: opts.maxTotalDdUsd,
    maxOpenPositions: opts.maxOpenPositions,
    maxTradesPerDay: opts.maxTradesPerDay,
  });
  // Bind to the paper agent. Separate UPDATE because `paper_agent_id` was
  // added via migration after createCapsule's INSERT shape was finalized.
  db().prepare(`UPDATE capsules SET paper_agent_id = ? WHERE id = ?`).run(agentId, capsule.id);
  // Flip to 'live' so live-capsule.ts will find it.
  setStatus(capsule.id, "live");

  insertEvolutionEvent({
    event_type: "capsule-live-promoted",
    summary: `agent ${agent.name} (${agentId}) promoted to live capsule ${capsule.id.slice(0, 8)} with $${opts.capitalUsd} capital`,
    payload_json: JSON.stringify({ agent_id: agentId, capsule_id: capsule.id, opts }),
  });

  const final = getCapsule(capsule.id);
  console.log(`✓ Created capsule ${capsule.id}`);
  console.log(`  status: ${final?.status} · capital_available: $${final?.capital_available_usd}`);
  console.log(`  Next arena tick will route this agent's signals through ExecutionRouter.`);
  if (process.env.ALLOW_TRADE !== "1") {
    console.log("\n  ⚠  ALLOW_TRADE is not set — orders will DRY_RUN (audit-logged only).");
    console.log("    To go LIVE: set ALLOW_TRADE=1 + POLYMARKET_PRIVATE_KEY/CLOB creds in .env, then run arena:tick.\n");
  }
})();
