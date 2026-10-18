/**
 * Capsule lifecycle (Phase 10 of capsule-portfolio-governance PRD §4.6).
 *
 * Extends the existing `paper | live | paused` ladder into the full sequence:
 *
 *   idea → backtest → paper → micro_live → probation_live → full_live
 *                                                              ↓
 *                                                          degraded
 *                                                              ↓
 *                                                           frozen
 *                                                              ↓
 *                                                           retired
 *
 * Promotion + demotion are pure functions over the capsule's state +
 * correlation snapshot. The arena tick + auto-promote modules call these
 * to decide whether to advance / retreat a capsule each seal.
 *
 * Decision rules:
 *
 *   PROMOTE one stage requires:
 *     - ≥ MIN_TRADES at the current stage
 *     - positive expectancy (current_pnl_usd > 0 OR trades_count < threshold yet)
 *     - max pnl_corr with any existing same-or-later-stage capsule ≤ MAX_CORR_PROMOTE
 *     - max drawdown within the stage's tolerance
 *
 *   DEMOTE requires (any one):
 *     - drawdown breach
 *     - loss_overlap > MAX_LOSS_OVERLAP sustained over recent window
 *     - correlation rise above ceiling
 *     - sustained worsening of slippage / fills (deferred — v2)
 *
 * Pure module — caller supplies snapshots; this returns the recommended
 * action; arena code persists.
 */

export type LifecycleStage =
  | "idea"
  | "backtest"
  | "paper"
  | "micro_live"
  | "probation_live"
  | "full_live"
  | "degraded"
  | "frozen"
  | "retired"
  | "reserve"        // special: see Phase 11 reserve capsule
  // Legacy synonyms preserved for back-compat with existing rows:
  | "draft"
  | "live"           // → treated as full_live
  | "paused"
  | "stopped"
  | "closed";

const STAGE_ORDER: LifecycleStage[] = [
  "idea",
  "backtest",
  "paper",
  "micro_live",
  "probation_live",
  "full_live",
];

/** Maps legacy status values to the new lifecycle ladder. */
export function normalizeStage(s: string | null | undefined): LifecycleStage {
  if (!s) return "idea";
  if (s === "live") return "full_live";
  if (s === "draft") return "idea";
  return s as LifecycleStage;
}

/** True if the capsule is in any "active trading" state (vs paused/frozen/retired). */
export function isActiveStage(s: LifecycleStage): boolean {
  return s === "paper" || s === "micro_live" || s === "probation_live" || s === "full_live" || s === "degraded";
}

export type LifecycleThresholds = {
  /** Min trades at current stage before eligible for promotion. */
  minTradesMicro: number;
  /** Min trades at micro_live before eligible for probation_live. */
  minTradesProbation: number;
  /** Min trades at probation_live before eligible for full_live. */
  minTradesFullLive: number;
  /** Max pnl_corr with any existing same-or-later-stage capsule that allows promotion. */
  maxCorrPromote: number;
  /** Demote to 'degraded' if sustained loss_overlap exceeds this. */
  lossOverlapDemote: number;
  /** Demote to 'frozen' if drawdown crosses this fraction of capital. */
  maxDrawdownPct: number;
};

export const DEFAULT_LIFECYCLE_THRESHOLDS: LifecycleThresholds = {
  minTradesMicro: 5,
  minTradesProbation: 20,
  minTradesFullLive: 50,
  maxCorrPromote: 0.55,
  lossOverlapDemote: 0.70,
  maxDrawdownPct: 0.50,
};

export function readLifecycleThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): LifecycleThresholds {
  return {
    minTradesMicro: numFromEnv(env.LIFECYCLE_MIN_TRADES_MICRO, DEFAULT_LIFECYCLE_THRESHOLDS.minTradesMicro),
    minTradesProbation: numFromEnv(env.LIFECYCLE_MIN_TRADES_PROBATION, DEFAULT_LIFECYCLE_THRESHOLDS.minTradesProbation),
    minTradesFullLive: numFromEnv(env.LIFECYCLE_MIN_TRADES_FULL_LIVE, DEFAULT_LIFECYCLE_THRESHOLDS.minTradesFullLive),
    maxCorrPromote: numFromEnv(env.LIFECYCLE_MAX_CORR_PROMOTE, DEFAULT_LIFECYCLE_THRESHOLDS.maxCorrPromote),
    lossOverlapDemote: numFromEnv(env.LIFECYCLE_LOSS_OVERLAP_DEMOTE, DEFAULT_LIFECYCLE_THRESHOLDS.lossOverlapDemote),
    maxDrawdownPct: numFromEnv(env.LIFECYCLE_MAX_DRAWDOWN_PCT, DEFAULT_LIFECYCLE_THRESHOLDS.maxDrawdownPct),
  };
}

export type LifecycleAction = "promote" | "demote" | "freeze" | "hold";

export type LifecycleCapsule = {
  id: string;
  stage: LifecycleStage;
  capital_allocated_usd: number;
  current_pnl_usd: number;
  trades_count: number;
  /** Loss-overlap score over recent window. 0..1. Null if unknown. */
  loss_overlap?: number | null;
  /** Max pnl_corr with any other same-or-later-stage capsule. Null if no snapshot yet. */
  max_pair_corr?: number | null;
  /** Drawdown as fraction of capital_allocated_usd. */
  drawdown_pct?: number;
};

