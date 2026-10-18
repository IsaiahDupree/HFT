import { describe, expect, it } from "vitest";
import {
  applyFill,
  computeQuotes,
  freshPnl,
  roundToStep,
  roundToTick,
  shouldReplace,
  unrealisedPnl,
  type Fill,
  type MarketParams,
  type MmConfig,
} from "@/lib/hft/dydx/mm";

const ETH: MarketParams = { tickSize: 0.1, stepSize: 0.001 };

const baseCfg: MmConfig = {
  halfSpreadBps: 10,         // 10 bps each side → 20 bps quoted spread
  perSideUsd: 100,
  maxInventoryUsd: 1000,
  driftBps: 5,
  skewBpsPerDollar: 0,       // skew off by default; tests turn it on explicitly
};

describe("roundToTick / roundToStep", () => {
  it("rounds price to nearest tick", () => {
    expect(roundToTick(2000.04, 0.1)).toBe(2000);
    expect(roundToTick(2000.06, 0.1)).toBe(2000.1);
    expect(roundToTick(73551.65, 0.5)).toBe(73551.5);
  });

  it("returns at least stepSize for vanishingly small inputs", () => {
    expect(roundToStep(0.0001, 0.001)).toBe(0.001);
    expect(roundToStep(0, 0.001)).toBe(0.001);
  });

  it("rounds size to nearest step", () => {
    expect(roundToStep(0.0497, 0.001)).toBeCloseTo(0.05, 9);
    expect(roundToStep(0.0494, 0.001)).toBeCloseTo(0.049, 9);
  });
});

describe("computeQuotes — symmetric around fair when flat", () => {
  it("flat inventory → bid and ask equidistant from fair", () => {
    const q = computeQuotes(2000, 0, baseCfg, ETH);
    expect(q.skewBps).toBeCloseTo(0, 9);
    expect(q.fair).toBeCloseTo(2000, 9);
    expect(q.bid!.price).toBeCloseTo(1998, 1);  // 10 bps below 2000 = 1998
    expect(q.ask!.price).toBeCloseTo(2002, 1);  // 10 bps above
  });

  it("size = perSideUsd / fair, rounded to step", () => {
    const q = computeQuotes(2000, 0, baseCfg, ETH);
    expect(q.bid!.size).toBeCloseTo(0.05, 4); // $100 / $2000 = 0.05
    expect(q.ask!.size).toBeCloseTo(0.05, 4);
  });

  it("prices snap to tick", () => {
    // Pick a fair that's not exactly tick-aligned so we exercise rounding.
    const q = computeQuotes(2000.37, 0, baseCfg, ETH);
    expect((q.bid!.price * 10) % 1).toBeCloseTo(0, 9);
    expect((q.ask!.price * 10) % 1).toBeCloseTo(0, 9);
  });
});

describe("computeQuotes — inventory cap suppresses sides", () => {
  it("inventory at +cap: bids suppressed (we're max-long)", () => {
    const q = computeQuotes(2000, 1000, baseCfg, ETH);
    expect(q.bid).toBeUndefined();
    expect(q.ask).toBeDefined();
  });

  it("inventory at −cap: asks suppressed (we're max-short)", () => {
    const q = computeQuotes(2000, -1000, baseCfg, ETH);
    expect(q.ask).toBeUndefined();
    expect(q.bid).toBeDefined();
  });

  it("inventory inside cap: both sides quote", () => {
    const q = computeQuotes(2000, 500, baseCfg, ETH);
    expect(q.bid).toBeDefined();
    expect(q.ask).toBeDefined();
  });
});

describe("computeQuotes — skew tilts mid against inventory", () => {
  it("positive inventory + positive skew → negative skewBps → fair pushed down", () => {
    const cfg = { ...baseCfg, skewBpsPerDollar: 0.5 }; // 0.5 bps per $1
    const q = computeQuotes(2000, 100, cfg, ETH); // long $100
    // expected skewBps = -100 * 0.5 = -50 bps → fair = 2000 * (1 - 0.005) = 1990
    expect(q.skewBps).toBeCloseTo(-50, 6);
    expect(q.fair).toBeCloseTo(1990, 3);
    // bid below 1990, ask above 1990; both shifted from non-skewed fair of 2000
    expect(q.bid!.price).toBeLessThan(1990);
    expect(q.ask!.price).toBeGreaterThan(1990);
    expect(q.ask!.price).toBeLessThan(2002); // tighter ask than no-skew case
  });

  it("zero skewBpsPerDollar → fair unchanged regardless of inventory", () => {
    const q = computeQuotes(2000, 999, baseCfg, ETH);
    expect(q.skewBps).toBeCloseTo(0, 9);
    expect(q.fair).toBeCloseTo(2000, 9);
  });
});

