/**
 * LLM Trader evaluator — the video-blueprint agent, wired into this control plane.
 *
 * Unlike oracle-llm (research-only), this evaluator can ACT: given its capsule's
 * state + the current signals, it asks Claude for ONE trade decision and returns
 * a `submit-order` verdict. It NEVER touches a venue directly — the verdict flows
 * through the research-loop into `ExecutionRouter` (halt gate → capsule gate →
 * risk gate), exactly the videos' "intent → single execution gate" pattern.
 *
 * Safe by construction:
 *   - Returns null unless auth is available AND the agent has an active capsule.
 *   - Proposes size already inside the capsule envelope (the gate re-clamps).
 *   - Inert until registered in the research-loop dispatch — adding this file
 *     does not, by itself, place any orders.
 *
 * Auth + caching mirror oracle-llm.ts (OAuth-first, frozen cached system prompt,
 * JSON-schema structured output). Prompt: prompts/llm-trader-persona.v1.md.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { authIsAvailable, getOAuthClient } from "@/lib/anthropic/auth";
import type { Evaluator, EvaluatorArgs, EvaluatorVerdict } from "./types";
import type { UnifiedOrder } from "@/lib/venue/types";
import type { Capsule } from "@/lib/capsules/types";

const MODEL = "claude-haiku-4-5";
const PROMPT_VERSION = "v1";

export function traderLlmAvailable(): boolean {
  return authIsAvailable();
}

async function client(): Promise<Anthropic | null> {
  if (!authIsAvailable()) return null;
  try {
    return await getOAuthClient();
  } catch (e) {
    console.warn(`[trader-llm] auth unavailable: ${(e as Error).message}`);
    return null;
  }
}

let cachedPersona: string | null = null;
function readPersona(): string {
  if (cachedPersona != null) return cachedPersona;
  try {
    cachedPersona = readFileSync(resolve(process.cwd(), "prompts/llm-trader-persona.v1.md"), "utf8");
  } catch {
    cachedPersona = "(llm-trader-persona.v1.md not found — running with built-in fallback persona)";
  }
  return cachedPersona;
}

function buildSystemPrompt(): string {
  return `You are an autonomous trading agent operating ONE capsule of capital inside a sim→paper→live control plane. Your decision is returned as a single trade INTENT; a separate execution gate (halt → capsule → risk) is the only path to a venue, and it will clamp or reject anything outside your capsule's envelope. Propose in-bounds.

The following is your versioned persona + rules of engagement. Trust it as ground truth:

---
${readPersona()}
---

You will be given your capsule state and a list of candidate markets (with prices and signal stats). Choose AT MOST ONE action this pass:
- OPEN a position on exactly one candidate (quote its tokenId character-for-character), or
- HOLD (act on nothing) when there is no clean, citable edge.

Hard rules:
- Only OPEN with a concrete, numeric edge stated in "rationale" (z-score stretch, momentum, spread, annualized edge…).
- size_usd must be ≤ the capsule's max_position_usd shown in the input. Smaller when conviction is low.
- Never exceed the capsule. Never propose more than one position. When unsure, HOLD.
- Output a single JSON object only — no prose, no markdown fences.`;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["OPEN", "HOLD"] },
    tokenId: { type: "string" },
    side: { type: "string", enum: ["BUY", "SELL"] },
    size_usd: { type: "number" },
    confidence: { type: "number" },
    rationale: { type: "string" },
    edge_sources: { type: "array", items: { type: "string" } },
  },
  required: ["action", "tokenId", "side", "size_usd", "confidence", "rationale", "edge_sources"],
  additionalProperties: false,
} as const;

type TraderOutput = {
  action: "OPEN" | "HOLD";
  tokenId: string;
  side: "BUY" | "SELL";
  size_usd: number;
  confidence: number;
  rationale: string;
  edge_sources: string[];
};

type Candidate = { tokenId: string; question: string; midpoint: number; spread: number; zScore: number; realizedVol: number };

function topCandidates(args: EvaluatorArgs, n = 15): Candidate[] {
  return [...args.signals]
    .filter((s) => Number.isFinite(s.zScore))
    .sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore))
    .slice(0, n)
    .map((s) => ({
      tokenId: s.tokenId,
      question: s.question,
      midpoint: round(s.midpoint ?? 0.5, 4),
      spread: round(s.spread ?? 0, 4),
      zScore: round(s.zScore ?? 0, 3),
      realizedVol: round(s.realizedVol ?? 0, 4),
    }));
}

function round(n: number, d: number): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

function maxPositionUsd(c: Capsule): number {
  // Headroom inside the capsule envelope: position cap vs available cash.
  const byPct = c.capital_allocated_usd * c.max_position_pct;
  const avail = c.capital_available_usd > 0 ? c.capital_available_usd : c.capital_allocated_usd;
  return Math.max(0, Math.min(byPct, avail));
}

function buildUserMessage(args: EvaluatorArgs, capsule: Capsule, candidates: Candidate[], maxUsd: number): string {
  const cap = {
    id: capsule.id,
    status: capsule.status,
    allowed_venues: capsule.allowed_venues,
    capital_allocated_usd: capsule.capital_allocated_usd,
    capital_available_usd: capsule.capital_available_usd,
    max_position_usd: round(maxUsd, 2),
    max_position_pct: capsule.max_position_pct,
    daily_pnl_usd: capsule.daily_pnl_usd,
    max_daily_loss_usd: capsule.max_daily_loss_usd,
    open_positions: capsule.open_positions,
    trades_today: capsule.trades_today,
  };
  const risk = {
    kill_switch: args.context.killSwitch.halted,
    recent_rejections: args.context.recentRejectCounts,
  };
  return `# Capsule\n\n\`\`\`json\n${JSON.stringify(cap, null, 2)}\n\`\`\`\n\n# Risk state\n\n\`\`\`json\n${JSON.stringify(risk, null, 2)}\n\`\`\`\n\n# Candidate markets (top ${candidates.length} by |z-score|)\n\n\`\`\`json\n${JSON.stringify(candidates, null, 2)}\n\`\`\`\n\nReturn the JSON decision object now.`;
}

export const traderLlmEvaluator: Evaluator = async (args: EvaluatorArgs): Promise<EvaluatorVerdict> => {
  // No capital, no halt-trading, no auth → nothing to do.
  if (args.context.killSwitch.halted) return null;
  const capsule = args.context.activeCapsules[0];
  if (!capsule) return null;
  const maxUsd = maxPositionUsd(capsule);
  if (maxUsd < 1) return null;

  const candidates = topCandidates(args);
  if (candidates.length === 0) return null;

  const c = await client();
  if (!c) return null;

  let parsed: TraderOutput;
  try {
    const resp = await c.messages.create(
      {
        model: MODEL,
        max_tokens: 700,
        system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(args, capsule, candidates, maxUsd) }],
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } as any },
      } as any,
    );
    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) return null;
    parsed = JSON.parse(textBlock.text) as TraderOutput;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.APIError) {
      console.warn(`[trader-llm] ${(err as Error).message}`);
      return null;
    }
    throw err;
  }

  if (parsed.action !== "OPEN") return null;
  const chosen = candidates.find((c2) => c2.tokenId === parsed.tokenId);
  if (!chosen) return null; // model must quote a real candidate
  const size = Math.min(Math.max(parsed.size_usd, 0), maxUsd);
  if (size < 1) return null;

  const venue = capsule.allowed_venues[0] ?? "sim";
  const order: UnifiedOrder = {
    clientOrderId: `trader-llm-${capsule.id}-${args.current.id}-${Date.now()}`,
    venue,
    symbol: chosen.tokenId,
    side: parsed.side === "SELL" ? "SELL" : "BUY",
    type: "MARKET",
    size: round(size, 2),
    refPrice: chosen.midpoint,
    capsuleId: capsule.id,
    agentId: args.context.agentId ?? undefined,
    strategyId: args.strategy.id,
    strategyVersionId: args.current.id,
    metadata: {
      source: "trader-llm",
      prompt_version: PROMPT_VERSION,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      edge_sources: parsed.edge_sources,
      question: chosen.question,
    },
  };

  return {
    kind: "submit-order",
    order,
    note: `trader-llm: ${parsed.side} ${chosen.question.slice(0, 60)} — ${parsed.rationale.slice(0, 140)}`,
  };
};

export const _internal = { buildSystemPrompt, buildUserMessage, OUTPUT_SCHEMA, maxPositionUsd };
