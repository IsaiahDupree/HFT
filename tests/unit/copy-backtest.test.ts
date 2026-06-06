import { describe, it, expect } from "vitest";
import { fillSignedDelta, reconstructPositionSeries, positionAt, cohortNetAt, copyStrategyReturns, pctReturns, leadLag, pearson, sharpe, hitRate, type Fill } from "@/lib/exec/copy-backtest";

describe("fillSignedDelta — signed position effect of a fill", () => {
  it("Open Long +, Close Long −, Open Short −, Close Short +", () => {
    expect(fillSignedDelta("Open Long", 2)).toBe(2);
    expect(fillSignedDelta("Close Long", 2)).toBe(-2);
    expect(fillSignedDelta("Open Short", 2)).toBe(-2);
    expect(fillSignedDelta("Close Short", 2)).toBe(2);
  });
});

const fills: Fill[] = [
  { coin: "BTC", dir: "Open Long", sz: 3, px: 60000, time: 100 },
  { coin: "ETH", dir: "Open Short", sz: 5, px: 2000, time: 110 }, // other coin, ignored for BTC series
  { coin: "BTC", dir: "Close Long", sz: 1, px: 61000, time: 200 },
  { coin: "BTC", dir: "Open Short", sz: 4, px: 60500, time: 300 },
];

describe("reconstructPositionSeries + positionAt", () => {
  it("builds the cumulative signed BTC position over time", () => {
    const s = reconstructPositionSeries(fills, "BTC");
    expect(s.map((p) => p.pos)).toEqual([3, 2, -2]); // +3, then −1 → 2, then −4 → −2
  });
  it("positionAt is a step function (last point ≤ t), 0 before the first fill", () => {
    const s = reconstructPositionSeries(fills, "BTC");
    expect(positionAt(s, 50)).toBe(0);
    expect(positionAt(s, 150)).toBe(3);
    expect(positionAt(s, 250)).toBe(2);
    expect(positionAt(s, 9999)).toBe(-2);
  });
  it("cohortNetAt sums positions across wallets at a time", () => {
    const a = reconstructPositionSeries(fills, "BTC");
    const b = reconstructPositionSeries([{ coin: "BTC", dir: "Open Long", sz: 10, px: 60000, time: 120 }], "BTC");
    expect(cohortNetAt([a, b], 250)).toBe(2 + 10);
  });
});

describe("copyStrategyReturns — NO-LOOKAHEAD", () => {
  it("applies the position SIGN at i to the FORWARD return i, length matches priceReturns", () => {
    const cohort = [5, 5, -3, -3];      // long, long, short, short
    const rets = [0.01, -0.02, 0.03];   // 3 forward returns
    const strat = copyStrategyReturns(cohort, rets);
    expect(strat).toEqual([0.01, -0.02, -0.03]); // +,+,− applied
  });
  it("perturbing a FUTURE cohort position or price cannot change an earlier strategy return", () => {
    const cohort = [5, 5, -3, -3], rets = [0.01, -0.02, 0.03];
    const base = copyStrategyReturns(cohort, rets);
    const c2 = [...cohort]; c2[3] = 999;           // future position flip
    const r2 = [...rets]; r2[2] = -0.5;            // future return change
    const after = copyStrategyReturns(c2, r2);
    expect(after[0]).toBe(base[0]);
    expect(after[1]).toBe(base[1]);                // earlier values unchanged
  });
});

describe("leadLag — predictive (leads) vs reactive (lags)", () => {
  it("detects flow that LEADS price as positive corr at k=+1", () => {
    // construct: Δposition[i] == priceReturns[i+1] ⇒ flow leads by one step
    const rets = [0.02, -0.01, 0.03, -0.04, 0.05, -0.02, 0.01, 0.02];
    const cohort = [0];
    for (let i = 0; i < rets.length; i++) cohort.push(cohort[i] + (rets[i + 1] ?? 0)); // flow[i]=rets[i+1]
    const ll = leadLag(cohort, rets, 2);
    const atLead = ll.find((x) => x.lag === 1)!.corr;
    const atZero = ll.find((x) => x.lag === 0)!.corr;
    expect(atLead).toBeGreaterThan(0.9);            // flow strongly leads price
    expect(atLead).toBeGreaterThan(atZero);
  });
});

describe("stats helpers", () => {
  it("pctReturns, pearson, sharpe sign, hitRate", () => {
    const pr = pctReturns([100, 110, 99]); expect(pr[0]).toBeCloseTo(0.1, 9); expect(pr[1]).toBeCloseTo(-0.1, 9);
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 5);
    expect(sharpe([0.02, 0.01, 0.03, 0.01])).toBeGreaterThan(0); // positive mean + variance
    expect(sharpe([0.01, 0.01, 0.01, 0.01])).toBe(0);            // zero variance ⇒ undefined ⇒ 0
    expect(hitRate([0.01, -0.02, 0.03, 0])).toBeCloseTo(2 / 3, 5); // zeros excluded
  });
});
