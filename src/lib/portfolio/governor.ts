/**
 * Global Risk Governor — portfolio-level veto layer above the per-trade
 * and per-capsule gates (Phase 9 of capsule-portfolio-governance PRD §4.5).
 *
 * Sits at the end of the decision pipeline and enforces:
 *
 *   1. Same-trade collision
 *        If N capsules each have an open or queued position on the same
 *        (asset, direction, time_horizon), treat them as one big trade
 *        and cap aggregate notional at MAX_TRADE_USD. Reject the proposal
 *        if it would push the cluster total above the cap.
 *
 *   2. Correlated-exposure cap
 *        Track total current exposure to (long crypto), (short crypto),
 *        (any prediction_market direction). Reject proposals that would
 *        push the aggregate above MAX_CORRELATED_EXPOSURE_PCT × total
 *        active capital.
 *
 *   3. Strategy-family cap
 *        Each family has a max % of total active capital it can control
 *        via its capsules' allocated capital. Reject capsule activations
 *        (and oversized proposals from existing capsules) that would
 *        exceed it.
 *
 *   4. Reserve floor
 *        Hard rule: any proposal where capsule.strategy_family='reserve'
 *        is immediately REJECTED, full stop. Reserve capital is un-
 *        deployable by design.
 *
 * Pure module — no DB. Caller supplies the portfolio snapshot + the
 * specific proposal under consideration; this module evaluates and
 * returns a structured GovernorResult.
 *
 * Threshold floors (hard-coded; cannot be zeroed out by env):
 *   - ARENA_RESERVE_PCT floored at 0.25 (PRD §4.7 — "reserve cannot be
 *     overridden to zero")
 */

export type GovernorAction = "approve" | "reject" | "cap_size";

export type GovernorReason =
  | "reserve_capsule"
  | "same_trade_collision"
  | "correlated_exposure_cap"
  | "strategy_family_cap"
  | "ok";

export type GovernorResult = {
  action: GovernorAction;
  reason: GovernorReason;
  /** Human-readable summary for the gate result + decision_journal. */
  summary: string;
  /** When action='cap_size', the maximum sizeUsd the proposal may take. */
  cap_size_usd?: number;
  /** Structured details for UI + downstream analysis. */
  details?: Record<string, unknown>;
};

export type GovernorThresholds = {
  /** Per-trade cap in USD. Default $5 (matches RISK_STAKE_USD). */
  maxTradeUsd: number;
  /** Total long/short crypto exposure cap as fraction of total active capital. Default 0.30. */
  maxCorrelatedExposurePct: number;
  /** Per-strategy-family allocation cap as fraction of total active capital. Default 0.25. */
  maxStrategyFamilyExposurePct: number;
  /** Untouchable reserve as fraction of total account. Default 0.50. Hard floor 0.25. */
  reservePct: number;
};

export const DEFAULT_GOVERNOR_THRESHOLDS: GovernorThresholds = {
  maxTradeUsd: 5,
  maxCorrelatedExposurePct: 0.30,
  maxStrategyFamilyExposurePct: 0.25,
  reservePct: 0.50,
};

/** Hard floor on reserve — operator cannot disable via env. */
export const RESERVE_PCT_HARD_FLOOR = 0.25;

export type CapsuleSnapshot = {
  id: string;
  status: string;
  strategy_family: string | null;
  asset_class: string | null;
  capital_allocated_usd: number;
};

/** A currently-open or queued position contributed by a capsule. */
export type PortfolioPosition = {
  capsule_id: string;
  asset_class: string | null;
  /** Free-form asset symbol — 'BTC', 'ETH', etc. */
  asset?: string;
  /** Trade direction. */
  side: "BUY" | "SELL";
  /** Notional USD. */
  size_usd: number;
  /** Optional time horizon for collision matching ("5m" / "15m" / etc.) */
  time_horizon?: string;
};

export type GovernorProposal = {
  /** Capsule attempting the trade. */
  capsule_id: string;
  strategy_family: string | null;
  asset_class: string | null;
  asset?: string;
  side: "BUY" | "SELL";
  size_usd: number;
  time_horizon?: string;
};

