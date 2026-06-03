import { describe, it, expect } from "vitest";
import { fundingGate, fundingCarrySignal, netFundingReturns } from "@/lib/backtest/candle/funding";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

const candles = (closes: number[]): DailyCandle[] =>
  closes.map((c, i) => ({ start_unix: i, open: c, high: c, low: c, close: c, volume: 1 }));

describe("fundingGate — avoid longs when funding is punitive", () => {
  it("keeps the long when funding ≤ cap, zeros it when funding is punitive (> cap)", () => {
    const pos = [1, 1, 1, 1];
    const f = [-0.0002, 0, 0.0005, 0.001]; // paid, neutral, punitive, very punitive
    expect(fundingGate(pos, f, { maxFunding: 0 })).toEqual([1, 1, 0, 0]);
  });
  it("flattens on a missing funding bar; gate only SUBTRACTS", () => {
    expect(fundingGate([1, 1], [undefined, -0.0001])).toEqual([0, 1]);
    expect(fundingGate([0, 1], [-0.0001, -0.0001])).toEqual([0, 1]); // input 0 stays 0
  });
  it("is no-lookahead (funding[i] only)", () => {
    const pos = [1, 1, 1, 1, 1];
    const f = [-0.0001, -0.0001, 0.001, -0.0001, -0.0001];
    const base = fundingGate(pos, f);
    const f2 = [...f]; f2[4] = 0.5;
    expect(fundingGate(pos, f2).slice(0, 4)).toEqual(base.slice(0, 4));
  });
});

describe("fundingCarrySignal — long to collect negative funding", () => {
  it("long when funding ≤ enter, flat when ≥ exit, holds in the band", () => {
    const f = [-0.001, -0.0005, 0.00005, 0.001, -0.001];
    const s = fundingCarrySignal(f, { enter: 0, exit: 0.0001 });
    expect(s).toEqual([1, 1, 1, 0, 1]); // enters at <=0, holds through the small band, exits at >=exit, re-enters
  });
  it("is no-lookahead (a future funding value can't change an earlier signal)", () => {
    const f = [-0.001, 0.001, -0.001, 0.001, -0.001, 0.001];
    const base = fundingCarrySignal(f, { enter: 0, exit: 0.0001 });
    const f2 = [...f]; f2[5] = -9;
    expect(fundingCarrySignal(f2, { enter: 0, exit: 0.0001 }).slice(0, 5)).toEqual(base.slice(0, 5));
  });
});

describe("netFundingReturns — perp carry return (price − funding paid by a long)", () => {
  it("a long PAYS positive funding (lower than price-only return) and RECEIVES negative funding", () => {
    const cs = candles([100, 110]); // +10% price
    expect(netFundingReturns(cs, [1, 1], [0.02], 0)[0]).toBeCloseTo(0.10 - 0.02, 9);   // pays 2% funding
    expect(netFundingReturns(cs, [1, 1], [-0.02], 0)[0]).toBeCloseTo(0.10 + 0.02, 9);  // paid 2% funding
  });
  it("flat position earns 0; non-finite funding contributes 0 funding", () => {
    const cs = candles([100, 110, 121]);
    expect(netFundingReturns(cs, [0, 0, 0], [0.01, 0.01], 0).every((x) => x === 0)).toBe(true);
    expect(netFundingReturns(cs, [1, 1, 1], [undefined, undefined], 0)[0]).toBeCloseTo(0.1, 9); // no funding → price only
  });
  it("charges fee on turnover", () => {
    const cs = candles([100, 100, 100]);
    expect(netFundingReturns(cs, [1, 1, 0], [0, 0], 100)[0]).toBeCloseTo(-100 / 1e4, 9); // open at bar0
  });
  it("is no-lookahead (a far-future candle can't change earlier returns)", () => {
    const a = [100, 102, 101, 104, 106, 103, 108];
    const f = a.map(() => 0.001);
    const base = netFundingReturns(candles(a), a.map(() => 1), f, 5);
    const a2 = [...a]; a2[6] = 9999;
    expect(netFundingReturns(candles(a2), a2.map(() => 1), f, 5).slice(0, -1)).toEqual(base.slice(0, -1));
  });
});
