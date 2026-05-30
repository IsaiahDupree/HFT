/**
 * Signal-agreement gate (Phase 14 of selective-micro-edges PRD).
 *
 * Implements the operator's principle: "5 agents looking at the same
 * Markov signal are not 5 independent signals. They're one signal
 * wearing five costumes."
 *
 * The gate slot `signal_agreement` exists in DEFAULT_GATE_WEIGHTS (weight
 * 0.15) since Phase 2 but no gate was emitting it. This module fills the
 * slot. Strategies attach signals to proposal.metadata.signals[] BEFORE
 * the pipeline runs; this gate aggregates them by INFORMATION CLUSTER
 * (not raw count) and emits a score.
 *
 * Cluster taxonomy (must come from independent information sources):
 *
 *   price-action      Markov persistence, momentum, trend indicators
 *   volatility        ATR, sigma, breakout/chop classification
 *   microstructure    Order-book imbalance, depth, spread
 *   cross-venue       Coinbase/CEX vs Polymarket implied divergence
 *   smart-money       Cross-wallet consensus (clustered, not raw count)
 *   event             News / liquidation / on-chain flow spikes
 *   geometric         Distance-from-strike, time-in-window
 *
 * Decision math:
 *   - Count UNIQUE clusters that agreed with the proposal's direction
 *   - 5+ clusters → score 1.0, CONTINUE
 *   - 3-4 clusters → score 0.7, REDUCE_SIZE
 *   - 1-2 clusters → score 0.4, REDUCE_SIZE
 *   - 0 clusters OR a strong opposite cluster → action REJECT
 *
 * "Strong opposite cluster" = any signal in a DIFFERENT cluster pointing
 * the opposite direction with confidence ≥ rejectOnConflictConfidence.
 * This catches "5 weak agree votes vs 1 strong disagree" situations
 * where the contrarian signal should be respected.
 *
 * Pure module; no I/O.
 */
import { Gate, type DecisionContext, type GateResult } from "../types";

export type SignalCluster =
  | "price-action"
  | "volatility"
  | "microstructure"
  | "cross-venue"
  | "smart-money"
  | "event"
  | "geometric";

export type StrategySignal = {
  /** Where the signal comes from. Used for cluster aggregation. */
  cluster: SignalCluster;
  /** Direction the signal supports: matches proposal.side or opposes it. */
  direction: "BUY" | "SELL";
  /** 0..1 confidence. */
  confidence: number;
  /** Optional source identifier — strategy/agent name for debugging. */
  source?: string;
};

export type SignalAgreementOptions = {
  /** Confidence threshold for a "strong" opposite signal to trigger REJECT. Default 0.70. */
  rejectOnConflictConfidence?: number;
  /** Minimum confidence for a signal to count at all. Default 0.50. */
  minConfidence?: number;
};

export function signalAgreementGate(
  ctx: DecisionContext,
  opts: SignalAgreementOptions = {},
): GateResult {
  const rejectOnConflict = opts.rejectOnConflictConfidence ?? 0.70;
  const minConfidence = opts.minConfidence ?? 0.50;

  const rawSignals = ctx.proposal.metadata?.signals;
  if (!Array.isArray(rawSignals) || rawSignals.length === 0) {
    // No signals attached → strategy didn't quantify multi-source agreement.
    // Treat as neutral (score 0.7) rather than reject — the existing edge
    // gate already enforces single-signal viability.
    return Gate.pass("signal_agreement", 0.7, "no multi-source signals attached (neutral)");
  }

  // Validate + filter signals.
  const valid: StrategySignal[] = [];
  for (const s of rawSignals) {
    if (!s || typeof s !== "object") continue;
    const sig = s as StrategySignal;
    if (!sig.cluster || !sig.direction) continue;
    if (!Number.isFinite(sig.confidence)) continue;
    if (sig.confidence < minConfidence) continue;
    valid.push(sig);
  }
  if (valid.length === 0) {
    return Gate.pass(
      "signal_agreement",
      0.5,
      `${rawSignals.length} signals attached but none cleared minConfidence ${minConfidence}`,
      { rawCount: rawSignals.length, minConfidence },
    );
  }

  const proposalDirection = ctx.proposal.side;

  // Tally signals by cluster + direction. For each cluster, keep the
  // strongest pro-direction confidence + strongest anti-direction confidence.
  type ClusterTally = { pro: number; anti: number };
  const byCluster = new Map<SignalCluster, ClusterTally>();
  for (const sig of valid) {
    const tally = byCluster.get(sig.cluster) ?? { pro: 0, anti: 0 };
    if (sig.direction === proposalDirection) {
      tally.pro = Math.max(tally.pro, sig.confidence);
    } else {
      tally.anti = Math.max(tally.anti, sig.confidence);
    }
    byCluster.set(sig.cluster, tally);
  }

  // Determine each cluster's NET vote: 'pro', 'anti', or 'neutral' (mixed/tied).
  let proClusters = 0;
  let antiClusters = 0;
  let strongOpposite = 0;
  const breakdown: Record<string, { pro: number; anti: number; vote: string }> = {};
  for (const [cluster, tally] of byCluster.entries()) {
    let vote: "pro" | "anti" | "neutral";
    if (tally.pro > tally.anti + 0.05) {
      vote = "pro";
      proClusters++;
    } else if (tally.anti > tally.pro + 0.05) {
      vote = "anti";
      antiClusters++;
      if (tally.anti >= rejectOnConflict) strongOpposite++;
    } else {
      vote = "neutral";
    }
    breakdown[cluster] = { pro: tally.pro, anti: tally.anti, vote };
  }

  const details = {
    cluster_breakdown: breakdown,
    pro_clusters: proClusters,
    anti_clusters: antiClusters,
    strong_opposite: strongOpposite,
    signal_count: valid.length,
  };

  // Strong opposite cluster → REJECT regardless of pro count.
  if (strongOpposite > 0) {
    return Gate.reject(
      "signal_agreement",
      `${strongOpposite} cluster(s) signal STRONG opposite direction (conf ≥ ${rejectOnConflict}); proposal contradicted`,
      details,
    );
  }

  // 0 pro clusters → REJECT (no support).
  if (proClusters === 0) {
    return Gate.reject(
      "signal_agreement",
      "no cluster supports the proposal direction",
      details,
    );
  }

  // Score by cluster count.
  if (proClusters >= 5) {
    return Gate.pass(
      "signal_agreement",
      1.0,
      `${proClusters} independent clusters agree (full conviction)`,
      details,
    );
  }
  if (proClusters >= 3) {
    return Gate.reduce(
      "signal_agreement",
      0.7,
      `${proClusters} independent clusters agree (modest conviction)`,
      details,
    );
  }
  return Gate.reduce(
    "signal_agreement",
    0.4,
    `only ${proClusters} cluster supports — weak conviction, suggest size reduction`,
    details,
  );
}
