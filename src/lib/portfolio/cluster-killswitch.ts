/**
 * Cluster kill switches (Phase 8 of capsule-portfolio-governance PRD §4.4).
 *
 * Pure module — takes a snapshot of live capsules + the operator's
 * thresholds and returns a `ClusterDecision[]` indicating which capsules
 * should be paused (or which entire portfolio should go risk-off / kill).
 *
 * The four-tier ladder:
 *
 *   1. Individual capsule daily-loss cap   → already enforced by capsules/gate.ts
 *   2. Strategy-family cluster daily loss  → THIS module → pause cluster
 *   3. Asset-class cluster daily loss      → THIS module → pause cluster
 *   4. Global PnL daily loss (risk-off)    → THIS module → reduce all sizes to 25%
 *   5. Global PnL daily loss (kill switch) → THIS module → halt everything
 *
 * Why "cluster" matters: today's failure mode is N capsules in the same
 * strategy_family each losing 1× their cap, summing to a much larger
 * portfolio loss than any individual cap would suggest. Per-capsule gates
 * fire independently and ignore each other; cluster gates aggregate.
 *
 * The thresholds are expressed as percentages of TOTAL ACTIVE CAPITAL
 * (sum of capital_allocated_usd across live + paper capsules). This means
 * a 4% strategy-family cluster cap on $30 total = $1.20 cluster threshold —
 * intentionally tighter than the sum of individual capsule caps.
 *
 * No I/O. Caller supplies snapshot + thresholds; this module computes
 * the decision; caller persists.
 */

export type ClusterInputCapsule = {
  id: string;
  name: string;
  status: string;                  // 'live' | 'paper' | etc.
  strategy_family: string | null;
  asset_class: string | null;
  capital_allocated_usd: number;
  daily_pnl_usd: number;           // current-day PnL (signed; negative = loss)
};

/** Action a single capsule should take. */
export type CapsuleAction = "none" | "pause" | "reduce_size";

/** Reason a capsule received an action — for evolution_log + UI tooltip. */
export type ClusterReason =
  | "individual"                   // per-capsule cap (not handled by this module; pass-through)
  | "strategy_family_cluster"      // sum of daily PnL for the family crossed threshold
  | "asset_class_cluster"          // sum of daily PnL for the asset class crossed threshold
  | "global_risk_off"              // global PnL crossed risk-off threshold → reduce all
  | "global_kill_switch";          // global PnL crossed kill threshold → pause all

export type ClusterDecision = {
  capsule_id: string;
  capsule_name: string;
  action: CapsuleAction;
  reason: ClusterReason | null;
  /** Human-readable summary for evolution_log + UI. */
  summary: string;
  /** When `action='reduce_size'`, the multiplier to apply (0..1). 1 when action='none' or 'pause'. */
  size_multiplier: number;
};

export type ClusterThresholds = {
  /** Strategy-family cluster pauses when its aggregate daily PnL ≤ -X% of total active capital. */
  strategyFamilyClusterPct: number;
  /** Same for asset_class. */
  assetClassClusterPct: number;
  /** Global daily PnL ≤ -X% of total active capital → reduce all sizes. */
  globalRiskOffPct: number;
  /** Global daily PnL ≤ -X% of total active capital → pause everything (sticky). */
  globalKillSwitchPct: number;
  /** Size multiplier when global_risk_off fires. Default 0.25. */
  riskOffSizeMultiplier: number;
};

export const DEFAULT_CLUSTER_THRESHOLDS: ClusterThresholds = {
  strategyFamilyClusterPct: 0.04,
  assetClassClusterPct: 0.06,
  globalRiskOffPct: 0.05,
  globalKillSwitchPct: 0.10,
  riskOffSizeMultiplier: 0.25,
};

/**
 * Read thresholds from env with documented defaults. Defensive against
 * malformed values — falls back to default rather than NaN.
 */
export function readThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): ClusterThresholds {
  return {
    strategyFamilyClusterPct: numFromEnv(env.CLUSTER_KILLSWITCH_STRATEGY_FAMILY_PCT, DEFAULT_CLUSTER_THRESHOLDS.strategyFamilyClusterPct),
    assetClassClusterPct: numFromEnv(env.CLUSTER_KILLSWITCH_ASSET_CLASS_PCT, DEFAULT_CLUSTER_THRESHOLDS.assetClassClusterPct),
    globalRiskOffPct: numFromEnv(env.GLOBAL_RISK_OFF_PCT, DEFAULT_CLUSTER_THRESHOLDS.globalRiskOffPct),
    globalKillSwitchPct: numFromEnv(env.GLOBAL_KILLSWITCH_PCT, DEFAULT_CLUSTER_THRESHOLDS.globalKillSwitchPct),
    riskOffSizeMultiplier: numFromEnv(env.GLOBAL_RISK_OFF_SIZE_MULTIPLIER, DEFAULT_CLUSTER_THRESHOLDS.riskOffSizeMultiplier),
  };
}

/**
 * Walk the capsule snapshot and emit one ClusterDecision per capsule.
 *
 * Decision precedence per capsule (most-severe-action wins):
 *   1. global_kill_switch        (pause everything)
 *   2. asset_class_cluster       (pause capsules in the tripped cluster)
 *   3. strategy_family_cluster   (pause capsules in the tripped cluster)
 *   4. global_risk_off           (reduce size on EVERYONE NOT already paused)
 *   5. none
 *
 * Pause beats reduce — even though global_risk_off is "broader", a cluster
 * trip is the more severe action for the capsules in that cluster. The
 * remaining capsules outside the cluster still get reduced sizing from the
 * global_risk_off layer. This is why precedence is checked PER CAPSULE
 * rather than globally.
 *
 * Caller persists by:
 *   - setting capsule.status='paused' for action='pause'
 *   - logging to evolution_log with event_type='cluster-killswitch-trip'
 *   - storing size_multiplier on the next decision-pipeline call (Phase 9 wiring)
 */