export type GovernorInputs = {
  proposal: GovernorProposal;
  capsules: readonly CapsuleSnapshot[];
  /** All currently-open positions across the portfolio (for collision + exposure math). */
  openPositions: readonly PortfolioPosition[];
  thresholds: GovernorThresholds;
};

export function readGovernorThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): GovernorThresholds {
  const reservePct = numFromEnv(env.ARENA_RESERVE_PCT, DEFAULT_GOVERNOR_THRESHOLDS.reservePct);
  return {
    maxTradeUsd: numFromEnv(env.MAX_TRADE_USD ?? env.RISK_STAKE_USD, DEFAULT_GOVERNOR_THRESHOLDS.maxTradeUsd),
    maxCorrelatedExposurePct: numFromEnv(env.MAX_CORRELATED_EXPOSURE_PCT, DEFAULT_GOVERNOR_THRESHOLDS.maxCorrelatedExposurePct),
    maxStrategyFamilyExposurePct: numFromEnv(env.MAX_STRATEGY_FAMILY_EXPOSURE_PCT, DEFAULT_GOVERNOR_THRESHOLDS.maxStrategyFamilyExposurePct),
    // Floor at hard minimum regardless of env value
    reservePct: Math.max(RESERVE_PCT_HARD_FLOOR, reservePct),
  };
}

/**
 * Main entrypoint. Returns the governor's decision on a proposed trade.
 * Precedence (most severe wins):
 *   1. reserve_capsule  (reject — reserve cannot trade)
 *   2. same_trade_collision (reject or cap)
 *   3. correlated_exposure_cap (reject or cap)
 *   4. strategy_family_cap (reject or cap)
 *   5. ok
 */
