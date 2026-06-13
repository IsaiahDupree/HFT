/**
 * Tests for the fill_risk microstructure model — a direct port of TradingBot2
 * research/lastminute/rails/fill_risk.py. Checks the directional weighting,
 * proximity decay, level thresholds, the widen/pull ladder, and the overlay's
 * acting vs shadow behavior. Default params only — these mirror the reference.
 */
import { describe, it, expect } from "vitest";
import {
  directionalWeight, windowActivity, bookProximityRisk, fillRiskScore, classify,
  widenTicksForLevel, applyFillRiskOverlay, type FrTrade,
} from "@/lib/strategies/fill-risk";

describe("directionalWeight", () => {
  it("a trade hitting our resting side is the adverse signal (1.0)", () => {
    expect(directionalWeight("BUY", "SELL")).toBe(1.0);
    expect(directionalWeight("SELL", "BUY")).toBe(1.0);
  });
  it("same-side liquidity adds barely matter (0.3); unknown is 0.5", () => {
    expect(directionalWeight("BUY", "BUY")).toBe(0.3);
    expect(directionalWeight("BUY", "")).toBe(0.5);
  });
});

describe("windowActivity", () => {
  it("ignores trades outside the window", () => {
    const trades: FrTrade[] = [{ ts: 100, side: "SELL", size: 10 }, { ts: 10, side: "SELL", size: 10 }];
    // window 30s, now 120 → only the ts=100 trade counts
    const a = windowActivity(trades, 120, 30, "BUY");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(1);
  });
  it("a burst of adverse SELLs against a BUY saturates toward 1", () => {
    const trades: FrTrade[] = Array.from({ length: 10 }, (_, k) => ({ ts: 100 + k, side: "SELL", size: 300 }));
    expect(windowActivity(trades, 120, 30, "BUY")).toBe(1.0);
  });
});

describe("bookProximityRisk", () => {
  it("at the touch ≈ 1, far behind decays toward 0", () => {
    expect(bookProximityRisk("BUY", 0.50, 0.50, 0.52, 0.01)).toBeCloseTo(1.0, 9);
    const far = bookProximityRisk("BUY", 0.40, 0.50, 0.52, 0.01); // 10 ticks behind
    expect(far).toBeLessThan(0.3);
  });
});

describe("classify thresholds (reference cutoffs)", () => {
  it("maps the four bands", () => {
    expect(classify(0.1)).toBe("LOW");
    expect(classify(0.3)).toBe("MODERATE");
    expect(classify(0.6)).toBe("ELEVATED");
    expect(classify(0.9)).toBe("HIGH");
  });
});

describe("widenTicksForLevel", () => {
  it("LOW 0, MODERATE 1, ELEVATED base, HIGH ceil(1.5×base)", () => {
    expect(widenTicksForLevel("LOW")).toBe(0);
    expect(widenTicksForLevel("MODERATE")).toBe(1);
    expect(widenTicksForLevel("ELEVATED", 2)).toBe(2);
    expect(widenTicksForLevel("HIGH", 2)).toBe(3);
  });
});

describe("fillRiskScore", () => {
  it("quiet tape → low score regardless of proximity", () => {
    const s = fillRiskScore({ trades: [], now: 1000, orderSide: "BUY", price: 0.5, bestBid: 0.5, bestAsk: 0.52, tick: 0.01 });
    expect(s).toBe(0);
  });
  it("heavy adverse tape at the touch → high score", () => {
    const trades: FrTrade[] = Array.from({ length: 12 }, (_, k) => ({ ts: 990 + k, side: "SELL", size: 500 }));
    const s = fillRiskScore({ trades, now: 1000, orderSide: "BUY", price: 0.5, bestBid: 0.5, bestAsk: 0.52, tick: 0.01 });
    expect(s).toBeGreaterThan(0.75); // HIGH band
  });
});

describe("applyFillRiskOverlay", () => {
  const heavy: FrTrade[] = Array.from({ length: 12 }, (_, k) => ({ ts: 990 + k, side: "SELL", size: 500 }));
  const touch = { bestBid: 0.5, bestAsk: 0.52 };

  it("ACTING: pulls the side under HIGH adverse pressure", () => {
    const ov = applyFillRiskOverlay({
      yesBid: { px: 0.5, sz: 25 }, noBid: null,
      yesTrades: heavy, noTrades: [], now: 1000,
      yesTouch: touch, noTouch: touch,
    });
    expect(ov.fr.yes).toBe("HIGH");
    expect(ov.yesBid).toBeNull();
  });

  it("SHADOW: computes the level but leaves the quote untouched", () => {
    const ov = applyFillRiskOverlay({
      yesBid: { px: 0.5, sz: 25 }, noBid: null,
      yesTrades: heavy, noTrades: [], now: 1000,
      yesTouch: touch, noTouch: touch, shadow: true,
    });
    expect(ov.fr.yes).toBe("HIGH");
    expect(ov.yesBid).not.toBeNull();
    expect(ov.yesBid!.px).toBe(0.5);
  });

  it("quiet tape leaves both bids unchanged (LOW)", () => {
    const ov = applyFillRiskOverlay({
      yesBid: { px: 0.5, sz: 25 }, noBid: { px: 0.47, sz: 25 },
      yesTrades: [], noTrades: [], now: 1000,
      yesTouch: touch, noTouch: { bestBid: 0.47, bestAsk: 0.49 },
    });
    expect(ov.yesBid!.px).toBe(0.5);
    expect(ov.noBid!.px).toBe(0.47);
  });

  it("widening only ever LOWERS a BUY bid (can't violate the pair budget)", () => {
    // moderate adverse pressure → widen 1 tick
    const mod: FrTrade[] = [{ ts: 999, side: "SELL", size: 200 }];
    const ov = applyFillRiskOverlay({
      yesBid: { px: 0.5, sz: 25 }, noBid: null,
      yesTrades: mod, noTrades: [], now: 1000,
      yesTouch: touch, noTouch: touch,
    });
    if (ov.yesBid) expect(ov.yesBid.px).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});
