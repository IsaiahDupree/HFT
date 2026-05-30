/**
 * Oracle pre-tick warmer — runs ONCE per tick, before the per-agent decide
 * loop. Picks the highest-priority `llm_probability_oracle` agent and warms
 * the cache for the most-ambiguous market (highest |mid − 0.5| × liquidity).
 *
 * This decouples the async LLM call from the synchronous `decide()` interface
 * — `decide()` just reads `peekOracleCache` and holds on miss.
 *
 * Hard-gated by `ARENA_LLM_ORACLE_ENABLED=1` env var. Inert by default. Single
 * call per tick keeps cost bounded regardless of population size.
 *
 * Spec: `docs/prds/lunar-inspired-arena-strategies.md` §6.5 cost cap.
 */
import { callOracle, isRateLimitCoolingDown, rateLimitMinRemaining } from "./llm-oracle";
import { checkBudget } from "./llm-oracle-budget";
import { liveEquity } from "./score";
import { db } from "@/lib/db/client";
import type { LiveAgent, TickContext } from "./types";

export function oracleEnabled(): boolean {
  return process.env.ARENA_LLM_ORACLE_ENABLED === "1";
}

export type WarmResult = {
  attempted: boolean;
  market_id?: string;
  result?: { probability: number; confidence: string };
  reason?: string;
};

/**
 * If there's at least one alive oracle agent and the env is enabled, warm
 * the cache for one market this tick. Returns metadata for the tick log.
 */
export async function warmOracleCacheForTick(agents: LiveAgent[], ctx: TickContext): Promise<WarmResult> {
  if (!oracleEnabled()) return { attempted: false, reason: "ARENA_LLM_ORACLE_ENABLED != 1" };
  const oracles = agents.filter((a) => a.genome.kind === "llm_probability_oracle");
  if (oracles.length === 0) return { attempted: false, reason: "no oracle agents alive" };

  // Pick the highest-cash oracle agent as the "top-ranked" — proxy for
  // priority. Could be replaced with fitness-rank later.
  const top = [...oracles].sort((a, b) => liveEquity(b) - liveEquity(a))[0];
  if (top.genome.kind !== "llm_probability_oracle") return { attempted: false, reason: "type narrow failed" };
  const params = top.genome.params;

  // Find the most-ambiguous poly market in context — highest |mid − 0.5|
  // times normalized liquidity. We don't have liquidity in the ctx (would
  // need extra join); approximate by |mid − 0.5| alone for now.
  const candidates: Array<{ id: string; question: string; midpoint: number; category: string | undefined }> = [];
  for (const [mid, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    if (params.category_filter && win.latest.category !== params.category_filter) continue;
    if (win.latest.price <= 0.05 || win.latest.price >= 0.95) continue; // degenerate
    // Look up question text — sim doesn't carry it in Snapshot, so we fetch.
    const row = db().prepare(
      `SELECT question FROM market_snapshots WHERE token_id = ? ORDER BY captured_at DESC LIMIT 1`,
    ).get(mid) as { question: string } | undefined;
    if (!row) continue;
    candidates.push({ id: mid, question: row.question, midpoint: win.latest.price, category: win.latest.category });
  }
  if (candidates.length === 0) return { attempted: false, reason: "no candidate markets" };

  // Sort by ambiguity (|mid − 0.5| in [0, 0.45]). Higher = more decisive market,
  // LESS ambiguous. We want markets near 0.5 — most ambiguous. So minimize |p − 0.5|.
  candidates.sort((a, b) => Math.abs(a.midpoint - 0.5) - Math.abs(b.midpoint - 0.5));
  const pick = candidates[0];

  const budget = checkBudget();
  if (!budget.allowed) return { attempted: false, reason: `budget exhausted ($${budget.spent_usd.toFixed(3)}/${budget.cap_usd})` };
  if (isRateLimitCoolingDown()) {
    return { attempted: false, reason: `rate-limit cooldown (${rateLimitMinRemaining().toFixed(0)}m remaining)` };
  }

  const result = await callOracle({
    marketId: pick.id,
    question: pick.question,
    marketImpliedProb: pick.midpoint,
    category: pick.category,
    model: params.model,
    promptVersion: params.prompt_version,
    cacheTtlMin: params.cache_ttl_min,
    callerAgentId: top.id,
  });
  if (!result) {
    // Inspect the call log to give a precise reason instead of the previous
    // catch-all "auth/parse/budget". The most recent llm_call_log row tells
    // us exactly which classification fired.
    const lastErr = db().prepare(
      `SELECT error_kind FROM llm_call_log WHERE market_id = ? ORDER BY called_at DESC LIMIT 1`,
    ).get(pick.id) as { error_kind: string | null } | undefined;
    const why = lastErr?.error_kind ?? "no-call (auth missing or cache miss with budget exhausted)";
    return { attempted: true, market_id: pick.id, reason: `oracle returned null (${why})` };
  }
  return { attempted: true, market_id: pick.id, result: { probability: result.probability, confidence: result.confidence } };
}
