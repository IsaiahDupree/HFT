/**
 * Governor gate — DB-aware wrapper around the pure `portfolio/governor`
 * module. Inserts portfolio-level veto into the decision pipeline.
 *
 * Loads:
 *   - all live + paper capsules with diversity profiles (Phase 6)
 *   - all currently-open positions across paper_agents' position_basket_json
 *     (best-available signal of "what's already on the books")
 *
 * Then calls pure `checkPortfolioImpact()` and wraps the GovernorResult
 * into a GateResult envelope for the pipeline.
 *
 * Loading is lazy + cheap: a single SELECT for capsules + a single SELECT
 * for paper_agents.position_basket_json. Called once per pipeline run.
 */
import { db } from "@/lib/db/client";
import {
  checkPortfolioImpact,
  readGovernorThresholdsFromEnv,
  type CapsuleSnapshot,
  type GovernorProposal,
  type PortfolioPosition,
} from "@/lib/portfolio/governor";
import { Gate, type DecisionContext, type GateResult } from "@/lib/decision/types";

/** Build a governor proposal from the pipeline's DecisionContext. */
function buildProposal(ctx: DecisionContext, capsule: CapsuleSnapshot | undefined): GovernorProposal {
  // Asset hint: prefer explicit metadata.asset, fall back to symbol prefix.
  const meta = ctx.proposal.metadata ?? {};
  const asset =
    typeof meta.asset === "string"
      ? meta.asset
      : typeof meta.underlying === "string"
        ? meta.underlying
        : undefined;
  return {
    capsule_id: ctx.capsuleId,
    strategy_family: capsule?.strategy_family ?? null,
    asset_class: capsule?.asset_class ?? null,
    asset,
    side: ctx.proposal.side,
    size_usd: ctx.proposal.sizeUsd,
    time_horizon: typeof meta.time_horizon === "string" ? meta.time_horizon : undefined,
  };
}

/** Read live + paper capsules with diversity profile fields. */
function loadCapsules(): CapsuleSnapshot[] {
  return db()
    .prepare(
      `SELECT id, status, strategy_family, asset_class, capital_allocated_usd
         FROM capsules
        WHERE status IN ('live', 'paper', 'paused')`,
    )
    .all() as CapsuleSnapshot[];
}

type PaperAgentPositionRow = { id: number; position_basket_json: string };

/**
 * Read every alive paper-agent's position basket. We then walk each JSON
 * blob to assemble a flat PortfolioPosition[] keyed by capsule.
 *
 * Note: paper_agents bind to capsules via `paper_agent_id` on capsules.
 * We look up the capsule id via that mapping.
 */
function loadOpenPositions(): PortfolioPosition[] {
  // Map paper_agent_id → capsule_id (for live capsules — paused capsules
  // shouldn't contribute to collision/correlation math).
  const capsuleByAgentId = new Map<number, { capsule_id: string; asset_class: string | null }>();
  const capsuleRows = db()
    .prepare(
      `SELECT id, paper_agent_id, asset_class
         FROM capsules
        WHERE status IN ('live', 'paper') AND paper_agent_id IS NOT NULL`,
    )
    .all() as { id: string; paper_agent_id: number; asset_class: string | null }[];
  for (const c of capsuleRows) {
    capsuleByAgentId.set(c.paper_agent_id, { capsule_id: c.id, asset_class: c.asset_class });
  }
  if (capsuleByAgentId.size === 0) return [];

  const ids = Array.from(capsuleByAgentId.keys());
  const placeholders = ids.map(() => "?").join(",");
  const agents = db()
    .prepare(
      `SELECT id, position_basket_json
         FROM paper_agents
        WHERE id IN (${placeholders})
          AND alive = 1
          AND position_basket_json IS NOT NULL
          AND position_basket_json != '[]'`,
    )
    .all(...ids) as PaperAgentPositionRow[];

  const out: PortfolioPosition[] = [];
  for (const a of agents) {
    let positions: unknown;
    try {
      positions = JSON.parse(a.position_basket_json);
    } catch {
      continue;
    }
    if (!Array.isArray(positions)) continue;
    const binding = capsuleByAgentId.get(a.id);
    if (!binding) continue;
    for (const p of positions) {
      if (!p || typeof p !== "object") continue;
      const pos = p as Record<string, unknown>;
      const sizeUsd = typeof pos.size_usd === "number" ? pos.size_usd : 0;
      const side = pos.side === "SELL" ? "SELL" : "BUY";
      if (sizeUsd <= 0) continue;
      // Best-effort asset extraction: market_id like "BTC-USD-5min-..." or
      // metadata.asset; if unavailable, leave undefined (collision rule will
      // simply skip the position).
      let asset: string | undefined = undefined;
      const marketId = typeof pos.market_id === "string" ? pos.market_id : undefined;
      if (marketId) {
        // Strip "-USD", "-USDT" suffix and timeframe markers for asset extraction.
        const match = /^([A-Z]{2,6})/.exec(marketId);
        if (match) asset = match[1];
      }
      const meta = pos.metadata && typeof pos.metadata === "object" ? (pos.metadata as Record<string, unknown>) : {};
      if (typeof meta.asset === "string") asset = meta.asset;
      out.push({
        capsule_id: binding.capsule_id,
        asset_class: binding.asset_class,
        asset,
        side,
        size_usd: sizeUsd,
        time_horizon: typeof meta.time_horizon === "string" ? meta.time_horizon : undefined,
      });
    }
  }
  return out;
}

/**
 * Pipeline gate: load portfolio snapshot, call pure governor, wrap in GateResult.
 * Score mapping:
 *   - 'approve' → score 1.0, action CONTINUE
 *   - 'cap_size' → score 0.5, action REDUCE_SIZE (caller honors cap_size_usd
 *     by setting size_multiplier so approved_size_usd ≤ cap_size_usd)
 *   - 'reject' → score 0, action REJECT
 */
export function governorGate(ctx: DecisionContext): GateResult {
  const thresholds = readGovernorThresholdsFromEnv();
  const capsules = loadCapsules();
  const proposingCapsule = capsules.find((c) => c.id === ctx.capsuleId);
  const proposal = buildProposal(ctx, proposingCapsule);
  const openPositions = loadOpenPositions();

  const r = checkPortfolioImpact({
    proposal,
    capsules,
    openPositions,
    thresholds,
  });

  if (r.action === "approve") {
    return Gate.pass("governor", 1.0, r.summary, r.details);
  }
  if (r.action === "cap_size") {
    return Gate.reduce(
      "governor",
      0.5,
      r.summary,
      { ...(r.details ?? {}), cap_size_usd: r.cap_size_usd, reason: r.reason },
    );
  }
  return Gate.reject("governor", r.summary, { ...(r.details ?? {}), reason: r.reason });
}
