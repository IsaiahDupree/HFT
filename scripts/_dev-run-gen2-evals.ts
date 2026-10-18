/**
 * One-shot helper: drive every gen-2 evaluator against the current AgentContext
 * and persist any research notes they emit. NOT a production script — pure
 * operator convenience for verifying the gen-2 evaluators after a seed run.
 */
import "./_env.ts";
import { evaluators } from "./research-loop.ts";
import { buildAgentContext, summarizeContext } from "../src/lib/agents/context.ts";
import { db } from "../src/lib/db/client.ts";
import { insertResearchNote } from "../src/lib/db/queries.ts";

const strategies = [
  { agent: "nereid-scrape", strategy: "near-resolution-scrape" },
  { agent: "lyra-cross-timeframe", strategy: "cross-timeframe-spread-trade" },
  { agent: "pulse-microstructure", strategy: "orderbook-imbalance-watch" },
  { agent: "hydra-consensus", strategy: "consensus-tail-follow" },
];

(async () => {
  const handle = db();
  for (const s of strategies) {
    const strat = handle
      .prepare(
        "SELECT s.id FROM strategies s JOIN agents a ON a.id = s.agent_id WHERE a.slug = ? AND s.slug = ?",
      )
      .get(s.agent, s.strategy) as { id: number } | undefined;
    if (!strat) {
      console.log(`\n=== ${s.agent} (${s.strategy}) === NOT FOUND in DB`);
      continue;
    }
    const context = buildAgentContext(strat.id);
    console.log(`\n=== ${s.agent} (${s.strategy}) ===`);
    console.log(`  ${summarizeContext(context)}`);
    const evaluator = evaluators[s.strategy];
    if (!evaluator) {
      console.log(`  ✗ no evaluator registered for slug "${s.strategy}"`);
      continue;
    }
    try {
      const verdict = await evaluator({ current: {} as any, signals: [] as any, context });
      if (!verdict) {
        console.log(`  → no verdict (relevant signal array empty)`);
        continue;
      }
      if (verdict.kind === "research-note") {
        const agentRow = handle.prepare("SELECT id FROM agents WHERE slug = ?").get(s.agent) as { id: number };
        insertResearchNote({
          agent_id: agentRow.id,
          strategy_id: strat.id,
          topic: verdict.topic,
          body: verdict.body,
          source_urls_json: JSON.stringify(verdict.sourceUrls ?? []),
          confidence: verdict.confidence,
          tags_json: JSON.stringify(verdict.tags ?? []),
        });
        console.log(`  → research-note: ${verdict.topic}`);
        console.log(`  → persisted to research_notes`);
      } else {
        console.log(`  → ${verdict.kind} (would propose spec change)`);
      }
    } catch (err) {
      console.error(`  ✗ evaluator threw: ${(err as Error).message}`);
    }
  }
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
