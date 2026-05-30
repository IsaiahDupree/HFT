/**
 * Approval-score arithmetic for the decision pipeline.
 *
 * Per PRD §2:
 *   score = Σ (weight_i × gate_score_i)   over gates that appear in the
 *           weight map. Weights sum to 1.0 (DEFAULT_GATE_WEIGHTS invariant).
 *
 * Bucketing:
 *   score > 0.80          → APPROVED_FULL     (size_multiplier = 1.0)
 *   0.65 < score ≤ 0.80   → APPROVED_REDUCED  (size_multiplier ∈ [0.5, 0.9])
 *   0.50 < score ≤ 0.65   → WATCHLIST         (size_multiplier = 0)
 *   score ≤ 0.50          → REJECTED          (size_multiplier = 0)
 *
 * Hard overrides (regardless of score):
 *   - Any gate emitting action='KILL_SWITCH' → decision='KILL_SWITCH', size=0
 *   - Any gate emitting action='REJECT'      → decision='REJECTED',    size=0
 *
 * APPROVED_REDUCED size mapping: linearly maps score band [0.65, 0.80] →
 * [0.5, 0.9] so a borderline-pass gets half size and a near-full-pass gets
 * nearly full size.
 *
 * Pure / deterministic. No I/O.
 */
import {
  DEFAULT_GATE_WEIGHTS,
  type Decision,
  type DecisionResult,
  type GateResult,
  type GateWeights,
} from "./types";

export function weightedScore(
  gateResults: readonly GateResult[],
  weights: GateWeights = DEFAULT_GATE_WEIGHTS,
): number {
  let sum = 0;
  let totalWeight = 0;
  for (const r of gateResults) {
    const w = weights[r.gate];
    if (w === undefined || w <= 0) continue;
    sum += w * r.score;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  // Normalize by present weights so missing gates don't drag the score to 0.
  // (If only 4 of 7 gates fire and they all passed, score = 1 not 4/7.)
  return Math.max(0, Math.min(1, sum / totalWeight));
}

/**
 * Bucket the score + gate outputs into a Decision. Hard rejects (REJECT
 * action on any gate) and kill switches always win regardless of score.
 */
export function bucketDecision(
  approvalScore: number,
  gateResults: readonly GateResult[],
): { decision: Decision; size_multiplier: number } {
  for (const r of gateResults) {
    if (r.action === "KILL_SWITCH") {
      return { decision: "KILL_SWITCH", size_multiplier: 0 };
    }
  }
  for (const r of gateResults) {
    if (r.action === "REJECT") {
      return { decision: "REJECTED", size_multiplier: 0 };
    }
  }
  if (approvalScore > 0.80) return { decision: "APPROVED_FULL", size_multiplier: 1.0 };
  if (approvalScore > 0.65) {
    // Linear map [0.65, 0.80] → [0.5, 0.9]
    const t = (approvalScore - 0.65) / 0.15;
    const size = 0.5 + t * (0.9 - 0.5);
    return { decision: "APPROVED_REDUCED", size_multiplier: Math.max(0.5, Math.min(0.9, size)) };
  }
  if (approvalScore > 0.50) return { decision: "WATCHLIST", size_multiplier: 0 };
  return { decision: "REJECTED", size_multiplier: 0 };
}

/** Convenience: build the final DecisionResult from gate outputs + timestamp. */
export function finalizeDecision(
  gateResults: readonly GateResult[],
  weights: GateWeights = DEFAULT_GATE_WEIGHTS,
  decision_ts: string = new Date().toISOString(),
): DecisionResult {
  const approval_score = weightedScore(gateResults, weights);
  const { decision, size_multiplier } = bucketDecision(approval_score, gateResults);
  return {
    decision,
    approval_score,
    size_multiplier,
    gate_results: [...gateResults],
    decision_ts,
  };
}
