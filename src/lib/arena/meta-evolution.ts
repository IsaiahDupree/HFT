/**
 * Meta-evolution — once every N generations, ask Claude to synthesize NEW
 * genome variants by reading the existing population's genomes + performance.
 *
 * This is a layer ABOVE per-agent mutation. mutate.ts asks "tweak this one
 * agent's params"; meta-evolution asks "looking at ALL these agents, what
 * variants haven't we tried that might combine winning patterns?".
 *
 * Safety contract:
 *   - LLM output is validated against SubGenomeSchema (zod). Anything that
 *     doesn't parse is silently dropped (logged with reason).
 *   - LLM can NOT propose new strategy kinds — they must be in the existing
 *     union. No code generation.
 *   - LLM can NOT bypass param bounds — zod rejects out-of-range numbers.
 *   - Meta-seeded agents compete on the same field as preset / mutation /
 *     survivor genomes. If they're worse, normal evolution culls them.
 *
 * Attribution: agents get `introduced_by: "meta-llm"` so future analytics
 * can compare LLM-seeded vs preset vs mutation lineages.
 *
 * Cadence: every `ARENA_META_EVOLVE_EVERY` gens (default 5). Disable by
 * setting to 0. Cost: ~$0.005/run with Haiku via OAuth (free on Claude Max).
 *
 * Bug-fix / feature 2026-05-27.
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { authIsAvailable, getOAuthClient } from "@/lib/anthropic/auth";
import { SubGenomeSchema, type SubGenome } from "./genome";
import { insertPaperAgent } from "./db";
import { genomeNickname } from "./genome";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_EVERY = 5;
const DEFAULT_MAX_PROPOSALS = 5;

export type MetaEvolveResult = {
  attempted: boolean;
  reason?: string;
  proposed_count: number;
  accepted_count: number;
  rejected_reasons: string[];
  seeded_agent_ids: number[];
};

/** Should this seal cycle trigger a meta-evolution pass? */
export function shouldRunMetaEvolution(sealedGenNumber: number): boolean {
  const every = Number(process.env.ARENA_META_EVOLVE_EVERY ?? DEFAULT_EVERY);
  if (!Number.isFinite(every) || every <= 0) return false;
  return sealedGenNumber % every === 0;
}

/**
 * Collect the existing population's genomes + perf for the LLM prompt.
 * Strict filter: only agents with ≥10 trades + positive realized PnL get
 * included (we want signal, not noise from 0-3 trade WR distortions).
 */
function collectPromisingAgents(): Array<{ kind: string; params: unknown; pnl_pct: number; max_dd_pct: number; trades: number; win_rate: number; introduced_by: string | null }> {
  const rows = db().prepare(
    `SELECT genome_json, realized_pnl_usd, trades_count, wins_count, cash_usd_start,
            peak_equity_usd, max_drawdown_usd, introduced_by
       FROM paper_agents
      WHERE alive = 1
        AND trades_count >= 10
        AND realized_pnl_usd > 0
      ORDER BY realized_pnl_usd DESC
      LIMIT 30`,
  ).all() as Array<{
    genome_json: string; realized_pnl_usd: number; trades_count: number;
    wins_count: number; cash_usd_start: number; peak_equity_usd: number;
    max_drawdown_usd: number; introduced_by: string | null;
  }>;
  return rows.map((r) => {
    let kind = "unknown";
    let params: unknown = {};
    try { const g = JSON.parse(r.genome_json); kind = g.kind; params = g.params; } catch {}
    const pnl_pct = r.cash_usd_start > 0 ? r.realized_pnl_usd / r.cash_usd_start : 0;
    const max_dd_pct = r.peak_equity_usd > 0 ? r.max_drawdown_usd / r.peak_equity_usd : 0;
    return {
      kind, params,
      pnl_pct, max_dd_pct,
      trades: r.trades_count,
      win_rate: r.trades_count > 0 ? r.wins_count / r.trades_count : 0,
      introduced_by: r.introduced_by,
    };
  });
}

/**
 * Build the system prompt. Held outside `runMetaEvolution` so the cache
 * fingerprint stays stable across calls (Haiku 4.5 has a 4096-token cache
 * floor; if the prompt drifts, we lose the cache discount).
 */
const SYSTEM_PROMPT = `You are an evolutionary search operator for a small population of automated trading agents on Polymarket (prediction markets) + Coinbase (crypto).

You'll be given a JSON list of the population's most-promising agents — each with a strategy kind, parameters, sample size (trades), realized P/L%, max drawdown%, and win rate.

Your job: propose NEW genome variants that combine or extend the winning patterns. Stay strictly within the allowed strategy kinds (no new kinds — only variants of existing ones) and parameter bounds.

Output a single JSON object:
{
  "variants": [
    {
      "reasoning": "One sentence why this variant might win.",
      "genome": { "kind": "<existing-kind>", "params": { ... } }
    },
    ...
  ]
}

Rules:
1. At most 5 variants.
2. Each genome.kind MUST be one of: poly_fade_spike, poly_breakout, cb_breakout, cb_mean_reversion, cross_venue_arb, cb_momentum_burst, random_walk_baseline, category_specialist, wallet_copy_filtered, polymarket_market_maker, llm_probability_oracle, poly_short_binary_directional.
3. Each genome.params MUST contain ONLY the param keys appropriate for that kind. Don't invent params.
4. Prefer variants that combine winning patterns from DIFFERENT existing agents rather than just tweaking one.
5. If a strategy kind appears multiple times among winners with consistent param ranges, propose a variant that pushes one param to the edge of that range.
6. NO PROSE outside the JSON. NO markdown. Raw JSON only.`;

