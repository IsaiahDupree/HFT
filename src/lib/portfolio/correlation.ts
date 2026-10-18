/**
 * Capsule pair correlation — pure math module.
 *
 * Takes two capsules' daily-PnL time series + asset/family metadata and
 * returns a CorrelationReport with:
 *   - pnl_corr        Pearson r over the overlapping date range
 *   - asset_overlap   Jaccard of allowed_assets sets
 *   - loss_overlap    fraction of days where BOTH had negative PnL
 *   - drawdown_overlap (v1 = loss_overlap; v2 will use intra-day DD timing)
 *   - verdict         "diversified" | "correlated_safe" | "too_similar"
 *
 * Pure / deterministic / no I/O. The worker (scripts/worker-portfolio-snapshot.ts)
 * is the only consumer that reads from / writes to the DB; this module just
 * does the math.
 *
 * Edge cases (all return null or 0 cleanly):
 *   - empty series                → pnl_corr=null, loss_overlap=0
 *   - mismatched lengths          → align by index up to min(len), no NaNs introduced
 *   - zero variance on either side → pnl_corr=null (division by zero avoided)
 *   - non-finite values in series → filtered out before computing
 *
 * Thresholds for verdict are operator-tunable via env at the worker, not here —
 * this module just computes the statistics.
 *
 * See PRD: docs/prd/capsule-portfolio-governance-2026-05-27.md §4.2
 */

export type DailyPnlPoint = {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Daily PnL in USD. NaN/Infinity filtered out by computePairStats. */
  pnl: number;
};

export type CorrelationReport = {
  capsule_a: string;
  capsule_b: string;
  /** Pearson correlation of daily PnL over overlapping date range. Null when undefined (zero variance / no overlap). */
  pnl_corr: number | null;
  /** Jaccard |A∩B| / |A∪B| of allowed-assets sets. 0..1. */
  asset_overlap: number;
  /** 1 if both capsules share the same strategy_family, else 0. */
  strategy_family_match: 0 | 1;
  /** Fraction of overlapping days where both PnLs were negative. 0..1. */
  loss_overlap: number;
  /** v1 = loss_overlap. v2 will use intraday drawdown timing. */
  drawdown_overlap: number;
  /** Number of overlapping daily points used in the calculation. */
  sample_days: number;
  /** Operator-readable bucket per verdict thresholds. */
  verdict: CorrelationVerdict;
  /** True when sample_days < min_confident_samples. Governor ignores low_confidence rows. */
  low_confidence: boolean;
};

export type CorrelationVerdict = "diversified" | "correlated_safe" | "too_similar";

export type VerdictThresholds = {
  /** pnl_corr above this contributes to "too_similar". */
  pnlCorrTooSimilar: number;
  /** asset_overlap above this contributes to "too_similar". */
  assetOverlapTooSimilar: number;
  /** Sample-day floor below which the report is marked low_confidence. */
  minConfidentSamples: number;
};

export const DEFAULT_THRESHOLDS: VerdictThresholds = {
  pnlCorrTooSimilar: 0.55,
  assetOverlapTooSimilar: 0.70,
  minConfidentSamples: 7,
};

// ─── Pure statistical primitives ───────────────────────────────────────────

/**
 * Pearson product-moment correlation. Returns null on:
 *   - length < 2
 *   - all values equal on either side (zero variance)
 *   - any non-finite values after the (pre-filtered) input
 *
 * Callers are expected to pre-filter NaN/Infinity. The null return is the
 * signal "correlation is undefined" — callers should treat it as missing
 * data, not as 0.
 */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let sumProd = 0, sumSqA = 0, sumSqB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    sumProd += da * db;
    sumSqA += da * da;
    sumSqB += db * db;
  }
  if (sumSqA === 0 || sumSqB === 0) return null;
  const denom = Math.sqrt(sumSqA * sumSqB);
  if (denom === 0) return null;
  const r = sumProd / denom;
  if (!Number.isFinite(r)) return null;
  // Floating-point can produce |r| slightly > 1; clamp for safety.
  return Math.max(-1, Math.min(1, r));
}

