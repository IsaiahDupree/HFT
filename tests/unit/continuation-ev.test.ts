import { describe, it, expect } from "vitest";
import { continuationEv, continuationRecommendation, formatContinuation } from "@/lib/decision/continuation-ev";

describe("continuationEv — the policy's exact formulas", () => {
  it("entry 0.6 → target 0.9, stop 0.5, q 0.7: R/L=3, break-even 25%, EV +0.18, ROI +30%", () => {
    const e = continuationEv({ entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.7 });
    expect(e.reward).toBeCloseTo(0.3, 6);
    expect(e.loss).toBeCloseTo(0.1, 6);
    expect(e.rewardToLoss).toBeCloseTo(3, 6);
    expect(e.breakEvenQ).toBeCloseTo(0.25, 6);            // loss/(reward+loss)
    expect(e.evContinuation).toBeCloseTo(0.18, 6);        // 0.7·0.3 − 0.3·0.1
    expect(e.evRoi).toBeCloseTo(0.3, 6);                  // 0.18/0.6
    expect(e.edgeQ).toBeCloseTo(0.45, 6);                 // 0.70 − 0.25
  });
  it("costs reduce EV; q below break-even → negative EV (don't ride a stall)", () => {
    expect(continuationEv({ entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.7, costs: 0.05 }).evContinuation).toBeCloseTo(0.13, 6);
    const bad = continuationEv({ entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.2 }); // 20% < 25% break-even
    expect(bad.edgeQ).toBeLessThan(0);
    expect(bad.evContinuation).toBeLessThan(0);
  });
});

describe("continuationRecommendation — affirmative buy/wait/skip", () => {
  it("BUY a strong continuation with room to target and q above break-even", () => {
    const r = continuationRecommendation({ market: "btc-up-hourly", entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.75, bankrollUsd: 10_000, liquidityUsd: 50_000 });
    expect(r.finalAction).toBe("DEPLOY");
    expect(r.suggestedSizeUsd).toBeGreaterThan(0);
    expect(r.evRoi).toBeGreaterThan(0.05);
    expect(r.breakEvenQ).toBeCloseTo(0.25, 6);
  });
  it("STAND_ASIDE when q is below break-even (negative EV)", () => {
    const r = continuationRecommendation({ market: "m", entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.2, bankrollUsd: 10_000 });
    expect(r.finalAction).toBe("STAND_ASIDE");
    expect(r.suggestedSizeUsd).toBe(0);
  });
  it("WATCH when EV is positive but the edge margin is too thin to deploy", () => {
    // q just above break-even → positive EV but small edgeQ < minEdgeQ
    const r = continuationRecommendation({ market: "m", entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.27, bankrollUsd: 10_000, minEdgeQ: 0.05 });
    expect(r.evRoi).toBeGreaterThan(0);
    expect(r.finalAction).toBe("WATCH");
  });
});

describe("formatContinuation — the policy's continuation decision format", () => {
  it("prints all continuation fields + a buy/wait/skip action", () => {
    const r = continuationRecommendation({ market: "btc-up-hourly", entry: 0.6, target: 0.9, stop: 0.5, qContinue: 0.75, bankrollUsd: 10_000, liquidityUsd: 50_000 });
    const s = formatContinuation(r);
    for (const f of ["Market:", "Side:", "Entry price:", "Target exit", "Stop/failure exit:", "Continuation probability:", "Reward-to-loss ratio:", "Break-even continuation probability:", "EV_continuation:", "EV_ROI:", "Final action: buy"]) expect(s).toContain(f);
  });
});