export type LifecycleDecision = {
  capsule_id: string;
  current_stage: LifecycleStage;
  action: LifecycleAction;
  next_stage: LifecycleStage | null;
  reason: string;
  details?: Record<string, unknown>;
};

/** Next stage in the promotion ladder, or null if already at top / not in ladder. */
function nextStage(stage: LifecycleStage): LifecycleStage | null {
  const i = STAGE_ORDER.indexOf(stage);
  if (i < 0 || i === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1] ?? null;
}

/** Min trades required to advance from `stage` to next. */
function minTradesForPromotion(
  stage: LifecycleStage,
  thresholds: LifecycleThresholds,
): number {
  if (stage === "paper") return thresholds.minTradesMicro;
  if (stage === "micro_live") return thresholds.minTradesProbation;
  if (stage === "probation_live") return thresholds.minTradesFullLive;
  return Number.POSITIVE_INFINITY;
}

/**
 * Decide what should happen to a capsule given its current snapshot.
 * Order of precedence (most severe first):
 *   1. Drawdown breach → freeze
 *   2. Sustained loss_overlap above threshold → demote (full_live → degraded)
 *   3. Correlation high vs existing peers → block promotion (hold)
 *   4. Eligible for promotion → promote
 *   5. Otherwise → hold
 */
export function decideLifecycleAction(
  capsule: LifecycleCapsule,
  thresholds: LifecycleThresholds = DEFAULT_LIFECYCLE_THRESHOLDS,
): LifecycleDecision {
  const stage = normalizeStage(capsule.stage);

  // 1. Drawdown breach overrides everything → freeze.
  if (
    capsule.drawdown_pct !== undefined &&
    Number.isFinite(capsule.drawdown_pct) &&
    capsule.drawdown_pct >= thresholds.maxDrawdownPct &&
    isActiveStage(stage)
  ) {
    return {
      capsule_id: capsule.id,
      current_stage: stage,
      action: "freeze",
      next_stage: "frozen",
      reason: `drawdown ${(capsule.drawdown_pct * 100).toFixed(1)}% ≥ cap ${(thresholds.maxDrawdownPct * 100).toFixed(0)}%`,
      details: { drawdown_pct: capsule.drawdown_pct },
    };
  }

  // 2. Sustained loss_overlap above threshold → demote (only if we're at full_live).
  if (
    stage === "full_live" &&
    capsule.loss_overlap !== null &&
    capsule.loss_overlap !== undefined &&
    capsule.loss_overlap > thresholds.lossOverlapDemote
  ) {
    return {
      capsule_id: capsule.id,
      current_stage: stage,
      action: "demote",
      next_stage: "degraded",
      reason: `loss_overlap ${(capsule.loss_overlap * 100).toFixed(0)}% > threshold ${(thresholds.lossOverlapDemote * 100).toFixed(0)}% — not adding diversification`,
      details: { loss_overlap: capsule.loss_overlap },
    };
  }

  // 3. Eligible for promotion check.
  const next = nextStage(stage);
  if (next) {
    const minTrades = minTradesForPromotion(stage, thresholds);
    if (capsule.trades_count >= minTrades) {
      // Correlation veto — block promotion if too similar to existing peers.
      if (
        capsule.max_pair_corr !== null &&
        capsule.max_pair_corr !== undefined &&
        capsule.max_pair_corr > thresholds.maxCorrPromote
      ) {
        return {
          capsule_id: capsule.id,
          current_stage: stage,
          action: "hold",
          next_stage: null,
          reason: `eligible for ${next} (${capsule.trades_count} ≥ ${minTrades} trades) but max pair-corr ${capsule.max_pair_corr.toFixed(2)} > ${thresholds.maxCorrPromote} — too similar to existing peers`,
          details: { max_pair_corr: capsule.max_pair_corr, threshold: thresholds.maxCorrPromote },
        };
      }
      // Expectancy check — for promotions beyond micro_live we want non-negative PnL.
      if ((stage === "micro_live" || stage === "probation_live") && capsule.current_pnl_usd < 0) {
        return {
          capsule_id: capsule.id,
          current_stage: stage,
          action: "hold",
          next_stage: null,
          reason: `eligible for ${next} but PnL $${capsule.current_pnl_usd.toFixed(2)} < 0 — needs positive expectancy first`,
          details: { current_pnl_usd: capsule.current_pnl_usd },
        };
      }
      return {
        capsule_id: capsule.id,
        current_stage: stage,
        action: "promote",
        next_stage: next,
        reason: `eligible for ${next}: ${capsule.trades_count} trades${capsule.max_pair_corr !== null && capsule.max_pair_corr !== undefined ? `, max-corr ${capsule.max_pair_corr.toFixed(2)}` : ""}, pnl $${capsule.current_pnl_usd.toFixed(2)}`,
      };
    }
  }

  // 4. No action — capsule holds its current stage.
  return {
    capsule_id: capsule.id,
    current_stage: stage,
    action: "hold",
    next_stage: null,
    reason: next
      ? `${capsule.trades_count} trades < ${minTradesForPromotion(stage, thresholds)} needed for ${next}`
      : "at top of ladder or in terminal stage",
  };
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s*#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
