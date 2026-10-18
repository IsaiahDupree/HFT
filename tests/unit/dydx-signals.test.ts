import { describe, expect, it } from "vitest";
import {
  computeMicroprice,
  computeOBI,
  obiWidenMultiplier,
  quotedSpreadBps,
  type BookLevel,
} from "@/lib/hft/dydx/signals";

function lvl(price: number, size: number): BookLevel {
  return { price, size };
}

describe("computeMicroprice", () => {
  it("equal sizes → mid", () => {
    expect(computeMicroprice([lvl(100, 5)], [lvl(101, 5)])).toBeCloseTo(100.5, 9);
  });

  it("heavy bid → fair tilts toward ask", () => {
    // bid_size 10, ask_size 1 → microprice = (10*101 + 1*100) / 11 = 1110/11 ≈ 100.909
    const mp = computeMicroprice([lvl(100, 10)], [lvl(101, 1)])!;
    expect(mp).toBeCloseTo(100.909090909, 6);
    expect(mp).toBeGreaterThan(100.5); // away from mid, toward ask
  });

  it("heavy ask → fair tilts toward bid", () => {
    const mp = computeMicroprice([lvl(100, 1)], [lvl(101, 10)])!;
    expect(mp).toBeCloseTo(100.090909091, 6);
    expect(mp).toBeLessThan(100.5);
  });

  it("missing side → null", () => {
    expect(computeMicroprice([], [lvl(101, 5)])).toBeNull();
    expect(computeMicroprice([lvl(100, 5)], [])).toBeNull();
    expect(computeMicroprice([], [])).toBeNull();
  });

  it("zero sizes both → null (no opinion)", () => {
    expect(computeMicroprice([lvl(100, 0)], [lvl(101, 0)])).toBeNull();
  });
});

describe("computeOBI", () => {
  it("balanced book → 0", () => {
    expect(computeOBI([lvl(100, 5)], [lvl(101, 5)])).toBeCloseTo(0, 9);
  });

  it("bid-heavy → positive", () => {
    expect(computeOBI([lvl(100, 10)], [lvl(101, 2)])).toBeCloseTo((10 - 2) / 12, 9);
  });

  it("ask-heavy → negative", () => {
    expect(computeOBI([lvl(100, 2)], [lvl(101, 10)])).toBeCloseTo((2 - 10) / 12, 9);
  });

  it("sums top-N levels", () => {
    const bids = [lvl(100, 1), lvl(99.9, 1), lvl(99.8, 1)];
    const asks = [lvl(100.1, 1), lvl(100.2, 1)];
    // top-3 bids = 3, top-3 asks = 2, OBI = 1/5
    expect(computeOBI(bids, asks, 3)).toBeCloseTo(0.2, 9);
    // top-1 bids = 1, top-1 asks = 1, OBI = 0
    expect(computeOBI(bids, asks, 1)).toBeCloseTo(0, 9);
  });

  it("empty book → 0", () => {
    expect(computeOBI([], [])).toBe(0);
  });
});

describe("quotedSpreadBps", () => {
  it("computes spread in bps of mid", () => {
    // mid 100, spread 0.10 → 10 bps
    expect(quotedSpreadBps([lvl(99.95, 1)], [lvl(100.05, 1)])).toBeCloseTo(10, 6);
  });

  it("null when either side missing", () => {
    expect(quotedSpreadBps([], [lvl(100, 1)])).toBeNull();
    expect(quotedSpreadBps([lvl(99, 1)], [])).toBeNull();
  });
});

describe("obiWidenMultiplier", () => {
  it("below threshold → 1× (no widening)", () => {
    expect(obiWidenMultiplier(0.1, 0.3, 3)).toBe(1);
    expect(obiWidenMultiplier(0, 0.3, 3)).toBe(1);
  });

  it("at saturation (|OBI|=1) → maxMultiplier", () => {
    expect(obiWidenMultiplier(1, 0.3, 3)).toBe(3);
    expect(obiWidenMultiplier(-1, 0.3, 3)).toBe(3);
  });

  it("linear interpolation between threshold and 1", () => {
    // threshold 0.3, max 3×, |OBI|=0.65 → t=(0.65-0.3)/(1-0.3)=0.5 → 1 + 0.5*(3-1) = 2
    expect(obiWidenMultiplier(0.65, 0.3, 3)).toBeCloseTo(2, 6);
    expect(obiWidenMultiplier(-0.65, 0.3, 3)).toBeCloseTo(2, 6);
  });

  it("symmetric in sign of OBI", () => {
    expect(obiWidenMultiplier(0.5, 0.2, 4)).toBe(obiWidenMultiplier(-0.5, 0.2, 4));
  });
});
