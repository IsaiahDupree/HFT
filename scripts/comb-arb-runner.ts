/**
 * Periodic combinatorial-arbitrage scanner over Gamma event groups.
 *
 * For each event with >= 2 markets:
 *  1. Pull every market's YES + NO tokens.
 *  2. Fetch orderbooks for each token (best ask = entry price).
 *  3. Hand to findCombinatorialArbs (LP solver: direct for ≤14 outcomes, column gen otherwise).
 *  4. Log detections to evolution_log with full basket payload.
 *
 * Dependency constraints (the "Trump wins PA" ⇒ "Republicans win PA by 5+" kind)
 * are NOT auto-inferred yet. v1 finds the conservative basket arbs the LP can
 * prove without extra knowledge; the article's 81% accuracy LLM approach is the
 * next iteration. The runner already passes a `dependencyConstraints` arg to
 * the solver — just supply them when you have them.
 */
import "./_env.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { findCombinatorialArbs, type CombinatorialMarket } from "../src/lib/polymarket/arb.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

const N_EVENTS = Number(process.env.COMB_EVENTS ?? "10");
const MIN_EDGE_USD = Number(process.env.COMB_MIN_EDGE_USD ?? "0.10");

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
  console.log(`[comb-arb] scanning ${N_EVENTS} events at ${new Date().toISOString()}`);
  const events = await poly.events({ limit: N_EVENTS, closed: false });
  let scanned = 0;
  let detected = 0;

  for (const ev of events) {
    const markets = (ev.markets ?? []) as any[];
    if (markets.length < 2) continue;
    scanned++;

    // Build the CombinatorialMarket list for the LP.
    const combMarkets: CombinatorialMarket[] = [];
    let tokenCount = 0;
    for (const m of markets) {
      let tokenIds: string[] = [];
      try { tokenIds = JSON.parse(m.clobTokenIds ?? "[]"); } catch {}
      if (tokenIds.length < 2) continue;
      const books = await Promise.all(tokenIds.map((id) => safe(() => poly.orderbook(id))));
      const outcomes: CombinatorialMarket["outcomes"] = [];
      let outcomeLabels: string[] = [];
      try { outcomeLabels = JSON.parse(m.outcomes ?? "[\"Yes\",\"No\"]"); } catch { outcomeLabels = ["Yes", "No"]; }
      for (let i = 0; i < tokenIds.length; i++) {
        const top = topAsk(books[i]);
        if (!top) continue;
        outcomes.push({
          tokenId: tokenIds[i],
          askPrice: top.price,
          askSize: top.size,
          label: outcomeLabels[i] ?? `outcome_${i}`,
        });
      }
      if (outcomes.length < 2) continue;
      combMarkets.push({ conditionId: m.conditionId, question: m.question, outcomes });
      tokenCount += outcomes.length;
      if (tokenCount > 24) break; // keep the LP universe manageable per event
    }
    if (combMarkets.length === 0) continue;

    const result = await findCombinatorialArbs(combMarkets, [], { depthCapFraction: 0.5 });
    if (result.kind !== "found") continue;
    for (const arb of result.arbs) {
      if (arb.edgeUsd < MIN_EDGE_USD) continue;
      detected++;
      console.log(`[comb-arb] DETECT  event="${(ev.title ?? "").slice(0, 50)}"  markets=${combMarkets.length}  cost=$${arb.totalCostUsd.toFixed(2)}  edge=$${arb.edgeUsd.toFixed(2)}`);
      insertEvolutionEvent({
        event_type: "comb-arb-detection",
        summary: `Comb-arb on event "${(ev.title ?? "").slice(0, 50)}" — edge $${arb.edgeUsd.toFixed(2)}`,
        payload_json: JSON.stringify({
          eventId: ev.id,
          eventTitle: ev.title,
          eventSlug: ev.slug,
          marketsAnalyzed: combMarkets.length,
          tokenCount,
          arb,
        }),
      });
    }
  }

  console.log(`[comb-arb] done — scanned ${scanned} multi-market events, detected ${detected} arbs`);
})().catch((err) => { console.error(err); process.exit(1); });
