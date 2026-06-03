import { describe, it, expect } from "vitest";
import {
  relativeStrengthReturns, defaultRelStrengthVariants, btcRegimeFilter, alignClosesByTimestamp,
  equalWeightBuyHoldReturns,
} from "@/lib/backtest/candle/cross-asset";
import type { PriceSeries } from "@/lib/backtest/candle/xsection";

function mk(prices: Record<string, number[]>): { coins: string[]; data: PriceSeries; days: number[] } {
  const coins = Object.keys(prices);
  const data: PriceSeries = {};
  const allDays = new Set<number>();
  for (const c of coins) { const m = new Map<number, number>(); prices[c].forEach((p, i) => { m.set(i, p); allDays.add(i); }); data[c] = m; }
  return { coins, data, days: [...allDays].sort((a, b) => a - b) };
}
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const V = (L: number, topK: number) => ({ label: `rs${L}/top${topK}`, L, topK });

describe("relativeStrengthReturns — long the strongest coins", () => {
  it("top-1 holds the single strongest coin and earns ITS next return", () => {
    // day1 L-returns: A +20%, B +10%, C +5% → top-1 = A; A then runs +10% day1→day2
    const { coins, data, days } = mk({ A: [100, 120, 132], B: [100, 110, 115], C: [100, 105, 108] });
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 });
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(132 / 120 - 1, 9); // = +10%, A's realized next return
  });

  it("top-2 equal-weights the two strongest coins", () => {
    const { coins, data, days } = mk({ A: [100, 120, 132], B: [100, 110, 121], C: [100, 105, 108] });
    const r = relativeStrengthReturns(V(1, 2), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 });
    const expected = 0.5 * (132 / 120 - 1) + 0.5 * (121 / 110 - 1); // A + B, equal weight
    expect(r[0]).toBeCloseTo(expected, 9);
  });

  it("captures cross-asset momentum: the recent leader keeps leading → positive", () => {
    // A leads on L-return and keeps winning the next bar
    const { coins, data, days } = mk({ A: [100, 130, 169], B: [100, 90, 81], C: [100, 100, 100] });
    const r = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 });
    expect(r[0]).toBeGreaterThan(0);
  });

  it("returns 0 on a rebalance with fewer than minCoins eligible", () => {
    const { coins, data, days } = mk({ A: [100, 120, 132], B: [100, 110, 115] });
    expect(relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, minCoins: 3, startIndex: 1 }).every((x) => x === 0)).toBe(true);
  });

  it("has NO LOOKAHEAD — a far-future price can't change earlier returns", () => {
    const p: Record<string, number[]> = {
      A: [100, 110, 105, 120, 118, 130, 125, 140],
      B: [100, 105, 110, 108, 115, 112, 120, 118],
      C: [100, 98, 102, 99, 104, 101, 106, 103],
    };
    const base = mk(p); const r0 = relativeStrengthReturns(V(2, 1), base.coins, base.data, base.days, { feeBps: 5, startIndex: 2 });
    const p2 = { ...p, A: [...p.A] }; p2.A[7] = 9999;
    const pert = mk(p2); const r1 = relativeStrengthReturns(V(2, 1), pert.coins, pert.data, pert.days, { feeBps: 5, startIndex: 2 });
    expect(r1.slice(0, -1)).toEqual(r0.slice(0, -1));
  });

  it("more fee never increases total return when it rotates", () => {
    const p = { A: [100, 130, 110, 150, 120], B: [100, 90, 130, 95, 140], C: [100, 110, 100, 120, 105] };
    const { coins, data, days } = mk(p);
    const lo = sum(relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 }));
    const hi = sum(relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 100, startIndex: 1 }));
    expect(hi).toBeLessThan(lo);
  });

  it("defaultRelStrengthVariants is the lookback × topK grid", () => {
    const vs = defaultRelStrengthVariants([5, 10], [1, 2]);
    expect(vs.map((v) => v.label)).toEqual(["rs5/top1", "rs5/top2", "rs10/top1", "rs10/top2"]);
  });
});

