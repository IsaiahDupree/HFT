import { describe, it, expect } from "vitest";
import { trainMetaLabel, metaLabelProb, kellySize, featurize, buildVocab, featureRowFromResult, metaLabelSizeFactor, applyMetaLabel } from "@/lib/decision/meta-label";
import type { LabeledDecision } from "@/lib/decision/calibration";
import type { DecisionResult } from "@/lib/decision/types";

function makeRows(): LabeledDecision[] {
  // separable: winners have high gate scores in 'trending'; losers low in 'chop'.
  const rows: LabeledDecision[] = [];
  for (let i = 0; i < 60; i++) {
    const win = i % 2 === 0;
    rows.push({
      id: i, approval_score: win ? 0.88 : 0.32, decision: "APPROVED_FULL", won: win,
      gateScores: { edge: win ? 0.9 : 0.3, signal_agreement: win ? 0.85 : 0.35, regime: win ? 0.9 : 0.4 },
      regime: win ? "trending" : "chop", realizedPnl: win ? 2 : -2,
    });
  }
  return rows;
}

describe("meta-label — featurize", () => {
  it("fixed-order vector: bias + gate scores + regime one-hot + approval", () => {
    const vocab = { gates: ["edge", "regime"], regimes: ["chop", "trending"] };
    const f = featurize({ gateScores: { edge: 0.8, regime: 0.6 }, approval_score: 0.7, regime: "trending" }, vocab);
    expect(f[0]).toBe(1);                 // bias
    expect(f.slice(1, 3)).toEqual([0.8, 0.6]); // gate scores
    expect(f.slice(3, 5)).toEqual([0, 1]);     // regime one-hot (chop=0, trending=1)
    expect(f[5]).toBe(0.7);               // approval
  });
});

describe("meta-label — trainMetaLabel / metaLabelProb", () => {
  it("learns P(win): high-score/trending → >0.5, low-score/chop → <0.5", () => {
    const m = trainMetaLabel(makeRows(), { iters: 1200 });
    expect(m.n).toBe(60);
    const pWin = metaLabelProb({ approval_score: 0.88, gateScores: { edge: 0.9, signal_agreement: 0.85, regime: 0.9 }, regime: "trending" }, m);
    const pLose = metaLabelProb({ approval_score: 0.32, gateScores: { edge: 0.3, signal_agreement: 0.35, regime: 0.4 }, regime: "chop" }, m);
    expect(pWin).toBeGreaterThan(0.5);
    expect(pLose).toBeLessThan(0.5);
    expect(pWin).toBeGreaterThan(pLose + 0.3); // clearly separated
  });

  it("empty / featureless input → n=0, neutral", () => {
    const m = trainMetaLabel([{ id: 1, approval_score: 0.5, decision: "X", won: true }]);
    expect(m.n).toBe(0); // no gateScores → not trainable
  });
});

describe("meta-label — kellySize", () => {
  it("monotonic in p and clamped to [0,1]", () => {
    expect(kellySize(0.5)).toBeCloseTo(0, 6);          // p=0.5, b=1 → 0
    expect(kellySize(0.8)).toBeGreaterThan(kellySize(0.6));
    expect(kellySize(0.2)).toBe(0);                    // negative edge → clamped 0
    expect(kellySize(0.99)).toBeLessThanOrEqual(1);
  });
});

describe("meta-label — serving (featureRowFromResult / sizeFactor / applyMetaLabel)", () => {
  const baseResult = (over: Partial<DecisionResult> = {}): DecisionResult => ({
    decision: "APPROVED_FULL", approval_score: 0.85, size_multiplier: 1, decision_ts: "t",
    gate_results: [
      { gate: "edge", status: "pass", score: 0.9, action: "CONTINUE", reason: "" },
      { gate: "regime", status: "pass", score: 0.8, action: "CONTINUE", reason: "", details: { regime: "trending" } },
      { gate: "meta_label", status: "pass", score: 0.5, action: "CONTINUE", reason: "" }, // must be IGNORED (no leakage)
    ],
    ...over,
  });

  it("featureRowFromResult mirrors the loader extraction and drops the synthetic meta_label gate", () => {
    const fr = featureRowFromResult(baseResult());
    expect(fr.gateScores).toEqual({ edge: 0.9, regime: 0.8 }); // meta_label excluded
    expect(fr.regime).toBe("trending");
    expect(fr.approval_score).toBe(0.85);
  });

  it("metaLabelSizeFactor: trim-only — 1 above pUpper, floor below pLower, monotonic, never >1", () => {
    expect(metaLabelSizeFactor(0.9)).toBe(1);
    expect(metaLabelSizeFactor(0.3)).toBe(0.25);                       // floor
    expect(metaLabelSizeFactor(0.525)).toBeCloseTo(0.625, 6);         // midpoint of [0.45,0.60]→[0.25,1]
    expect(metaLabelSizeFactor(0.58)).toBeGreaterThan(metaLabelSizeFactor(0.50));
    expect(metaLabelSizeFactor(0.999)).toBeLessThanOrEqual(1);
  });

  it("applyMetaLabel trims a low-confidence APPROVED_FULL but never resurrects a 0-size decision", () => {
    const model = trainMetaLabel(makeRows(), { iters: 1200 });
    // a losing-looking feature set → low P(win) → factor < 1 → size trimmed below the bucket's 1.0
    const losing = baseResult({
      approval_score: 0.32,
      gate_results: [
        { gate: "edge", status: "pass", score: 0.3, action: "CONTINUE", reason: "" },
        { gate: "signal_agreement", status: "pass", score: 0.35, action: "CONTINUE", reason: "" },
        { gate: "regime", status: "pass", score: 0.4, action: "CONTINUE", reason: "", details: { regime: "chop" } },
      ],
    });
    const trimmed = applyMetaLabel(losing, { model });
    expect(trimmed.size_multiplier).toBeLessThan(1);
    expect(trimmed.size_multiplier).toBeGreaterThanOrEqual(0.25);     // floored, not zeroed
    expect(trimmed.meta_pwin).toBeLessThan(0.5);
    expect(trimmed.meta_size_factor).toBe(trimmed.size_multiplier);   // bucket size was 1.0

    // a REJECTED (size 0) decision is never resurrected
    const rejected = applyMetaLabel(baseResult({ decision: "REJECTED", size_multiplier: 0 }), { model });
    expect(rejected.size_multiplier).toBe(0);
    expect(rejected.meta_pwin).toBeUndefined();
  });
});