describe("shouldReplace", () => {
  it("returns false when drift is within tolerance", () => {
    // 2 bps drift, threshold 5 bps → keep
    expect(shouldReplace(2000, 2000.4, 5)).toBe(false);
  });

  it("returns true when drift exceeds threshold", () => {
    // ~10 bps drift, threshold 5 bps → replace
    expect(shouldReplace(2000, 2002, 5)).toBe(true);
  });

  it("symmetric on direction", () => {
    expect(shouldReplace(2002, 2000, 5)).toBe(true);
  });
});

describe("applyFill — single side accumulation", () => {
  it("opening BUY sets position and vwap, deducts fee from realised", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 100, 1, 0.05));
    expect(st.position).toBe(1);
    expect(st.vwap).toBe(100);
    expect(st.feesUsd).toBe(0.05);
    expect(st.realisedUsd).toBe(-0.05);
  });

  it("two BUYs average into a blended vwap", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 100, 1, 0));
    st = applyFill(st, fill("BUY", 110, 1, 0));
    expect(st.position).toBe(2);
    expect(st.vwap).toBe(105);
    expect(st.realisedUsd).toBe(0);
  });

  it("flatten by opposite-side fill books realised PnL against vwap", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 100, 1, 0));      // long 1 @ 100
    st = applyFill(st, fill("SELL", 110, 1, 0));     // sell 1 @ 110
    expect(st.position).toBe(0);
    expect(st.vwap).toBe(0);
    expect(st.realisedUsd).toBeCloseTo(10, 6);       // ($110−$100) × 1
  });

  it("short side mirrors long: SELL → BUY books reverse PnL", () => {
    let st = freshPnl();
    st = applyFill(st, fill("SELL", 110, 1, 0));     // short 1 @ 110
    st = applyFill(st, fill("BUY", 100, 1, 0));      // cover 1 @ 100
    expect(st.position).toBe(0);
    expect(st.realisedUsd).toBeCloseTo(10, 6);       // ($110−$100) × 1
  });
});

describe("applyFill — crossing zero splits the fill correctly", () => {
  it("long 1 → SELL 2 leaves us short 1 @ the sell price, books PnL on the closed portion", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 100, 1, 0));
    st = applyFill(st, fill("SELL", 110, 2, 0));
    expect(st.position).toBe(-1);
    expect(st.vwap).toBe(110);                       // new short opened at sell price
    expect(st.realisedUsd).toBeCloseTo(10, 6);       // only the closed unit booked
  });

  it("short 2 → BUY 3 leaves us long 1 @ buy price, books cover PnL on the closed two", () => {
    let st = freshPnl();
    st = applyFill(st, fill("SELL", 110, 2, 0));     // short 2 @ 110
    st = applyFill(st, fill("BUY", 100, 3, 0));      // cover 2 + open 1 long
    expect(st.position).toBe(1);
    expect(st.vwap).toBe(100);
    expect(st.realisedUsd).toBeCloseTo(20, 6);       // ($110−$100) × 2 closed
  });
});

describe("applyFill — fees accumulate independently", () => {
  it("fees subtract from realised on every fill", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 100, 1, 0.1));
    st = applyFill(st, fill("SELL", 100, 1, 0.1));
    expect(st.feesUsd).toBeCloseTo(0.2, 6);
    expect(st.realisedUsd).toBeCloseTo(-0.2, 6);     // no gross PnL, only fees
  });
});

describe("unrealisedPnl", () => {
  it("zero when flat", () => {
    expect(unrealisedPnl(freshPnl(), 2000)).toBe(0);
  });

  it("long position: (mark − vwap) × size", () => {
    const st = { ...freshPnl(), position: 2, vwap: 100 };
    expect(unrealisedPnl(st, 110)).toBe(20);
  });

  it("short position: (vwap − mark) × |size|", () => {
    const st = { ...freshPnl(), position: -2, vwap: 110 };
    expect(unrealisedPnl(st, 100)).toBe(20);
  });

  it("losses are negative", () => {
    const st = { ...freshPnl(), position: 1, vwap: 100 };
    expect(unrealisedPnl(st, 90)).toBe(-10);
  });
});

function fill(side: "BUY" | "SELL", price: number, size: number, feeUsd: number): Fill {
  return { side, price, size, feeUsd, ts: 0 };
}
