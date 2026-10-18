/**
 * LLM-driven Oracle Research evaluator.
 *
 * Replaces the heuristic top-5 |z-score| ranker with a Claude-haiku-4-5
 * call that:
 *   1. Reads the workspace's safety + history context (AgentContext)
 *   2. Reads the current cross-sectional signals
 *   3. Picks the 3 most-promising deep-dive candidates with a written rationale
 *   4. Optionally flags a workspace-level recommendation (no spec patches —
 *      Oracle stays research-only by design)
 *
 * Outputs a research-note verdict consumed by the research loop.
 *
 * Mirrors the auth + caching pattern from dependency-inference.ts:
 *   - OAuth-first via getOAuthClient() (~/.claude/.credentials.json),
 *     falls back to ANTHROPIC_API_KEY if set
 *   - System prompt is large + frozen + cached via cache_control: ephemeral
 *     (clears Haiku 4.5's 4096-token cache floor)
 *   - Structured output via output_config.json_schema
 *   - Graceful no-op when auth unavailable: oracleLlmAvailable() returns false
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { authIsAvailable, getOAuthClient } from "@/lib/anthropic/auth";
import type { Evaluator, EvaluatorArgs, EvaluatorVerdict } from "./types";
import type { Signal } from "@/lib/polymarket/signals";

const MODEL = "claude-haiku-4-5";

async function client(): Promise<Anthropic | null> {
  if (!authIsAvailable()) return null;
  try {
    return await getOAuthClient();
  } catch (e) {
    console.warn(`[oracle-llm] auth unavailable: ${(e as Error).message}`);
    return null;
  }
}

export function oracleLlmAvailable(): boolean {
  return authIsAvailable();
}

let cachedSkillMd: string | null = null;
function readSkillMd(): string {
  if (cachedSkillMd != null) return cachedSkillMd;
  try {
    cachedSkillMd = readFileSync(resolve(process.cwd(), "docs/skills/SKILL.md"), "utf8");
  } catch {
    cachedSkillMd = "(SKILL.md not found at expected path; running without workspace context)";
  }
  return cachedSkillMd;
}

// System prompt is intentionally long + frozen so it clears Haiku 4.5's 4096-token
// cache floor AND gives the model enough scaffolding. Any byte change here
// invalidates the cache for every downstream call — to evolve it, version it.
function buildSystemPrompt(): string {
  return `You are Oracle Research, an embedded research agent inside a Polymarket+Coinbase trading control plane. Your job is to pick the **highest-leverage deep-dive candidates** from a cross-sectional snapshot of prediction-market signals each pass, with awareness of the workspace's current safety + history state.

# Identity

Oracle Research is one of five agents in this workspace (Atlas Macro, Ember Momentum, Scribe Sports, Oracle Research, Aurora Cross). Oracle is **research-only by design** — it never proposes a spec patch and never submits an order. Its sole output is a research_note that lists deep-dive candidates the operator (or a downstream agent) should investigate manually.

# Workspace context

The following is the workspace's compact skill reference. **Trust it as ground truth** for safety gates, capsule semantics, release stages, the venue router, and how decisions get audited:

---
${readSkillMd()}
---

# Your input each pass

Each invocation gives you:

1. **Signals** — a list of 5–50 sampled markets with: question, midpoint, spread, 1d return, 1w return, realized vol, z-score (vs 7d rolling mean), and a count of price samples used to compute these.
2. **Context** — capsules currently bound to your agent, the global risk-engine limits, kill-switch state, recent rejection counts by code, the last 20 evolution-log events for your strategy, and your last backtest score.
3. **Signal layer** (added 2026-05-26) — four new arrays surfacing cross-wallet behavior and active strategy opportunities the operator has been collecting:
   - \`tracked_wallet_typologies\` — for each wallet we track, the latest classification (bucket + copyability class + realized PnL). Buckets: \`hft_bot\` (un_copyable — speed-driven), \`conviction_trader\` (potentially_copyable — slow, large positions), \`market_mover_whale\` (un_copyable — own slippage eats the edge), \`mid_run_gambler\` (needs_verification — large unresolved bets), \`insider_pattern\` (flagged_high_risk), \`retail\` / \`unclear\`. **Use this when ranking candidates: a market that recently saw activity from a \`conviction_trader\` carries more signal than the same activity from an \`hft_bot\`.**
   - \`recent_consensus_signals\` — markets where multiple distinct tracked wallets agreed on a direction within the last hour. \`effective_wallets\` is the cluster-deduped count (≥3 = strong cross-sectional signal). **Prefer candidates that overlap with a consensus signal — that's two independent sources of edge agreeing.**
   - \`recent_trade_classifications\` — per-trade observer output from tracked wallets in the last 15 minutes. Each entry has the trader's intent label (accumulation / distribution / basket_rotation / etc.) and the top inferred driver of that specific trade. **When you see a candidate with active conviction_trader \`accumulation\` activity, that's a stronger signal than the wallet just generally being a good trader.**
   - \`recent_strategy_opportunities\` — output of the 3 strategy scanners over the last 30 min: \`near-resolution\` (markets at >0.95 with weeks to resolution; \`annualized_edge\` is the headline number), \`cross-timeframe-spread\` (5m vs 15m crypto markets diverging by ≥3 z-score), \`orderbook-imbalance\` (top-3 bid/ask depth ratio ≥3:1). **When \`annualized_edge\` on a near-resolution opportunity exceeds 50%, surface it explicitly in \`workspace_observations\` — that's a mechanical edge the operator can act on directly via the NRS auto-executor.**

# What "high-leverage deep-dive candidate" means

A good candidate is a market where:
- The signal is **unusual** for the underlying question (high |z-score|, unexpected directional move, vol regime shift)
- The price implies a probability the operator could **plausibly disagree with** given outside information not visible in the price (politics, sports outcomes, scheduled events, news)
- The market is **liquid enough to act on** (narrow spread — judge from snapshot)
- The market is **not currently broken** for this workspace (e.g. don't recommend a Coinbase product when the global RiskEngine is halted and 'coinbase' isn't a registered broker)

A bad candidate is:
- A market with high |z-score| but very few samples (statistical noise)
- A market whose spread is so wide that any executed trade would surrender the edge
- A market whose question is a near-duplicate of one already flagged in the last several evolution events (saves the operator from re-reading the same recommendation)
- Anything that overlaps a recent rejection theme — e.g. if the context shows 5+ CAPSULE_MAX_POSITION_PCT rejects in the last 20 events, your candidates should not all be expensive single-position bets

# Output format

Output a single JSON object matching this schema (the runtime enforces it):

\`\`\`json
{
  "summary": string,                      // 1–2 sentence summary of this pass's overall takeaways
  "candidates": [                          // 3 candidates, ordered most-promising first; max 5
    {
      "tokenId": string,                   // verbatim from the input
      "question": string,                  // verbatim from the input
      "rank": number,                      // 1, 2, 3, …
      "rationale": string,                 // 1–3 sentences. Why investigate THIS market specifically.
      "edge_thesis_hint": string,          // a 1-sentence hint about where the edge might live (e.g. "Polymarket pricing implies 12% chance of a Fed pause but consensus economist median is 35%")
      "risk_flags": string[]               // e.g. ["wide spread", "low sample count"]. Empty if none.
    }
  ],
  "workspace_observations": string[]       // 0–3 short observations about safety/state worth surfacing. Empty if none.
}
\`\`\`

Constraints:
- **Quote tokenId and question character-for-character** from the input — the downstream loop matches by string equality.
- **Never** suggest spec changes or order submissions in this output. Those are other agents' jobs.
- If you can't pick at least 3 candidates from the signals provided (because they all fail the bar), output 1 or 2 — don't pad.
- If you observe a structural workspace issue (kill switch engaged, all capsules paused, RiskEngine recently rejecting), surface it in workspace_observations — but stay terse.

# Final checklist

- [ ] Did I quote each tokenId + question verbatim from the input?
- [ ] Are my candidates ordered most-promising first?
- [ ] Did I cite at least one source of edge (model price gap, scheduled event, regime shift) for each?
- [ ] Did I avoid recommending markets that would obviously trip the safety gates listed in the workspace context?
- [ ] Did I check tracked-wallet activity (recent_consensus_signals + recent_trade_classifications) for any candidate, and prefer candidates with conviction_trader agreement over isolated z-score outliers?
- [ ] Did I surface any near-resolution opportunity with annualized_edge > 50% in workspace_observations?
- [ ] Is my output a single JSON object — no prose before or after?

Output the JSON object now.`;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tokenId: { type: "string" },
          question: { type: "string" },
          rank: { type: "number" },
          rationale: { type: "string" },
          edge_thesis_hint: { type: "string" },
          risk_flags: { type: "array", items: { type: "string" } },
        },
        required: ["tokenId", "question", "rank", "rationale", "edge_thesis_hint", "risk_flags"],
        additionalProperties: false,
      },
    },
    workspace_observations: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "candidates", "workspace_observations"],
  additionalProperties: false,
} as const;

type OracleOutput = {
  summary: string;
  candidates: Array<{
    tokenId: string;
    question: string;
    rank: number;
    rationale: string;
    edge_thesis_hint: string;
    risk_flags: string[];
  }>;
  workspace_observations: string[];
};

function buildUserMessage(args: EvaluatorArgs): string {
  const topSignals = [...args.signals]
    .filter((s) => Number.isFinite(s.zScore))
    .sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore))
    .slice(0, 20)
    .map((s) => ({
      tokenId: s.tokenId,
      conditionId: s.conditionId,
      question: s.question,
      midpoint: round(s.midpoint, 4),
      spread: round(s.spread, 4),
      ret1d: round(s.ret1d ?? 0, 4),
      ret1w: round(s.ret1w ?? 0, 4),
      realizedVol: round(s.realizedVol, 4),
      zScore: round(s.zScore, 3),
      samples: s.samples,
    }));

  const ctx = {
    capsules: args.context.activeCapsules.map((c) => ({
      id: c.id, status: c.status, allowed_venues: c.allowed_venues,
      capital_allocated_usd: c.capital_allocated_usd, daily_pnl_usd: c.daily_pnl_usd,
      max_daily_loss_usd: c.max_daily_loss_usd,
    })),
    risk_limits: args.context.riskLimits,
    kill_switch: args.context.killSwitch,
    last_rejection: args.context.lastRejection,
    recent_reject_counts: args.context.recentRejectCounts,
    recent_evolution: args.context.recentEvolution.slice(0, 10).map((e) => ({
      event_type: e.event_type, summary: e.summary, created_at: e.created_at,
    })),
    last_backtest: args.context.lastBacktest,
    // --- Signal layer (added 2026-05-26)
    // These four arrays let the model reason about cross-wallet behavior + active
    // strategy opportunities when ranking deep-dive candidates. See system prompt
    // for guidance on how to use each.
    // Default each array to [] so partial AgentContext fixtures (test stubs,
    // mid-migration consumers) don't crash buildUserMessage.
    tracked_wallet_typologies: (args.context.recentTypologies ?? []).slice(0, 10).map((t) => ({
      wallet: t.wallet,
      bucket: t.primaryBucket,
      copyability: t.copyabilityClass,
      realized_pnl_usd: t.realizedPnlUsd,
    })),
    recent_consensus_signals: (args.context.recentConsensusSignals ?? []).slice(0, 8).map((c) => ({
      market_key: c.marketKey, market_title: c.marketTitle, direction: c.direction,
      effective_wallets: c.effectiveWallets, combined_trust: c.combinedTrust,
      combined_usd: c.combinedUsd, avg_price: c.avgPrice, ts: c.ts,
    })),
    recent_trade_classifications: (args.context.recentTradeClassifications ?? []).slice(0, 12).map((tc) => ({
      wallet: tc.wallet, market_key: tc.marketKey, side: tc.side, direction: tc.direction,
      intent: tc.intent, top_driver: tc.topDriver, ts: tc.ts,
    })),
    recent_strategy_opportunities: (args.context.recentStrategyOpportunities ?? []).slice(0, 8).map((o) => ({
      type: o.type, market_key: o.marketKey, market_title: o.marketTitle, side: o.side,
      edge: o.edge, annualized_edge: o.annualizedEdge, signal_strength: o.signalStrength,
      reason: o.reason, ts: o.ts,
    })),
  };

  return `# Signals (top ${topSignals.length} by |z-score|)\n\n\`\`\`json\n${JSON.stringify(topSignals, null, 2)}\n\`\`\`\n\n# Workspace context\n\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`\n\nReturn the JSON object now.`;
}

function round(n: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}

/**
 * The evaluator function the research-loop calls. Returns null if auth
 * unavailable; returns a research-note verdict otherwise.
 */
