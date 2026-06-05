import { describe, it, expect } from "vitest";
import { effectiveFeeBps, calibrateMakerFillRate } from "@/lib/backtest/maker-fill";
import type { MarketEvent } from "@/lib/backtest/l2/engine";

describe("effectiveFeeBps", () => {
  it("is the maker fee at 100% fill and taker at 0%", () => {
    expect(effectiveFeeBps(1, 1, 5)).toBe(1);
    expect(effectiveFeeBps(0, 1, 5)).toBe(5);
  });
  it("blends linearly", () => {
    expect(effectiveFeeBps(0.5, 1, 5)).toBeCloseTo(3, 9);
    expect(effectiveFeeBps(0.7, 1, 5)).toBeCloseTo(0.7 * 1 + 0.3 * 5, 9);
  });
  it("clamps the rate to [0,1]", () => {
    expect(effectiveFeeBps(1.5, 1, 5)).toBe(1);
    expect(effectiveFeeBps(-0.3, 1, 5)).toBe(5);
  });
});

const book = (ts: number, bid: number, ask: number): MarketEvent => ({ ts, kind: "book", bidPx: bid, bidSz: 1, askPx: ask, askSz: 1 });
const trade = (ts: number, price: number, aggressor: "BUY" | "SELL"): MarketEvent => ({ ts, kind: "trade", price, size: 1, aggressor });

describe("calibrateMakerFillRate", () => {
  it("counts a BID fill when a SELL hits the posted bid within the window", () => {
    // post at bid 100; a seller prints at 100 (≤ bid) 1s later → bid side fills, ask side doesn't
    const cal = calibrateMakerFillRate([book(0, 100, 101), trade(1, 100, "SELL")], { windowSec: 2, sampleEverySec: 0 });
    expect(cal.opportunities).toBe(2); // bid + ask
    expect(cal.fills).toBe(1);
    expect(cal.fillRate).toBe(0.5);
    expect(cal.avgTimeToFillSec).toBeCloseTo(1, 9);
  });
  it("counts an ASK fill when a BUY hits the posted ask", () => {
    const cal = calibrateMakerFillRate([book(0, 100, 101), trade(0.5, 101, "BUY")], { windowSec: 2, sampleEverySec: 0 });
    expect(cal.fills).toBe(1); // ask side
  });
  it("does NOT fill when the trade is on the wrong side or outside the price", () => {
    // a BUY at 101 fills the ask, but here the only trade is a SELL ABOVE the bid (102) → no bid fill
    const cal = calibrateMakerFillRate([book(0, 100, 101), trade(1, 102, "SELL")], { windowSec: 2, sampleEverySec: 0 });
    expect(cal.fills).toBe(0);
  });
  it("does NOT fill when the hit comes after the window expires", () => {
    const cal = calibrateMakerFillRate([book(0, 100, 101), trade(5, 100, "SELL")], { windowSec: 2, sampleEverySec: 0 });
    expect(cal.fills).toBe(0);
  });
  it("both touches fill → fillRate 1.0", () => {
    const cal = calibrateMakerFillRate([book(0, 100, 101), trade(0.5, 100, "SELL"), trade(0.6, 101, "BUY")], { windowSec: 2, sampleEverySec: 0 });
    expect(cal.fillRate).toBe(1);
  });
  it("sampleEverySec thins posting moments", () => {
    const ev = [book(0, 100, 101), book(0.1, 100, 101), book(0.2, 100, 101), trade(0.3, 100, "SELL")];
    // with 0.5s thinning, only the first book is a posting moment (2 opps), not all three
    expect(calibrateMakerFillRate(ev, { windowSec: 1, sampleEverySec: 0.5 }).opportunities).toBe(2);
    expect(calibrateMakerFillRate(ev, { windowSec: 1, sampleEverySec: 0 }).opportunities).toBe(6);
  });
  it("empty / no-book input → zero rate, no divide-by-zero", () => {
    expect(calibrateMakerFillRate([], {}).fillRate).toBe(0);
    expect(calibrateMakerFillRate([trade(0, 100, "SELL")], {}).opportunities).toBe(0);
  });
});