/**
 * Jaccard similarity |A ∩ B| / |A ∪ B|. Returns 0 for two empty sets (no
 * overlap to report, not perfect overlap — the empty-empty case is treated
 * as "no information", consistent with how the governor would interpret a
 * null-assets capsule).
 */
export function jaccard<T>(a: ReadonlySet<T> | readonly T[], b: ReadonlySet<T> | readonly T[]): number {
  const A = a instanceof Set ? a : new Set(a as readonly T[]);
  const B = b instanceof Set ? b : new Set(b as readonly T[]);
  if (A.size === 0 && B.size === 0) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = A.size + B.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Fraction of overlapping days where BOTH series had negative PnL.
 * Returns 0 if either series is empty or no overlap.
 */
export function jointLossFraction(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let joint = 0;
  for (let i = 0; i < n; i++) {
    if (a[i]! < 0 && b[i]! < 0) joint++;
  }
  return joint / n;
}

// ─── Date alignment ─────────────────────────────────────────────────────────

/**
 * Align two daily-PnL series on shared dates (inner join). Returns parallel
 * arrays for the dates both capsules have. Filters out non-finite PnL values.
 * Preserves chronological order (assumes inputs are sorted by date ASC).
 */
export function alignSeries(
  seriesA: readonly DailyPnlPoint[],
  seriesB: readonly DailyPnlPoint[],
): { dates: string[]; a: number[]; b: number[] } {
  const mapB = new Map<string, number>();
  for (const p of seriesB) {
    if (Number.isFinite(p.pnl)) mapB.set(p.date, p.pnl);
  }
  const dates: string[] = [];
  const a: number[] = [];
  const b: number[] = [];
  for (const p of seriesA) {
    if (!Number.isFinite(p.pnl)) continue;
    const bp = mapB.get(p.date);
    if (bp === undefined) continue;
    dates.push(p.date);
    a.push(p.pnl);
    b.push(bp);
  }
  return { dates, a, b };
}

// ─── Verdict classification ─────────────────────────────────────────────────

export function classifyVerdict(
  pnlCorr: number | null,
  assetOverlap: number,
  thresholds: VerdictThresholds = DEFAULT_THRESHOLDS,
): CorrelationVerdict {
  // Null pnl_corr is treated as inconclusive — fall back to asset overlap.
  const pnlAbove = pnlCorr !== null && pnlCorr > thresholds.pnlCorrTooSimilar;
  const assetAbove = assetOverlap > thresholds.assetOverlapTooSimilar;
  if (pnlAbove && assetAbove) return "too_similar";
  if (pnlAbove || assetAbove) return "correlated_safe";
  return "diversified";
}

// ─── Composite pair-stats computation ───────────────────────────────────────

export type PairInputs = {
  capsule_a: string;
  capsule_b: string;
  seriesA: readonly DailyPnlPoint[];
  seriesB: readonly DailyPnlPoint[];
  allowedAssetsA: readonly string[];
  allowedAssetsB: readonly string[];
  strategyFamilyA: string | null;
  strategyFamilyB: string | null;
};

export function computePairStats(
  inputs: PairInputs,
  thresholds: VerdictThresholds = DEFAULT_THRESHOLDS,
): CorrelationReport {
  const aligned = alignSeries(inputs.seriesA, inputs.seriesB);
  const pnl_corr = pearson(aligned.a, aligned.b);
  const asset_overlap = jaccard(inputs.allowedAssetsA, inputs.allowedAssetsB);
  const loss_overlap = jointLossFraction(aligned.a, aligned.b);
  const strategy_family_match: 0 | 1 =
    inputs.strategyFamilyA != null &&
    inputs.strategyFamilyA === inputs.strategyFamilyB
      ? 1
      : 0;
  const sample_days = aligned.a.length;
  const verdict = classifyVerdict(pnl_corr, asset_overlap, thresholds);
  const low_confidence = sample_days < thresholds.minConfidentSamples;

  return {
    capsule_a: inputs.capsule_a,
    capsule_b: inputs.capsule_b,
    pnl_corr,
    asset_overlap,
    strategy_family_match,
    loss_overlap,
    drawdown_overlap: loss_overlap, // v1: identical to loss_overlap
    sample_days,
    verdict,
    low_confidence,
  };
}
