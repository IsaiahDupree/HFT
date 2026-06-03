/**
 * Meta-labeler (López de Prado) — the "trust THIS signal now?" secondary model.
 *
 * The primary models are the existing strategies/gates (they decide DIRECTION).
 * This secondary model, GIVEN a primary signal fired, predicts P(this trade wins)
 * from the journaled features — and thus how big to size it. It NEVER flips
 * direction. It replaces the signal-agreement gate's hand-coded cluster-count
 * score with a LEARNED, calibrated probability trained on the (strategy × regime ×
 * gate-scores → won) ledger that calibration-loader.ts already assembles, and the
 * reliability diagram already grades.
 *
 * Pure L2 logistic regression (gradient descent) — interpretable + auditable like
 * the gate rationale strings, and robust on the small N we have (vs a GBM that
 * would overfit). No DB/IO.
 */
import { metaFeatureScoreForGate, type LabeledDecision } from "./calibration";
import type { DecisionResult, GateResult } from "./types";

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export type Vocab = { gates: string[]; regimes: string[] };
export type MetaModel = { weights: number[]; featureNames: string[]; vocab: Vocab; n: number };
export type FeatureRow = { gateScores?: Record<string, number>; regime?: string };

export function buildVocab(rows: LabeledDecision[]): Vocab {
  const gates = new Set<string>(), regimes = new Set<string>();
  for (const r of rows) { for (const g of Object.keys(r.gateScores ?? {})) gates.add(g); if (r.regime) regimes.add(r.regime); }
  return { gates: [...gates].sort(), regimes: [...regimes].sort() };
}

/** Fixed-order feature vector: [bias, ...gate scores, ...regime one-hot].
 *  approval_score is deliberately NOT a feature: it is a weighted aggregate of these
 *  same gate scores and, once the learned regime-fit table is armed, it absorbs the
 *  learned regime win-rate — a back-door label leak. The individual gate scores carry
 *  the signal without it. */
export function featurize(d: FeatureRow, vocab: Vocab): number[] {
  const f = [1];                                                  // bias
  for (const g of vocab.gates) f.push(d.gateScores?.[g] ?? 0.5);  // gate score (neutral default)
  for (const rg of vocab.regimes) f.push(d.regime === rg ? 1 : 0); // regime one-hot
  return f;
}
export function featureNames(vocab: Vocab): string[] {
  return ["bias", ...vocab.gates.map((g) => `gate:${g}`), ...vocab.regimes.map((r) => `regime:${r}`)];
}

/** Train P(win | features) via L2 logistic regression. */
export function trainMetaLabel(rows: LabeledDecision[], opts: { iters?: number; lr?: number; l2?: number; vocab?: Vocab } = {}): MetaModel {
  const labeled = rows.filter((r) => r.gateScores);
  const vocab = opts.vocab ?? buildVocab(labeled);
  const X = labeled.map((r) => featurize(r, vocab));
  const y = labeled.map((r) => (r.won ? 1 : 0));
  const dim = X[0]?.length ?? 1;
  const w = new Array(dim).fill(0);
  if (X.length === 0) return { weights: w, featureNames: featureNames(vocab), vocab, n: 0 };
  const iters = opts.iters ?? 800, lr = opts.lr ?? 0.3, l2 = opts.l2 ?? 0.01;
  for (let it = 0; it < iters; it++) {
    const grad = new Array(dim).fill(0);
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(X[i].reduce((s, xj, j) => s + xj * w[j], 0));
      const err = p - y[i];
      for (let j = 0; j < dim; j++) grad[j] += err * X[i][j];
    }
    for (let j = 0; j < dim; j++) w[j] -= lr * (grad[j] / X.length + (j === 0 ? 0 : l2 * w[j])); // don't regularize the bias
  }
  return { weights: w, featureNames: featureNames(vocab), vocab, n: labeled.length };
}

/** Predict P(win) for a (gate-scores, regime) feature row. Throws on a feature/weight
 *  dimension mismatch (a stale-layout model) rather than silently padding with `?? 0` —
 *  the caller (applyMetaLabel) catches this and declines to size, so a bad model can
 *  never mis-map weights onto the wrong features and trim a real order by a bogus P(win). */
export function metaLabelProb(d: FeatureRow, model: MetaModel): number {
  const x = featurize(d, model.vocab);
  if (x.length !== model.weights.length) {
    throw new Error(`meta-label dimension mismatch: features=${x.length} weights=${model.weights.length}`);
  }
  return sigmoid(x.reduce((s, xj, j) => s + xj * model.weights[j], 0));
}

