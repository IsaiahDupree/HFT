/**
 * Persistence for the trained meta-labeler. Kept OUT of meta-label.ts so that
 * module stays pure (no fs/IO) and unit-testable. `train-meta-label.ts` saves the
 * full-sample model here; the live path (`live-capsule.ts`, gated by
 * META_LABEL_SIZING=1) loads it once and injects it into the decision pipeline.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { featureNames, type MetaModel } from "./meta-label";

export const META_MODEL_PATH = "data/meta-label-model.json";

type StoredModel = MetaModel & { savedAt?: string };

export function saveMetaModel(model: MetaModel, path = META_MODEL_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredModel = { ...model, savedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

/** Load the persisted model, or null if absent/malformed. Never throws — a missing
 *  or corrupt model file simply disables meta-label sizing (fail-safe). */
export function loadMetaModel(path = META_MODEL_PATH): MetaModel | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as StoredModel;
    if (!Array.isArray(m.weights) || !Array.isArray(m.featureNames) || !m.vocab || typeof m.n !== "number") return null;
    if (!Array.isArray(m.vocab.gates) || !Array.isArray(m.vocab.regimes)) return null;
    // Layout self-consistency (fail-safe): the stored weights/featureNames MUST match the
    // feature layout the live extractor produces for this vocab. A truncated write, or a
    // model trained under an older featurize() ordering, otherwise loads and silently
    // mis-sizes real-money orders. Reject → meta-label sizing stays disabled.
    const expected = featureNames(m.vocab);
    if (m.weights.length !== expected.length) return null;
    if (m.featureNames.length !== expected.length || m.featureNames.some((nm, i) => nm !== expected[i])) return null;
    return { weights: m.weights, featureNames: m.featureNames, vocab: m.vocab, n: m.n };
  } catch {
    return null;
  }
}
