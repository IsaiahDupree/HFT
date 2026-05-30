/**
 * Combinatorial-arb scanner with LLM-inferred dependency constraints.
 *
 * Per event group:
 *  1. Pull Gamma event with all its markets.
 *  2. Resolve token IDs + outcome labels.
 *  3. Ask Claude (haiku-4-5) to infer logical implications between each pair
 *     of markets (e.g. "X wins by Y" ⇒ "X wins").
 *  4. Feed both the markets and the inferred constraints to findCombinatorialArbs.
 *  5. Log detections to evolution_log with rich payload (constraints + arb).
 *
 * If ANTHROPIC_API_KEY is missing, falls back to no-constraint mode (same as
 * scripts/comb-arb-runner.ts).
 *
 *   npm run arb:comb:llm
 */
import "./_env.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { findCombinatorialArbs, type CombinatorialMarket, type DependencyConstraint } from "../src/lib/polymarket/arb.ts";
import { inferDependenciesForGroup, inferIsAvailable, type MarketForInference } from "../src/lib/polymarket/dependency-inference.ts";
import { insertEvolutionEvent, insertResearchNote } from "../src/lib/db/queries.ts";

const N_EVENTS = Number(process.env.COMB_EVENTS ?? "6");
const MIN_EDGE_USD = Number(process.env.COMB_MIN_EDGE_USD ?? "0.10");
const MAX_MARKETS_PER_EVENT = Number(process.env.COMB_MAX_MARKETS ?? "5");

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
function topAsk(book: any | null): { price: number; size: number } | null {
  if (!book?.asks?.[0]) return null;
  const a = book.asks[0];
  const price = Number(a.price);
  const size = Number(a.size);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  return { price, size };
}

(async () => {
  console.log(`[comb-arb-llm] starting ${new Date().toISOString()}  •  LLM available=${inferIsAvailable()}`);
  const events = await poly.events({ limit: N_EVENTS, closed: false });
  let totalDetected = 0;
  let totalLlmConstraints = 0;

  for (const ev of events) {
    const markets = ((ev.markets ?? []) as any[]).slice(0, MAX_MARKETS_PER_EVENT);
    if (markets.length < 2) continue;

    // Build the LP-ready CombinatorialMarket list + LLM-ready MarketForInference list in one pass.
    const combMarkets: CombinatorialMarket[] = [];
    const llmMarkets: MarketForInference[] = [];
    for (const m of markets) {
      let tokenIds: string[] = [];
      let outcomeLabels: string[] = [];
      try { tokenIds = JSON.parse(m.clobTokenIds ?? "[]"); } catch {}
      try { outcomeLabels = JSON.parse(m.outcomes ?? "[\"Yes\",\"No\"]"); } catch { outcomeLabels = ["Yes", "No"]; }
      if (tokenIds.length < 2) continue;
      const books = await Promise.all(tokenIds.map((id) => safe(() => poly.orderbook(id))));
      const outcomes: CombinatorialMarket["outcomes"] = [];
      for (let i = 0; i < tokenIds.length; i++) {
        const top = topAsk(books[i]);
        if (!top) continue;
        outcomes.push({ tokenId: tokenIds[i], askPrice: top.price, askSize: top.size, label: outcomeLabels[i] ?? `outcome_${i}` });
      }
      if (outcomes.length < 2) continue;
      combMarkets.push({ conditionId: m.conditionId, question: m.question, outcomes });
      llmMarkets.push({
        marketId: m.conditionId,
        question: m.question,
        outcomeTokenIds: tokenIds,
        outcomeLabels,
      });
    }
    if (combMarkets.length < 2) continue;

    // Inference step (LLM if available, otherwise [])
    let constraints: DependencyConstraint[] = [];
    let llmTokensUsed = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    if (inferIsAvailable()) {
      try {
        const inference = await inferDependenciesForGroup(llmMarkets);
        constraints = inference.constraints;
        for (const p of inference.perPair) {
          if (!p.result) continue;
          llmTokensUsed.input += p.result.usage.input_tokens;
          llmTokensUsed.output += p.result.usage.output_tokens;
          llmTokensUsed.cache_read += p.result.usage.cache_read_input_tokens;
          llmTokensUsed.cache_write += p.result.usage.cache_creation_input_tokens;
        }
        totalLlmConstraints += constraints.length;
        if (constraints.length > 0) {
          insertResearchNote({
            topic: `LLM-inferred constraints: ${(ev.title ?? "").slice(0, 60)}`,
            body:
              `Pairs analysed for "${ev.title}": ${inference.perPair.length}\n` +
              `Constraints inferred: ${constraints.length}\n\n` +
              inference.perPair
                .filter((p) => p.result && p.result.raw.has_dependency)
                .map((p) => `- ${p.a.slice(0, 12)} ↔ ${p.b.slice(0, 12)} (conf ${p.result!.raw.confidence.toFixed(2)})\n  ${p.result!.raw.reasoning}`)
                .join("\n\n"),
            source_urls_json: JSON.stringify(["https://docs.polymarket.com/api-reference/events/get-event-by-id"]),
            confidence: 0.6,
            tags_json: JSON.stringify(["llm-inference", "comb-arb", "auto"]),
          });
        }
      } catch (err) {
        console.warn(`[comb-arb-llm] LLM inference failed for "${ev.title}": ${(err as Error).message}`);
      }
    }

    const result = await findCombinatorialArbs(combMarkets, constraints, { depthCapFraction: 0.5 });
    console.log(`[comb-arb-llm] event="${(ev.title ?? "").slice(0, 50).padEnd(50)}" markets=${combMarkets.length} constraints=${constraints.length} result=${result.kind}${result.kind === "found" ? ` arbs=${result.arbs.length}` : ""} (llm in=${llmTokensUsed.input}, out=${llmTokensUsed.output}, cache-read=${llmTokensUsed.cache_read})`);
    if (result.kind !== "found") continue;

    for (const arb of result.arbs) {
      if (arb.edgeUsd < MIN_EDGE_USD) continue;
      totalDetected++;
      insertEvolutionEvent({
        event_type: "comb-arb-detection",
        summary: `Comb-arb (LLM-aided) on "${(ev.title ?? "").slice(0, 50)}" — edge $${arb.edgeUsd.toFixed(2)}`,
        payload_json: JSON.stringify({
          eventId: ev.id,
          eventTitle: ev.title,
          marketsAnalyzed: combMarkets.length,
          constraintsUsed: constraints,
          llmTokensUsed,
          arb,
        }),
      });
    }
  }
  console.log(`\n[comb-arb-llm] done — detected ${totalDetected} arbs, used ${totalLlmConstraints} LLM-inferred constraints`);
})().catch((err) => { console.error(err); process.exit(1); });
