/**
 * Calibration tracker (Phase 13 of selective-micro-edges PRD).
 *
 * Measures the honesty of the decision pipeline's approval_score: when
 * the pipeline says "0.85 approval", do those trades actually win 85% of
 * the time? Without calibration, confidence is a vibe — with it, every
 * shadow-mode decision contributes evidence about the score's reliability.
 *
 * Pure math module. The caller (UI / API) supplies labeled rows
 * (decision row + outcome flag); this module buckets and computes stats.
 *
 * Bucketing scheme: approval_score in [0, 1], default bins 0.05 wide.
 * For each bin: count of decisions, count of "wins", win-rate, and the
 * calibration error = |actual_win_rate − bin_midpoint|.
 *
 * Outcome definitions:
 *   - For executed live orders: won = realized_pnl_usd > 0 (matched via order_id)
 *   - For executed paper-only (sim): won = same
 *   - For WATCHLIST / REJECTED decisions: outcome is "what would have happened"
 *     — only counted if the operator opts in (deferred to v2; for v1 we only
 *     calibrate against executed trades to avoid counterfactual-data error)
 *
 * Reliability diagram: each bucket has (expected_rate = bin_midpoint,
 * actual_rate = wins/n). A perfectly calibrated pipeline plots on the
 * y = x diagonal. Buckets above the line are under-confident; buckets
 * below are over-confident.
 */

export type LabeledDecision = {
  /** decision_journal.id */
  id: number;
  /** approval_score in [0, 1] */
  approval_score: number;
  /** decision_journal.decision enum */
  decision: string;
  /** True if the trade ultimately won (realized_pnl_usd > 0). */
  won: boolean;
  /** Optional metadata for filtered views. */
  strategy_kind?: string;
  capsule_id?: string;
  /** Classified market regime at decision time (parsed from gate_results_json) —
   *  the (strategy × regime) ledger key for the meta-labeler. */
  regime?: string;
  /** Per-gate scores at decision time (gate name → score) — the meta-labeler's features. */
  gateScores?: Record<string, number>;
  /** Net realized PnL of the round-trip (magnitude matters for meta-label sizing). */
  realizedPnl?: number;
};

/**
 * The meta-labeler feature value for a journaled gate. For the regime gate, prefer
 * the STATIC fit score (details.regime_fit_static) when build-6's learned regime-fit
 * override was applied — so the meta-labeler never trains on the LEARNED regime score
 * (which is itself a smoothed win-rate ⇒ target leakage). Build-6 records
 * regime_fit_static in the regime gate details whenever it overrides; absent ⇒ use
 * the gate's own score. Used identically by the train loader and the serve extractor
 * to keep train/serve feature parity.
 */
export function metaFeatureScoreForGate(
  gate: string,
  score: number,
  details?: Record<string, unknown>,
): number {
  if (gate === "regime" && details && typeof details.regime_fit_static === "number") {
    return details.regime_fit_static;
  }
  return score;
}

export type CalibrationBucket = {
  /** Inclusive lower bound. */
  lo: number;
  /** Exclusive upper bound (or inclusive when hi === 1.0). */
  hi: number;
  /** (lo + hi) / 2 — the expected win-rate per the pipeline's score. */
  midpoint: number;
  /** Number of decisions in this bucket. */
  n: number;
  /** Number of those that won. */
  wins: number;
  /** wins / n. Null when n === 0. */
  actual_win_rate: number | null;
  /** |actual − midpoint|. Null when n === 0. */
  calibration_error: number | null;
};

export type CalibrationReport = {
  buckets: CalibrationBucket[];
  /** Total decisions that fell into ANY bucket (i.e. had an outcome). */
  total_labeled: number;
  /** Mean of (|actual − expected| × bucket_share). 0 = perfectly calibrated. */
  weighted_calibration_error: number;
  /** True if there are any buckets where calibration_error > badThreshold. */
  has_problem_bucket: boolean;
};

export type CalibrationOptions = {
  /** Bucket width in [0, 1]. Default 0.10. */
  binWidth?: number;
  /** Bucket-level calibration-error threshold for `has_problem_bucket`. Default 0.10 (10pp). */
  badThreshold?: number;
};

/**
 * Build the calibration report from a list of labeled decisions.
 *
 * Default bins: [0, 0.1), [0.1, 0.2), ..., [0.9, 1.0]
 *
 * Decisions with approval_score outside [0, 1] are filtered out (defensive
 * — shouldn't occur if pipeline is healthy).
 */
export function buildCalibrationReport(
  decisions: readonly LabeledDecision[],
  opts: CalibrationOptions = {},
): CalibrationReport {
  const binWidth = opts.binWidth ?? 0.10;
  const badThreshold = opts.badThreshold ?? 0.10;
  if (binWidth <= 0 || binWidth > 1) {
    throw new Error(`binWidth must be in (0, 1], got ${binWidth}`);
  }

  const nBins = Math.ceil(1 / binWidth);
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < nBins; i++) {
    const lo = +(i * binWidth).toFixed(6);
    const hi = +Math.min(1.0, (i + 1) * binWidth).toFixed(6);
    buckets.push({
      lo,
      hi,
      midpoint: +((lo + hi) / 2).toFixed(6),
      n: 0,
      wins: 0,
      actual_win_rate: null,
      calibration_error: null,
    });
  }

  let totalLabeled = 0;
  for (const d of decisions) {
    if (!Number.isFinite(d.approval_score)) continue;
    if (d.approval_score < 0 || d.approval_score > 1) continue;
    // Locate bucket. Top edge (score = 1.0) belongs to the last bucket.
    let idx = Math.floor(d.approval_score / binWidth);
    if (idx >= buckets.length) idx = buckets.length - 1;
    const b = buckets[idx]!;
    b.n++;
    if (d.won) b.wins++;
    totalLabeled++;
  }

  // Fill in actual_win_rate + calibration_error per bucket.
  for (const b of buckets) {
    if (b.n === 0) continue;
    b.actual_win_rate = +(b.wins / b.n).toFixed(6);
    b.calibration_error = +Math.abs(b.actual_win_rate - b.midpoint).toFixed(6);
  }

  // Weighted average calibration error (each bucket weighted by its share of
  // total labeled decisions). Empty buckets contribute zero.
  let weighted = 0;
  let hasProblem = false;
  if (totalLabeled > 0) {
    for (const b of buckets) {
      if (b.n === 0 || b.calibration_error === null) continue;
      weighted += (b.n / totalLabeled) * b.calibration_error;
      if (b.calibration_error > badThreshold) hasProblem = true;
    }
  }

  return {
    buckets,
    total_labeled: totalLabeled,
    weighted_calibration_error: +weighted.toFixed(6),
    has_problem_bucket: hasProblem,
  };
}

/**
 * Convenience: classify a bucket's calibration as
 *   "well_calibrated"   — error within threshold
 *   "over_confident"    — actual win-rate well below midpoint (pipeline too sure)
 *   "under_confident"   — actual win-rate well above midpoint (pipeline too cautious)
 *   "insufficient_data" — n too low to draw conclusions
 */
export function bucketVerdict(
  b: CalibrationBucket,
  opts: { minN?: number; threshold?: number } = {},
): "well_calibrated" | "over_confident" | "under_confident" | "insufficient_data" {
  const minN = opts.minN ?? 5;
  const threshold = opts.threshold ?? 0.10;
  if (b.n < minN || b.actual_win_rate === null) return "insufficient_data";
  const diff = b.actual_win_rate - b.midpoint;
  if (Math.abs(diff) <= threshold) return "well_calibrated";
  return diff < 0 ? "over_confident" : "under_confident";
}
