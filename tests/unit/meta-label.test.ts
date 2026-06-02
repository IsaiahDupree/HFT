import { describe, it, expect } from "vitest";
import { trainMetaLabel, metaLabelProb, kellySize, featurize, buildVocab } from "@/lib/decision/meta-label";
import type { LabeledDecision } from "@/lib/decision/calibration";

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
