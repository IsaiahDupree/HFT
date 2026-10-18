/**
 * Auto-promote top-tier elites to real-money live capsules.
 *
 * Runs at the end of every evolution seal. Picks the top-3 elites that have
 * proven they can actually win (≥3 round-trips + positive realized PnL),
 * creates a live capsule for each, and re-balances capital across them by
 * splitting ARENA_LIVE_CAPITAL_TOTAL_USD equally.
 *
 * Inverse path: if an existing live capsule's agent drops out of the top-3,
 * we PAUSE (not close) that capsule. Pausing prevents new orders but
 * preserves the binding + history so the operator can review before any
 * decommissioning. To fully decommission, the operator manually flips the
 * capsule status to 'closed' from the /capsules page.
 *
 * Safety contract:
 *   - ALLOW_AUTO_PROMOTE=1 env required. Without it, returns { skipped }.
 *   - ARENA_LIVE_CAPITAL_TOTAL_USD must be set to a positive number. This is
 *     the total real-money budget for ALL auto-promoted live capsules. The
 *     operator opts in by setting this; it's a hard ceiling.
 *   - ALLOW_TRADE is checked separately by the execute layer — so even if
 *     auto-promote runs, no live orders fire unless ALLOW_TRADE=1 too.
 *   - Re-running is idempotent: existing capsules are updated in place, not
 *     duplicated.
 *
 * The agent's per-capsule risk budget:
 *   - capital_allocated = total / N
 *   - max_daily_loss = ARENA_AUTO_PROMOTE_DAILY_LOSS_PCT × capital
 *     (default 0.30 — capsule auto-pauses after a -30% day)
 *   - max_total_drawdown = ARENA_AUTO_PROMOTE_TOTAL_DD_PCT × capital
 *     (default 0.60 — capsule auto-pauses after -60% lifetime)
 *   - max_open_positions = 3
 *   - max_trades_per_day = 20
 *
 * These multiply with the env-level MAX_TRADE_USD / MAX_DAILY_USD caps;
 * whichever is tighter wins on each order.
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { listAliveElites, listAliveAgentsAcrossGens } from "./db";
import { rankAgents } from "./score";
import { createCapsule, getCapsule, setStatus } from "@/lib/capsules/store";
import { readRiskBudgetFromEnv } from "./risk-budget";
import { inferDiversityProfile } from "@/lib/capsules/diversity-inference";
import type { PaperAgentRow } from "./types";

const DEFAULT_TOP_N = 3;
const DEFAULT_MIN_TRADES = 3;

export type AutoPromoteResult = {
  skipped?: string;
  qualified_agents: number;
  promoted: Array<{ agent_id: number; agent_name: string; capsule_id: string; capital_usd: number }>;
  paused: Array<{ agent_id: number; capsule_id: string; reason: string }>;
  total_budget_usd: number;
  per_capsule_usd: number;
};

/**
 * Run one auto-promote cycle. Pure side-effects to the `capsules` table +
 * evolution_log. Safe to call repeatedly — idempotent.
 */
