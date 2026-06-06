import { describe, it, expect } from "vitest";
import { kellyFraction, suggestSize, formatRecommendation, carryRecommendation, type TradeRecommendation } from "@/lib/decision/recommendation";

describe("kellyFraction — binary prediction-market bet", () => {
  it("is positive when estimate beats the price, zero when it doesn't", () => {
    expect(kellyFraction(0.7, 0.5)).toBeGreaterThan(0);   // we think 70%, priced 50% → bet
    expect(kellyFraction(0.5, 0.5)).toBeCloseTo(0, 6);     // no edge
    expect(kellyFraction(0.4, 0.5)).toBe(0);               // we think it loses → no bet (clamped ≥0)
  });
  it("known value: est 0.6 at price 0.5 → Kelly 0.2", () => {
    // b=1, f=(1·0.6 − 0.4)/1 = 0.2
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 6);
  });
  it("guards degenerate prices", () => {
    expect(kellyFraction(0.6, 0)).toBe(0);
    expect(kellyFraction(0.6, 1)).toBe(0);
  });
});

describe("suggestSize — fractional-Kelly, confidence-scaled, capped, ruin-averse", () => {
  it("scales with Kelly fraction × confidence × quarter-Kelly, on bankroll", () => {
    // f=0.2, conf=1, quarter-Kelly → 0.05 of bankroll = $500 of $10k
    expect(suggestSize(0.2, 1, { bankrollUsd: 10_000 })).toBe(500);
  });
  it("never exceeds the per-name cap (5% default) even at huge Kelly", () => {
    expect(suggestSize(5, 1, { bankrollUsd: 10_000 })).toBe(500); // capped at 5%
  });
  it("low confidence shrinks the size", () => {
    expect(suggestSize(0.2, 0.25, { bankrollUsd: 10_000 })).toBeLessThan(suggestSize(0.2, 1, { bankrollUsd: 10_000 }));
  });
  it("returns 0 below the min ticket (don't deploy dust)", () => {
    expect(suggestSize(0.001, 0.1, { bankrollUsd: 1_000, minTicketUsd: 20 })).toBe(0);
  });
});

describe("carryRecommendation — affirmative DEPLOY/WATCH/STAND_ASIDE", () => {
  it("DEPLOY a fat, executable, persistent carry with a real size", () => {
    const r = carryRecommendation({ instrument: "HYPE-USD", netApr: 24, grossApr: 27, executable: true, persistence: 0.95, depthUsd: 300_000, bankrollUsd: 10_000 });
    expect(r.finalAction).toBe("DEPLOY");
    expect(r.suggestedSizeUsd).toBeGreaterThan(0);
    expect(r.edgePct).toBe(24);
  });
  it("WATCH a fat-but-not-executable signal (gross ≥13%, blocked)", () => {
    const r = carryRecommendation({ instrument: "STABLE-USD", netApr: 0, grossApr: 41, executable: false, persistence: 0.65, bankrollUsd: 10_000 });
    expect(r.finalAction).toBe("WATCH");
    expect(r.suggestedSizeUsd).toBe(0);
  });
  it("STAND_ASIDE a thin carry (the +11% floor)", () => {
    const r = carryRecommendation({ instrument: "ETH-USD", netApr: 8, grossApr: 11, executable: false, persistence: 0.85, bankrollUsd: 10_000 });
    expect(r.finalAction).toBe("STAND_ASIDE");
  });
});

describe("formatRecommendation — policy decision format", () => {
  it("prints every mandated field incl. final action", () => {
    const r: TradeRecommendation = { market: "BTC-25SEP26", impliedProb: null, estimatedProb: null, edgePct: 12.5, confidence: 0.8, liquidityUsd: 300_000, suggestedSizeUsd: 400, reasoning: "basis carry", tailRisk: "basis widens", copySignal: null, finalAction: "DEPLOY" };
    const s = formatRecommendation(r);
    for (const f of ["Market:", "Implied probability:", "Estimated probability:", "Edge:", "Confidence:", "Liquidity:", "Suggested size:", "Reasoning:", "What could make this wrong:", "Copy-trade signal:", "Final action: DEPLOY"]) expect(s).toContain(f);
  });
});
