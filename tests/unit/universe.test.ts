import { describe, it, expect } from "vitest";
import { coinSpans, restrictToConvention, aliveAtEnd, universeHealth, selectUniverse } from "@/lib/backtest/candle/universe";

const DAY = 86_400;
type Row = { start_unix: number; close: number };
const bars = (start: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ start_unix: start + i * DAY, close: 100 + i }));

describe("coinSpans", () => {
  it("reports first/last/n per coin and skips empties", () => {
    const s = coinSpans({ A: bars(1000, 3), B: bars(5000, 1), C: [] });
    expect(s.A).toEqual({ first: 1000, last: 1000 + 2 * DAY, n: 3 });
    expect(s.B).toEqual({ first: 5000, last: 5000, n: 1 });
    expect(s.C).toBeUndefined();
  });
});

describe("restrictToConvention", () => {
  const rows = { "BTC-USD": bars(0, 2), "ETH-USD": bars(0, 2), BTCUSDT: bars(0, 2), TONUSDT: bars(0, 2) };
  it("keeps only -USD coins for usd", () => {
    expect(Object.keys(restrictToConvention(rows, "usd")).sort()).toEqual(["BTC-USD", "ETH-USD"]);
  });
  it("keeps only USDT coins for usdt", () => {
    expect(Object.keys(restrictToConvention(rows, "usdt")).sort()).toEqual(["BTCUSDT", "TONUSDT"]);
  });
  it("does not match USDT against the -USD pattern (USDT does not end in -USD)", () => {
    expect(restrictToConvention({ XUSDT: bars(0, 1) }, "usd")).toEqual({});
  });
});

describe("aliveAtEnd — drops cohorts that died mid-history (the splice)", () => {
  it("keeps coins whose last bar is near the global max, drops the dead cohort", () => {
    const rows = {
      "BTC-USD": bars(0, 4000),                 // ends recent (global max)
      OLDUSDT: bars(0, 1300),                   // dies ~516 days before the end
    };
    const kept = aliveAtEnd(rows, 7);
    expect(Object.keys(kept)).toEqual(["BTC-USD"]);
  });
  it("keeps everything when all cohorts end together", () => {
    const rows = { A: bars(1000, 10), B: bars(1000, 10) };
    expect(Object.keys(aliveAtEnd(rows, 7)).sort()).toEqual(["A", "B"]);
  });
  it("returns {} on empty input", () => {
    expect(aliveAtEnd({})).toEqual({});
  });
});

describe("universeHealth — splice detector", () => {
  it("flags a composition cliff when a cohort vanishes", () => {
    // 5 coins for 100 days, then 4 of them stop; 1 continues 100 more days → a 4-coin drop.
    const rows: Record<string, Row[]> = { keep: bars(0, 200) };
    for (const k of ["a", "b", "c", "d"]) rows[k] = bars(0, 100);
    const h = universeHealth(rows, { dropThreshold: 3 });
    expect(h.coins).toBe(5);
    expect(h.maxActive).toBe(5);
    expect(h.biggestDrop!.lost).toBe(4);
    expect(h.spliceSuspected).toBe(true);
  });
  it("does NOT flag a stable universe", () => {
    const h = universeHealth({ a: bars(0, 50), b: bars(0, 50), c: bars(0, 50) }, { dropThreshold: 2 });
    expect(h.minActive).toBe(3);
    expect(h.maxActive).toBe(3);
    expect(h.spliceSuspected).toBe(false);
    expect(h.biggestDrop!.lost).toBeLessThanOrEqual(0);
  });
  it("handles empty input", () => {
    const h = universeHealth({});
    expect(h.days).toBe(0);
    expect(h.biggestDrop).toBeNull();
    expect(h.spliceSuspected).toBe(false);
  });
});

describe("selectUniverse", () => {
  const rows = { "BTC-USD": bars(0, 4000), ETHUSDT: bars(0, 1300) };
  it("'all' is identity", () => {
    expect(Object.keys(selectUniverse(rows, "all")).sort()).toEqual(["BTC-USD", "ETHUSDT"]);
  });
  it("'usd' keeps -USD, 'usdt' keeps USDT, 'alive' keeps the current cohort", () => {
    expect(Object.keys(selectUniverse(rows, "usd"))).toEqual(["BTC-USD"]);
    expect(Object.keys(selectUniverse(rows, "usdt"))).toEqual(["ETHUSDT"]);
    expect(Object.keys(selectUniverse(rows, "alive"))).toEqual(["BTC-USD"]);
  });
});