describe("equalWeightBuyHoldReturns — the beta benchmark", () => {
  it("averages every eligible coin's next-bar return, no fees", () => {
    const { coins, data, days } = mk({ A: [100, 120, 132], B: [100, 110, 121], C: [100, 105, 110.25] });
    const r = equalWeightBuyHoldReturns(coins, data, days, 0);
    // bar0: avg of A 20%, B 10%, C 5% = 11.667%
    expect(r[0]).toBeCloseTo((0.2 + 0.1 + 0.05) / 3, 9);
    // bar1: avg of A 10%, B 10%, C 5% = 8.333%
    expect(r[1]).toBeCloseTo((0.1 + 0.1 + 0.05) / 3, 9);
  });

  it("aligns 1:1 with relativeStrengthReturns at the same startIndex so they subtract bar-for-bar", () => {
    const p = { A: [100, 130, 110, 150, 120], B: [100, 90, 130, 95, 140], C: [100, 110, 100, 120, 105] };
    const { coins, data, days } = mk(p);
    const strat = relativeStrengthReturns(V(1, 1), coins, data, days, { feeBps: 0, startIndex: 1 });
    const beta = equalWeightBuyHoldReturns(coins, data, days, 1);
    expect(beta).toHaveLength(strat.length);
  });

  it("skips coins missing a bar (only eligible names count)", () => {
    const { coins, data, days } = mk({ A: [100, 110], B: [100, 100] });
    data.B.delete(1); // B has no close at t+1 → excluded that bar
    expect(equalWeightBuyHoldReturns(coins, data, days, 0)[0]).toBeCloseTo(0.1, 9); // only A
  });

  it("has NO LOOKAHEAD — a far-future price can't change earlier benchmark returns", () => {
    const p: Record<string, number[]> = { A: [100, 110, 105, 120, 118], B: [100, 105, 110, 108, 115] };
    const base = mk(p); const r0 = equalWeightBuyHoldReturns(base.coins, base.data, base.days, 0);
    const p2 = { ...p, A: [...p.A] }; p2.A[4] = 9999;
    const pert = mk(p2); const r1 = equalWeightBuyHoldReturns(pert.coins, pert.data, pert.days, 0);
    expect(r1.slice(0, -1)).toEqual(r0.slice(0, -1));
  });
});

describe("btcRegimeFilter — only long alts when BTC is bullish", () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);       // BTC uptrend
  const down = Array.from({ length: 20 }, (_, i) => 120 - i);     // BTC downtrend
  const ones = new Array(20).fill(1);

  it("keeps the position in a BTC uptrend, zeroes it in a downtrend", () => {
    expect(btcRegimeFilter(ones, up, 5).slice(5).every((p) => p === 1)).toBe(true);
    expect(btcRegimeFilter(ones, down, 5).every((p) => p === 0)).toBe(true);
  });

  it("flattens before warmup and on a missing BTC close", () => {
    expect(btcRegimeFilter(ones, up, 5).slice(0, 4).every((p) => p === 0)).toBe(true); // i+1<n
    const gap = [...up]; (gap as (number | undefined)[])[10] = undefined;
    expect(btcRegimeFilter(ones, gap as (number | undefined)[], 5)[10]).toBe(0);
  });

  it("only SUBTRACTS — never sets a position where the input was 0", () => {
    const mixed = up.map((_, i) => (i % 2 ? 1 : 0));
    const g = btcRegimeFilter(mixed, up, 5);
    for (let i = 0; i < g.length; i++) if (mixed[i] === 0) expect(g[i]).toBe(0);
  });

  it("has NO LOOKAHEAD — a future BTC close can't change an earlier gated position", () => {
    const base = btcRegimeFilter(ones, up, 5);
    const b2 = [...up]; b2[19] = 9999;
    expect(btcRegimeFilter(ones, b2, 5).slice(0, 19)).toEqual(base.slice(0, 19));
  });
});

describe("alignClosesByTimestamp", () => {
  it("maps benchmark closes onto the target's bar timestamps (undefined where absent)", () => {
    const target = [{ start_unix: 10 }, { start_unix: 20 }, { start_unix: 30 }];
    const bench = [{ start_unix: 10, close: 1 }, { start_unix: 30, close: 3 }]; // no bar at 20
    expect(alignClosesByTimestamp(target, bench)).toEqual([1, undefined, 3]);
  });
});