export function checkPortfolioImpact(inputs: GovernorInputs): GovernorResult {
  const { proposal, capsules, openPositions, thresholds } = inputs;

  // 1. Reserve capsule veto — hard rule, no override.
  if (proposal.strategy_family === "reserve") {
    return {
      action: "reject",
      reason: "reserve_capsule",
      summary: "reserve capsule cannot place trades — capital is by design un-deployable",
    };
  }

  // Find the proposing capsule in the snapshot to verify it exists.
  const proposingCapsule = capsules.find((c) => c.id === proposal.capsule_id);
  // (If the proposing capsule is itself in 'reserve' status / family, the
  //  per-capsule risk gates would already block. We re-check via proposal
  //  metadata above so the governor is defensible even when called with a
  //  bad context.)

  // Compute total active capital (excluding reserve capsules).
  const activeCapital = capsules
    .filter((c) => c.strategy_family !== "reserve" && c.status !== "paused" && c.status !== "stopped" && c.status !== "closed")
    .reduce((sum, c) => sum + (Number.isFinite(c.capital_allocated_usd) ? c.capital_allocated_usd : 0), 0);

  if (activeCapital <= 0) {
    // No active capital → nothing to govern. Pass through.
    return {
      action: "approve",
      reason: "ok",
      summary: "no active capital — governor passes through",
    };
  }

  // 2. Same-trade collision — other capsules already in (asset, side, time_horizon).
  if (proposal.asset) {
    const collision = openPositions.filter(
      (p) =>
        p.capsule_id !== proposal.capsule_id &&
        p.asset === proposal.asset &&
        p.side === proposal.side &&
        (!proposal.time_horizon || !p.time_horizon || p.time_horizon === proposal.time_horizon),
    );
    if (collision.length > 0) {
      const existingNotional = collision.reduce((s, p) => s + p.size_usd, 0);
      const totalIfApproved = existingNotional + proposal.size_usd;
      if (totalIfApproved > thresholds.maxTradeUsd) {
        // Cap the proposal to whatever headroom remains under the single-trade cap.
        const headroom = Math.max(0, thresholds.maxTradeUsd - existingNotional);
        if (headroom < 0.01) {
          return {
            action: "reject",
            reason: "same_trade_collision",
            summary: `${collision.length} capsule(s) already on ${proposal.asset} ${proposal.side} totaling $${existingNotional.toFixed(2)} (= single-trade cap $${thresholds.maxTradeUsd}); no headroom`,
            details: { existingNotional, collisionCount: collision.length, headroom },
          };
        }
        return {
          action: "cap_size",
          reason: "same_trade_collision",
          summary: `${collision.length} capsule(s) already on ${proposal.asset} ${proposal.side} totaling $${existingNotional.toFixed(2)}; cap proposal to $${headroom.toFixed(2)} (single-trade cap $${thresholds.maxTradeUsd})`,
          cap_size_usd: headroom,
          details: { existingNotional, collisionCount: collision.length, headroom },
        };
      }
    }
  }

  // 3. Correlated-exposure cap — total long/short exposure across capsules in the same asset_class.
  if (proposal.asset_class) {
    const sameClassSameSide = openPositions.filter(
      (p) => p.asset_class === proposal.asset_class && p.side === proposal.side,
    );
    const currentExposure = sameClassSameSide.reduce((s, p) => s + p.size_usd, 0);
    const maxExposure = thresholds.maxCorrelatedExposurePct * activeCapital;
    if (currentExposure + proposal.size_usd > maxExposure) {
      const headroom = Math.max(0, maxExposure - currentExposure);
      if (headroom < 0.01) {
        return {
          action: "reject",
          reason: "correlated_exposure_cap",
          summary: `${proposal.asset_class} ${proposal.side} exposure already $${currentExposure.toFixed(2)} = ${(currentExposure / activeCapital * 100).toFixed(1)}% of $${activeCapital.toFixed(2)} active capital (cap ${(thresholds.maxCorrelatedExposurePct * 100).toFixed(0)}%); no headroom`,
          details: { currentExposure, maxExposure, headroom },
        };
      }
      return {
        action: "cap_size",
        reason: "correlated_exposure_cap",
        summary: `${proposal.asset_class} ${proposal.side} exposure $${currentExposure.toFixed(2)} approaching cap; reduce proposal to $${headroom.toFixed(2)}`,
        cap_size_usd: headroom,
        details: { currentExposure, maxExposure, headroom },
      };
    }
  }

  // 4. Strategy-family allocation cap — measured by capital_allocated, not
  // open positions. Caps the BREADTH of capital a single family controls.
  //
  // Only fires when the active portfolio has ≥2 distinct strategy families.
  // A single-family portfolio is by definition 100% concentrated in that
  // family — the rule is meaningless in that case, and firing it would
  // block every proposal forever.
  if (proposal.strategy_family) {
    const activeCapsules = capsules.filter(
      (c) => c.strategy_family !== "reserve" && c.status !== "paused" && c.status !== "stopped" && c.status !== "closed",
    );
    const distinctFamilies = new Set(activeCapsules.map((c) => c.strategy_family ?? "unknown"));
    if (distinctFamilies.size >= 2) {
      const familyCapital = activeCapsules
        .filter((c) => c.strategy_family === proposal.strategy_family)
        .reduce((s, c) => s + (Number.isFinite(c.capital_allocated_usd) ? c.capital_allocated_usd : 0), 0);
      const maxFamilyCapital = thresholds.maxStrategyFamilyExposurePct * activeCapital;
      if (familyCapital > maxFamilyCapital + 0.01) {
        return {
          action: "reject",
          reason: "strategy_family_cap",
          summary: `family '${proposal.strategy_family}' controls $${familyCapital.toFixed(2)} = ${(familyCapital / activeCapital * 100).toFixed(1)}% of active capital (cap ${(thresholds.maxStrategyFamilyExposurePct * 100).toFixed(0)}%) — over-concentrated; reject until paused / reallocated`,
          details: { familyCapital, maxFamilyCapital, activeCapital, distinctFamilies: distinctFamilies.size },
        };
      }
    }
  }

  return {
    action: "approve",
    reason: "ok",
    summary: "all portfolio-level checks passed",
    details: { activeCapital },
  };
  void proposingCapsule; // referenced for future capsule-level checks
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s*#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
