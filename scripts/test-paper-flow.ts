/**
 * Runnable proof that paper mode works end-to-end against the real SQLite DB.
 *
 *   npm run test:paper
 *
 * Seeds a one-off agent + capsule + paper-stage version (idempotent: tagged
 * with a UUID slug per run so it doesn't collide with seed data). Submits 3
 * sim orders through the router. Prints the verdicts + order_events trail.
 *
 * Safe to run anywhere; touches no real venue. The SimAdapter never reaches
 * out — every "fill" is synthetic.
 */
import "./_env.ts";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db/client.ts";
import { createCapsule, setStatus } from "../src/lib/capsules/store.ts";
import { setVersionStage } from "../src/lib/stages/gate.ts";
import { getDefaultRouter } from "../src/lib/venue/router.ts";
import { listOrderEvents } from "../src/lib/venue/order-events.ts";

function seedAgentAndVersion(): { agentId: number; strategyId: number; versionId: number; slug: string } {
  const slug = `paper-flow-${randomUUID().slice(0, 8)}`;
  const handle = db();
  handle.prepare("INSERT INTO agents (slug, name, charter) VALUES (?, 'Paper Flow Demo', 'sim trades only — safe to ignore')").run(slug);
  const agent = handle.prepare("SELECT id FROM agents WHERE slug = ?").get(slug) as { id: number };
  handle.prepare(
    "INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, ?, 'Paper demo strategy', 'sim only', '{}')",
  ).run(agent.id, slug);
  const strat = handle.prepare("SELECT id FROM strategies WHERE slug = ?").get(slug) as { id: number };
  handle.prepare(
    "INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, stage, is_current) VALUES (?, 1, '{}', 'init', 'sim', 1)",
  ).run(strat.id);
  const version = handle.prepare("SELECT id FROM strategy_versions WHERE strategy_id = ? ORDER BY id DESC LIMIT 1").get(strat.id) as { id: number };
  return { agentId: agent.id, strategyId: strat.id, versionId: version.id, slug };
}

async function main() {
  console.log("[paper-flow] starting...");
  const { agentId, versionId, slug } = seedAgentAndVersion();
  console.log(`[paper-flow] seeded agent slug=${slug} id=${agentId} versionId=${versionId}`);

  const stage = setVersionStage(versionId, "paper", { rationale: "demo" });
  console.log(`[paper-flow] stage sim → paper: ok=${stage.ok}`);

  const cap = createCapsule({
    name: `Paper capsule for ${slug}`,
    agentId,
    capitalUsd: 500,
    allowedVenues: ["sim"],
    maxDailyLossUsd: 100,
    maxPositionPct: 0.5,
    maxOpenPositions: 5,
    maxTradesPerDay: 100,
  });
  setStatus(cap.id, "paper");
  console.log(`[paper-flow] capsule ${cap.id} status=paper allowed_venues=[sim]`);

  const router = getDefaultRouter();
  const adapters = router.registeredVenues();
  console.log(`[paper-flow] router adapters: ${adapters.join(", ")}`);

  const intents = [
    { symbol: "BTC-USD", side: "BUY" as const, size: 1, refPrice: 100 },
    { symbol: "ETH-USD", side: "BUY" as const, size: 0.5, refPrice: 50 },
    { symbol: "BTC-USD", side: "SELL" as const, size: 1, refPrice: 110 },
  ];

  for (const intent of intents) {
    const coid = `paper-${slug}-${randomUUID().slice(0, 6)}`;
    const verdict = await router.submit({
      clientOrderId: coid,
      venue: "sim",
      type: "MARKET",
      ...intent,
      capsuleId: cap.id,
      agentId,
      strategyVersionId: versionId,
    });
    console.log(`[paper-flow] ${intent.side} ${intent.size} ${intent.symbol} @ $${intent.refPrice} →`,
      verdict.ok
        ? `OK (${"status" in verdict ? verdict.status : "submitted"}${"brokerOrderId" in verdict && verdict.brokerOrderId ? `, ${verdict.brokerOrderId}` : ""})`
        : `REJECTED (${verdict.code}: ${verdict.reason})`);
  }

  console.log("\n[paper-flow] recent order_events for this capsule:");
  const events = db()
    .prepare("SELECT seq, event, venue, symbol, side, qty, price, status FROM order_events WHERE capsule_id = ? ORDER BY seq")
    .all(cap.id) as Array<Record<string, unknown>>;
  for (const e of events) console.log(" ", JSON.stringify(e));
  console.log(`[paper-flow] total events: ${events.length}`);
  console.log("[paper-flow] done.");
}

main().catch((err) => {
  console.error("[paper-flow] FAILED:", err);
  process.exit(1);
});