/** Kelly fraction for a binary edge: f* = p − (1−p)/b. Clamped to [0,1]. The
 *  meta-prob drives the size_multiplier — bigger when the model is confident. */
export function kellySize(pWin: number, payoffRatio = 1, fraction = 1): number {
  return Math.max(0, Math.min(1, fraction * (pWin - (1 - pWin) / payoffRatio)));
}

// ─── SERVING: apply the trained meta-labeler to a live decision ────────────

/**
 * Shared gate→feature extraction used IDENTICALLY by training (calibration-loader)
 * and serving (featureRowFromResult), so the two can never drift. (1) Drops the
 * synthetic `meta_label` gate — it must never be a feature (it is the meta-labeler's
 * own output → self-leakage). (2) Applies the regime leakage guard via
 * metaFeatureScoreForGate, which substitutes the STATIC regime score for the LEARNED
 * one (the learned score is a smoothed win-rate → target leakage).
 */
export function extractGateFeatures(
  gates: ReadonlyArray<{ gate?: string; score?: number; details?: Record<string, unknown> }>,
): FeatureRow {
  const gateScores: Record<string, number> = {};
  let regime: string | undefined;
  for (const g of gates) {
    if (g.gate === "meta_label") continue;                          // never a feature (self-leakage)
    if (g.gate && typeof g.score === "number") gateScores[g.gate] = metaFeatureScoreForGate(g.gate, g.score, g.details);
    if (g.gate === "regime") { const r = g.details?.regime; if (typeof r === "string") regime = r; }
  }
  return { gateScores, regime };
}

/**
 * Build the meta-label feature row from a FINALIZED decision — train/serve parity via
 * the shared `extractGateFeatures` (so the served features match the trained ones).
 */
export function featureRowFromResult(
  result: { gate_results: ReadonlyArray<Pick<GateResult, "gate" | "score" | "details">> },
): FeatureRow {
  return extractGateFeatures(result.gate_results);
}

export type MetaLabelSizing = {
  model: MetaModel;
  /** Size-factor floor — meta can trim a confident-bucket size down to this × the
   *  bucket size, never below. Default 0.25. */
  floor?: number;
  /** P(win) at/above which the bucket size is kept in full (factor 1). Default 0.60. */
  pUpper?: number;
  /** P(win) at/below which the factor hits the floor. Default 0.45. */
  pLower?: number;
};

/** TRIM-ONLY size factor from P(win): 1 at/above pUpper, floor at/below pLower,
 *  linear between. Always ∈ [floor, 1] — the bucket is the cap; the learned P(win)
 *  only trims low-confidence approvals. Never > 1 (no up-sizing past the bucket). */
export function metaLabelSizeFactor(
  pWin: number,
  opts: { floor?: number; pUpper?: number; pLower?: number } = {},
): number {
  const floor = opts.floor ?? 0.25, pUpper = opts.pUpper ?? 0.60, pLower = opts.pLower ?? 0.45;
  if (pWin >= pUpper) return 1;
  if (pWin <= pLower) return floor;
  return floor + ((pWin - pLower) / (pUpper - pLower)) * (1 - floor);
}

/**
 * Apply the meta-labeler to a finalized decision: predict P(win) from its gate
 * features and TRIM the size_multiplier by the resulting factor. Meta-labeling
 * sizes only — it NEVER flips direction and NEVER resurrects a 0-size decision
 * (REJECTED/WATCHLIST/KILL keep size 0). Records meta_pwin + meta_size_factor.
 */
export function applyMetaLabel(result: DecisionResult, sizing: MetaLabelSizing): DecisionResult {
  if (result.size_multiplier <= 0 || sizing.model.n <= 0) return result; // nothing to size / no model
  const fr = featureRowFromResult(result);
  // FAIL-SAFE on out-of-distribution serve features: the model is trained on rows with a
  // CLASSIFIED regime; a serve point whose regime is unclassifiable ('unknown') or was
  // never in the training vocabulary is OOD, so its P(win) can't be trusted to size real
  // money. Decline to size (all upstream gates still apply). This keeps the live path —
  // which serves regime='unknown' until live-capsule feeds a real snapshot — safely
  // un-sized rather than trimmed by an arbitrary, OOD probability.
  if (!fr.regime || fr.regime === "unknown" || !sizing.model.vocab.regimes.includes(fr.regime)) return result;
  let pWin: number;
  try {
    pWin = metaLabelProb(fr, sizing.model);
  } catch {
    return result; // dimension mismatch / stale model → no sizing (gates still applied upstream)
  }
  const factor = metaLabelSizeFactor(pWin, sizing);
  return { ...result, size_multiplier: result.size_multiplier * factor, meta_pwin: pWin, meta_size_factor: factor };
}