export function runAutoPromote(opts: { topN?: number; minTrades?: number } = {}): AutoPromoteResult {
  if (process.env.ALLOW_AUTO_PROMOTE !== "1") {
    return emptyResult({ skipped: "ALLOW_AUTO_PROMOTE != 1" });
  }
  // Risk budget — single derivation point. See src/lib/arena/risk-budget.ts.
  // Capital, daily-loss cap, total-DD cap, and the per-capsule trade-count cap
  // all derive from (stake_usd, n_agents, daily_stakes, lifetime_stakes).
  // Equation chain: capital = stake × lifetime_stakes; daily-loss = stake ×
  // daily_stakes; lifetime-DD = capital. No more independent USD knobs.
  const budget = readRiskBudgetFromEnv();
  const totalBudget = budget.global.total_live_capital_usd;
  if (totalBudget <= 0) {
    return emptyResult({ skipped: "Risk budget total_live_capital_usd <= 0 (RISK_STAKE_USD × RISK_N_AGENTS × RISK_LIFETIME_STAKES_AT_RISK)" });
  }

  const topN = opts.topN ?? budget.inputs.nAgents;
  const minTrades = opts.minTrades ?? Number(process.env.ARENA_AUTO_PROMOTE_MIN_TRADES ?? DEFAULT_MIN_TRADES);

  // 1. Source candidate agents.
  //
  //   Previous behavior: only consider is_elite=1 agents. That broke when
  //   non-live-eligible strategies (fade-spike) dominated fitness — they'd
  //   take all elite slots, then auto-promote would filter them out, leaving
  //   ZERO live capsules even though proven live-fillable agents existed.
  //
  //   New behavior: rank from ALL alive agents. The live-eligibility filter
  //   below then picks the best LIVE-FILLABLE agents from that ranking.
  //   Elite status is now used solely for cull protection (its original
  //   purpose) — not as a gate for live capsule assignment.
  //   Bug-fix 2026-05-27 (#25).
  const candidates = listAliveAgentsAcrossGens();
  const ranked = rankAgents(candidates);
  // Only strategies whose Polymarket fills are backed by the house market-maker
  // (off-book MM liquidity) can reliably fill FAK live orders. Strategies that
  // depend on visible CLOB orderbook depth (fade-spike, breakout, cross-venue-arb,
  // category-specialist with fade_spike inner) will sign + post but get killed by
  // "no orders to match" because the visible book is thin. Tag strategies and
  // restrict auto-promote to the live-eligible set.
  //
  // Override via ARENA_AUTO_PROMOTE_LIVE_KINDS=kind1,kind2,... (defaults below).
  // Bug-fix 2026-05-27 (#23) — without this, auto-promote was burning capsule
  // capital on fade-spike agents that never filled.
  const liveEligibleKinds = (process.env.ARENA_AUTO_PROMOTE_LIVE_KINDS ?? "poly_short_binary_directional,llm_probability_oracle,polymarket_market_maker,cb_momentum_burst,cb_mean_reversion,cb_breakout").split(",").map((s) => s.trim());
  const qualifying = ranked
    .filter(({ agent }) => {
      if (agent.trades_count < minTrades) return false;
      if (agent.realized_pnl_usd <= 0) return false;
      // Inspect the agent's genome kind. multi_strategy is eligible iff it
      // contains at least one live-eligible sub-kind.
      let kind: string | null = null;
      try {
        const g = JSON.parse(agent.genome_json);
        kind = g.kind ?? null;
        if (kind === "multi_strategy") {
          const subs: Array<{ kind: string }> = g.params?.subs ?? [];
          if (subs.some((s) => liveEligibleKinds.includes(s.kind))) return true;
          return false;
        }
      } catch { return false; }
      return kind ? liveEligibleKinds.includes(kind) : false;
    })
    .slice(0, topN);

  // Phase 10 correlation-aware veto: for each qualifying elite, infer its
  // diversity profile from genome kind and check against EXISTING live
  // capsules' profiles. If a candidate would be structurally indistinguishable
  // from one already in play (same strategy_family AND asset_class), skip.
  //
  // For a new capsule with no PnL history, real pnl_corr is unknowable —
  // we use a structural proxy: same family + asset = high predicted correlation.
  // The candidate is allowed to STAY a paper capsule but won't go live.
  //
  // Skip the veto entirely when there are no existing live capsules (nothing
  // to correlate against) OR when a candidate's own existing capsule is being
  // rebalanced (it's already in the live mix; no new collision).
  const existingLiveProfiles = db().prepare(
    `SELECT id, paper_agent_id, strategy_family, asset_class
       FROM capsules
      WHERE status = 'live' AND name LIKE 'auto-live-%' AND paper_agent_id IS NOT NULL`,
  ).all() as Array<{ id: string; paper_agent_id: number; strategy_family: string | null; asset_class: string | null }>;

  const correlationVetoed: Array<{ agent_id: number; agent_name: string; reason: string }> = [];
  const correlationFiltered = qualifying.filter(({ agent }) => {
    // Don't veto agents who already have a live capsule (just rebalance).
    if (existingLiveProfiles.some((p) => p.paper_agent_id === agent.id)) return true;
    // Infer the candidate's profile.
    let kind: string | null = null;
    try {
      kind = JSON.parse(agent.genome_json).kind ?? null;
    } catch { /* keep null → fallback profile */ }
    const candidateProfile = inferDiversityProfile(kind);
    if (!candidateProfile.strategy_family) return true; // unknown — let it through

    // Check structural collision against existing live capsules belonging
    // to OTHER agents.
    const collision = existingLiveProfiles.find(
      (p) =>
        p.paper_agent_id !== agent.id &&
        p.strategy_family === candidateProfile.strategy_family &&
        p.asset_class === candidateProfile.asset_class,
    );
    if (collision) {
      const reason = `same diversity profile (family=${candidateProfile.strategy_family}, asset=${candidateProfile.asset_class}) as existing live capsule ${collision.id.slice(0, 8)} — would not add diversification`;
      correlationVetoed.push({ agent_id: agent.id, agent_name: agent.name, reason });
      insertEvolutionEvent({
        event_type: "capsule-auto-promote-vetoed",
        summary: `Auto-promote vetoed elite ${agent.name} (#${agent.id}) — ${reason}`,
        payload_json: JSON.stringify({
          agent_id: agent.id, agent_name: agent.name,
          candidate_profile: { strategy_family: candidateProfile.strategy_family, asset_class: candidateProfile.asset_class },
          collision_capsule_id: collision.id,
        }),
      });
      return false;
    }
    return true;
  });

  // Use the filtered list as the actual promotion set.
  const qualifyingIds = new Set(correlationFiltered.map((r) => r.agent.id));
  const perCapsule = correlationFiltered.length > 0 ? totalBudget / correlationFiltered.length : 0;

  // 2. Pause existing auto-live capsules whose agent fell out of the top-N.
  // CRITICAL: this runs BEFORE the "no qualifying" check so a sudden drop in
  // qualifying elites still demotes the prior auto-live capsules — we don't
  // want stale live capsules outliving their owner's elite status.
  // We identify "auto-managed" capsules by their name prefix `auto-live-`.
  // Manually-created capsules (named differently) are untouched.
  const existingAutoLive = db().prepare(
    `SELECT id, paper_agent_id, name, status FROM capsules
       WHERE status IN ('live','paper')
         AND name LIKE 'auto-live-%'
         AND paper_agent_id IS NOT NULL`,
  ).all() as Array<{ id: string; paper_agent_id: number; name: string; status: string }>;

  const paused: AutoPromoteResult["paused"] = [];
  for (const cap of existingAutoLive) {
    if (!qualifyingIds.has(cap.paper_agent_id)) {
      setStatus(cap.id, "paused");
      const reason = `agent ${cap.paper_agent_id} fell out of top-${topN} elites`;
      insertEvolutionEvent({
        event_type: "capsule-auto-paused",
        summary: `Capsule ${cap.id.slice(0, 8)}… paused — ${reason}`,
        payload_json: JSON.stringify({ capsule_id: cap.id, agent_id: cap.paper_agent_id, reason }),
      });
      paused.push({ agent_id: cap.paper_agent_id, capsule_id: cap.id, reason });
    }
  }

  // Now we can early-return if there's nothing to promote (capsules have
  // already been paused above).
  if (correlationFiltered.length === 0) {
    const reasonDetail = correlationVetoed.length > 0
      ? ` (${correlationVetoed.length} vetoed by correlation check)`
      : "";
    return {
      skipped: `no qualifying elites (need ≥${minTrades} trades + positive realized PnL)${reasonDetail}`,
      qualified_agents: qualifying.length,
      promoted: [],
      paused,
      total_budget_usd: totalBudget,
      per_capsule_usd: 0,
    };
  }

  // 3. For each qualifying agent: ensure they have an auto-live capsule with
  //    the correct capital. Create new or rebalance existing.
  const promoted: AutoPromoteResult["promoted"] = [];
  for (const { agent } of correlationFiltered) {
    const existing = db().prepare(
      `SELECT id, name, status, capital_allocated_usd FROM capsules
         WHERE paper_agent_id = ? AND status IN ('live','paper','paused')
           AND name LIKE 'auto-live-%'
         LIMIT 1`,
    ).get(agent.id) as { id: string; name: string; status: string; capital_allocated_usd: number } | undefined;

    if (existing) {
      // Rebalance + reactivate if paused. Don't touch deployed/realtime
      // counters; those get reconciled by the live-capsule path.
      const cur = getCapsule(existing.id);
      if (!cur) continue;
      const needsRebalance = Math.abs(cur.capital_allocated_usd - perCapsule) > 0.01;
      const needsReactivate = cur.status !== "live";
      if (needsRebalance || needsReactivate) {
        db().prepare(
          `UPDATE capsules
              SET capital_allocated_usd = ?,
                  capital_available_usd = ?,
                  max_daily_loss_usd = ?,
                  max_total_drawdown_usd = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(perCapsule, perCapsule, budget.perCapsule.daily_loss_cap_usd, budget.perCapsule.total_dd_cap_usd, existing.id);
        if (needsReactivate) setStatus(existing.id, "live");
        insertEvolutionEvent({
          event_type: "capsule-auto-rebalanced",
          summary: `Capsule ${existing.id.slice(0, 8)}… rebalanced to $${perCapsule.toFixed(2)} for agent ${agent.name}` + (needsReactivate ? " (reactivated)" : ""),
          payload_json: JSON.stringify({ capsule_id: existing.id, agent_id: agent.id, new_capital: perCapsule, reactivated: needsReactivate }),
        });
      }
      promoted.push({ agent_id: agent.id, agent_name: agent.name, capsule_id: existing.id, capital_usd: perCapsule });
      continue;
    }

    // No existing capsule — create one.
    const capsule = createCapsule({
      name: `auto-live-${agent.name}`,
      capitalUsd: perCapsule,
      allowedVenues: ["polymarket"],
      maxDailyLossUsd: budget.perCapsule.daily_loss_cap_usd,
      maxTotalDrawdownUsd: budget.perCapsule.total_dd_cap_usd,
      maxOpenPositions: 3,
      maxTradesPerDay: budget.perCapsule.max_trades_per_day,
    });
    db().prepare(`UPDATE capsules SET paper_agent_id = ? WHERE id = ?`).run(agent.id, capsule.id);
    setStatus(capsule.id, "live");
    insertEvolutionEvent({
      event_type: "capsule-auto-promoted",
      summary: `Auto-promoted elite ${agent.name} (#${agent.id}) → $${perCapsule.toFixed(2)} live capsule ${capsule.id.slice(0, 8)}…`,
      payload_json: JSON.stringify({
        capsule_id: capsule.id, agent_id: agent.id, agent_name: agent.name,
        capital_usd: perCapsule,
        trades_count: agent.trades_count, realized_pnl_usd: agent.realized_pnl_usd,
      }),
    });
    promoted.push({ agent_id: agent.id, agent_name: agent.name, capsule_id: capsule.id, capital_usd: perCapsule });
  }

  return {
    qualified_agents: qualifying.length,
    promoted, paused,
    total_budget_usd: totalBudget,
    per_capsule_usd: perCapsule,
  };
}

function emptyResult(extra: Partial<AutoPromoteResult>): AutoPromoteResult {
  return {
    qualified_agents: 0,
    promoted: [],
    paused: [],
    total_budget_usd: 0,
    per_capsule_usd: 0,
    ...extra,
  };
}

/**
 * Test-only: drop all auto-live capsules. Used by integration tests to reset
 * between cases.
 */
export function _resetAutoLiveCapsules(): void {
  db().prepare(`DELETE FROM capsules WHERE name LIKE 'auto-live-%'`).run();
}