export async function runMetaEvolution(opts: {
  nextGen: number;
  startingCash?: number;
  maxProposals?: number;
} = { nextGen: -1 }): Promise<MetaEvolveResult> {
  if (!authIsAvailable()) {
    return { attempted: false, reason: "no anthropic auth", proposed_count: 0, accepted_count: 0, rejected_reasons: [], seeded_agent_ids: [] };
  }
  const agents = collectPromisingAgents();
  if (agents.length < 3) {
    return { attempted: false, reason: `only ${agents.length} promising agents (need >= 3)`, proposed_count: 0, accepted_count: 0, rejected_reasons: [], seeded_agent_ids: [] };
  }
  const maxProposals = opts.maxProposals ?? Number(process.env.ARENA_META_EVOLVE_MAX ?? DEFAULT_MAX_PROPOSALS);
  const startingCash = opts.startingCash ?? 100;

  let client;
  try { client = await getOAuthClient(); } catch (e) {
    return { attempted: false, reason: `oauth client failed: ${(e as Error).message?.slice(0, 80)}`, proposed_count: 0, accepted_count: 0, rejected_reasons: [], seeded_agent_ids: [] };
  }

  const userPrompt = JSON.stringify({
    population: agents,
    max_variants: maxProposals,
  });

  let rawText = "";
  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    rawText = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
  } catch (e) {
    return { attempted: false, reason: `haiku call failed: ${(e as Error).message?.slice(0, 100)}`, proposed_count: 0, accepted_count: 0, rejected_reasons: [], seeded_agent_ids: [] };
  }

  // Extract the JSON object (haiku often wraps in markdown fences).
  const start = rawText.indexOf("{");
  if (start === -1) {
    return { attempted: true, reason: "no JSON in response", proposed_count: 0, accepted_count: 0, rejected_reasons: ["no JSON found"], seeded_agent_ids: [] };
  }
  let depth = 0, end = -1;
  for (let i = start; i < rawText.length; i++) {
    if (rawText[i] === "{") depth++;
    else if (rawText[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) {
    return { attempted: true, reason: "JSON not balanced", proposed_count: 0, accepted_count: 0, rejected_reasons: ["unbalanced JSON"], seeded_agent_ids: [] };
  }

  let parsed: { variants?: Array<{ reasoning?: string; genome?: unknown }> } = {};
  try { parsed = JSON.parse(rawText.slice(start, end + 1)); } catch (e) {
    return { attempted: true, reason: `JSON parse error: ${(e as Error).message?.slice(0, 80)}`, proposed_count: 0, accepted_count: 0, rejected_reasons: ["JSON.parse threw"], seeded_agent_ids: [] };
  }

  const variants = parsed.variants ?? [];
  const proposedCount = variants.length;
  const rejectedReasons: string[] = [];
  const seededIds: number[] = [];

  for (const v of variants.slice(0, maxProposals)) {
    if (!v.genome) { rejectedReasons.push("missing genome"); continue; }
    const validated = SubGenomeSchema.safeParse(v.genome);
    if (!validated.success) {
      rejectedReasons.push(`zod rejected: ${validated.error.issues[0]?.message ?? "unknown"}`);
      continue;
    }
    const genome = validated.data as SubGenome;
    const id = insertPaperAgent({
      name: `g${opts.nextGen}-meta-${seededIds.length}-${genomeNickname(genome)}`,
      generation: opts.nextGen,
      parent_paper_agent_id: null,
      genome,
      introduced_by: "meta-llm",
      cash_usd_start: startingCash,
    });
    seededIds.push(id);
  }

  insertEvolutionEvent({
    event_type: "meta-evolve",
    summary: `Meta-evolution seeded ${seededIds.length}/${proposedCount} genome variants into gen${opts.nextGen} (${rejectedReasons.length} rejected)`,
    payload_json: JSON.stringify({
      nextGen: opts.nextGen,
      population_size: agents.length,
      proposed: proposedCount,
      accepted: seededIds.length,
      rejected_reasons: rejectedReasons,
      seeded_agent_ids: seededIds,
      sample_winning_kinds: [...new Set(agents.map((a) => a.kind))].slice(0, 6),
    }),
  });

  return {
    attempted: true,
    proposed_count: proposedCount,
    accepted_count: seededIds.length,
    rejected_reasons: rejectedReasons,
    seeded_agent_ids: seededIds,
  };
}
