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
import type { LabeledDecision } from "./calibration";

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export type Vocab = { gates: string[]; regimes: string[] };
export type MetaModel = { weights: number[]; featureNames: string[]; vocab: Vocab; n: number };
export type FeatureRow = { gateScores?: Record<string, number>; approval_score: number; regime?: string };

export function buildVocab(rows: LabeledDecision[]): Vocab {
  const gates = new Set<string>(), regimes = new Set<string>();
  for (const r of rows) { for (const g of Object.keys(r.gateScores ?? {})) gates.add(g); if (r.regime) regimes.add(r.regime); }
  return { gates: [...gates].sort(), regimes: [...regimes].sort() };
}

/** Fixed-order feature vector: [bias, ...gate scores, ...regime one-hot, approval_score]. */
export function featurize(d: FeatureRow, vocab: Vocab): number[] {
  const f = [1];                                                  // bias
  for (const g of vocab.gates) f.push(d.gateScores?.[g] ?? 0.5);  // gate score (neutral default)
  for (const rg of vocab.regimes) f.push(d.regime === rg ? 1 : 0); // regime one-hot
  f.push(d.approval_score ?? 0.5);
  return f;
}
export function featureNames(vocab: Vocab): string[] {
  return ["bias", ...vocab.gates.map((g) => `gate:${g}`), ...vocab.regimes.map((r) => `regime:${r}`), "approval_score"];
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

/** Predict P(win) for a (gate-scores, regime, approval) feature row. */
export function metaLabelProb(d: FeatureRow, model: MetaModel): number {
  const x = featurize(d, model.vocab);
  return sigmoid(x.reduce((s, xj, j) => s + xj * (model.weights[j] ?? 0), 0));
}

/** Kelly fraction for a binary edge: f* = p − (1−p)/b. Clamped to [0,1]. The
 *  meta-prob drives the size_multiplier — bigger when the model is confident. */
export function kellySize(pWin: number, payoffRatio = 1, fraction = 1): number {
  return Math.max(0, Math.min(1, fraction * (pWin - (1 - pWin) / payoffRatio)));
}