export function checkClusters(
  capsules: readonly ClusterInputCapsule[],
  thresholds: ClusterThresholds = DEFAULT_CLUSTER_THRESHOLDS,
): ClusterDecision[] {
  if (capsules.length === 0) return [];

  // Use ALL capsule capital (live + paper) as the denominator so a single
  // live capsule with a paper cluster around it still has a meaningful
  // percentage scale.
  const totalCapital = capsules.reduce((sum, c) => sum + (Number.isFinite(c.capital_allocated_usd) ? c.capital_allocated_usd : 0), 0);
  if (totalCapital <= 0) {
    // No allocated capital — nothing to govern. Return 'none' for each.
    return capsules.map((c) => ({
      capsule_id: c.id,
      capsule_name: c.name,
      action: "none",
      reason: null,
      summary: "no active capital",
      size_multiplier: 1,
    }));
  }

  // ── Tier 4 + 5: global ─────────────────────────────────────────────────
  const globalDailyPnl = capsules.reduce((s, c) => s + (Number.isFinite(c.daily_pnl_usd) ? c.daily_pnl_usd : 0), 0);
  const globalLossPct = -globalDailyPnl / totalCapital; // positive when losing
  const globalKill = globalLossPct >= thresholds.globalKillSwitchPct;
  const globalRiskOff = !globalKill && globalLossPct >= thresholds.globalRiskOffPct;

  // ── Tiers 2 + 3: cluster aggregation ───────────────────────────────────
  const familyAgg = new Map<string, number>();    // family → sum of daily PnL
  const assetClassAgg = new Map<string, number>();
  for (const c of capsules) {
    if (c.strategy_family) {
      familyAgg.set(c.strategy_family, (familyAgg.get(c.strategy_family) ?? 0) + (c.daily_pnl_usd || 0));
    }
    if (c.asset_class) {
      assetClassAgg.set(c.asset_class, (assetClassAgg.get(c.asset_class) ?? 0) + (c.daily_pnl_usd || 0));
    }
  }
  const trippedFamilies = new Set<string>();
  for (const [fam, pnl] of familyAgg.entries()) {
    if (-pnl / totalCapital >= thresholds.strategyFamilyClusterPct) trippedFamilies.add(fam);
  }
  const trippedAssetClasses = new Set<string>();
  for (const [ac, pnl] of assetClassAgg.entries()) {
    if (-pnl / totalCapital >= thresholds.assetClassClusterPct) trippedAssetClasses.add(ac);
  }

  // ── Emit per-capsule decisions ─────────────────────────────────────────
  return capsules.map((c) => {
    // 1. global_kill_switch — most severe, applies to every capsule
    if (globalKill) {
      return {
        capsule_id: c.id,
        capsule_name: c.name,
        action: "pause" as const,
        reason: "global_kill_switch" as const,
        summary: `global kill switch tripped: portfolio daily loss ${(globalLossPct * 100).toFixed(2)}% ≥ ${(thresholds.globalKillSwitchPct * 100).toFixed(2)}%`,
        size_multiplier: 0,
      };
    }
    // 2. asset_class_cluster — pause every capsule in the tripped cluster
    if (c.asset_class && trippedAssetClasses.has(c.asset_class)) {
      const clusterPnl = assetClassAgg.get(c.asset_class)!;
      return {
        capsule_id: c.id,
        capsule_name: c.name,
        action: "pause" as const,
        reason: "asset_class_cluster" as const,
        summary: `asset-class cluster '${c.asset_class}' tripped: aggregate daily loss $${(-clusterPnl).toFixed(2)} = ${(-clusterPnl / totalCapital * 100).toFixed(2)}% ≥ ${(thresholds.assetClassClusterPct * 100).toFixed(2)}%`,
        size_multiplier: 0,
      };
    }
    // 3. strategy_family_cluster — pause every capsule in the tripped cluster
    if (c.strategy_family && trippedFamilies.has(c.strategy_family)) {
      const clusterPnl = familyAgg.get(c.strategy_family)!;
      return {
        capsule_id: c.id,
        capsule_name: c.name,
        action: "pause" as const,
        reason: "strategy_family_cluster" as const,
        summary: `strategy-family cluster '${c.strategy_family}' tripped: aggregate daily loss $${(-clusterPnl).toFixed(2)} = ${(-clusterPnl / totalCapital * 100).toFixed(2)}% ≥ ${(thresholds.strategyFamilyClusterPct * 100).toFixed(2)}%`,
        size_multiplier: 0,
      };
    }
    // 4. global_risk_off — reduce sizing on capsules NOT already paused by cluster trips
    if (globalRiskOff) {
      return {
        capsule_id: c.id,
        capsule_name: c.name,
        action: "reduce_size" as const,
        reason: "global_risk_off" as const,
        summary: `global risk-off: portfolio daily loss ${(globalLossPct * 100).toFixed(2)}% ≥ ${(thresholds.globalRiskOffPct * 100).toFixed(2)}% → size × ${thresholds.riskOffSizeMultiplier}`,
        size_multiplier: thresholds.riskOffSizeMultiplier,
      };
    }
    // 5. within all thresholds
    return {
      capsule_id: c.id,
      capsule_name: c.name,
      action: "none" as const,
      reason: null,
      summary: "within all cluster thresholds",
      size_multiplier: 1,
    };
  });
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s*#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