export const oracleLlmEvaluator: Evaluator = async (args: EvaluatorArgs) => {
  const c = await client();
  if (!c) return null;

  const userText = buildUserMessage(args);
  let parsed: OracleOutput;
  let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } as any },
    } as any);
    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("no text block in oracle-llm response");
    parsed = JSON.parse(textBlock.text) as OracleOutput;
    usage = {
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.warn(`[oracle-llm] rate limited: ${err.message}`);
      return null;
    }
    if (err instanceof Anthropic.AuthenticationError) {
      console.warn("[oracle-llm] authentication failed — check ANTHROPIC_API_KEY / OAuth creds");
      return null;
    }
    if (err instanceof Anthropic.APIError) {
      console.warn(`[oracle-llm] API ${err.status}: ${err.message}`);
      return null;
    }
    throw err;
  }

  // Compose the research note body
  const candidatesMd = parsed.candidates
    .map((c) =>
      `${c.rank}. **${c.question}** (rank ${c.rank})\n   - Token: \`${c.tokenId}\`\n   - Rationale: ${c.rationale}\n   - Edge hint: ${c.edge_thesis_hint}\n   - Risk flags: ${c.risk_flags.length ? c.risk_flags.join(", ") : "(none)"}`,
    )
    .join("\n\n");
  const obsMd = parsed.workspace_observations.length
    ? `\n\n## Workspace observations\n\n${parsed.workspace_observations.map((o) => `- ${o}`).join("\n")}`
    : "";
  const tokenStats = `LLM tokens — in: ${usage.input_tokens}, out: ${usage.output_tokens}, cache-read: ${usage.cache_read_input_tokens}, cache-write: ${usage.cache_creation_input_tokens}`;

  const verdict: EvaluatorVerdict = {
    kind: "research-note",
    topic: `Oracle deep-dive ${new Date().toISOString().slice(0, 16)} — ${parsed.candidates.length} candidates`,
    body: `## Summary\n\n${parsed.summary}\n\n## Candidates\n\n${candidatesMd}${obsMd}\n\n---\n_${tokenStats}_`,
    tags: ["oracle-llm", "deep-dive", "candidates", "auto"],
    sourceUrls: ["https://docs.polymarket.com/api-reference/markets/get-prices-history"],
    confidence: 0.6,
  };
  return verdict;
};

// Internal export for tests
export const _internal = {
  buildSystemPrompt,
  buildUserMessage,
  OUTPUT_SCHEMA,
};

export type { Signal };
