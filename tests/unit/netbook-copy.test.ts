import { describe, it, expect } from "vitest";
import { netBookWeights, priceReturns, bookMtmReturn, rebalanceCost, gradeNetbookPeriod, netbookTrackRecord } from "@/lib/exec/netbook-copy";

describe("netBookWeights — scale-free signed exposure", () => {
  it("normalizes signed notionals to weights summing to 1 in absolute value", () => {
    const w = netBookWeights([{ coin: "BTC", notionalUsd: 75_000 }, { coin: "ETH", notionalUsd: -25_000 }]);
    expect(w.BTC).toBeCloseTo(0.75, 6);
    expect(w.ETH).toBeCloseTo(-0.25, 6);
    expect(Math.abs(w.BTC) + Math.abs(w.ETH)).toBeCloseTo(1, 6);
  });
  it("a $50k and a $5M wallet holding the same book get identical weights", () => {
    const small = netBookWeights([{ coin: "BTC", notionalUsd: 25_000 }, { coin: "ETH", notionalUsd: 25_000 }]);
    const large = netBookWeights([{ coin: "BTC", notionalUsd: 2_500_000 }, { coin: "ETH", notionalUsd: 2_500_000 }]);
    expect(small).toEqual(large);
  });
  it("empty / flat book → no weights", () => {
    expect(netBookWeights([])).toEqual({});
    expect(netBookWeights([{ coin: "BTC", notionalUsd: 0 }])).toEqual({});
  });
});

describe("bookMtmReturn — Σ wᵢ·rᵢ", () => {
  it("a long book gains when its coins rise; a short leg offsets", () => {
    const w = { BTC: 0.5, ETH: -0.5 };
    const r = priceReturns({ BTC: 100, ETH: 100 }, { BTC: 110, ETH: 90 }); // BTC +10%, ETH −10%
    expect(r.BTC).toBeCloseTo(0.1, 6);
    expect(bookMtmReturn(w, r)).toBeCloseTo(0.5 * 0.1 + -0.5 * -0.1, 6); // +0.10 (short profits as ETH falls)
  });
  it("a coin with no price contributes nothing", () => {
    expect(bookMtmReturn({ BTC: 1 }, {})).toBe(0);
  });
});

describe("rebalanceCost — chasing the target's book is not free", () => {
  it("a full flip (long→short same coin) costs the full turnover", () => {
    // |(-1) - (1)| = 2, /2 = 1 turnover unit × 10bps
    expect(rebalanceCost({ BTC: 1 }, { BTC: -1 }, 10)).toBeCloseTo(0.001, 9);
  });
  it("holding the same book costs nothing", () => {
    expect(rebalanceCost({ BTC: 0.5, ETH: 0.5 }, { BTC: 0.5, ETH: 0.5 }, 25)).toBe(0);
  });
});

describe("gradeNetbookPeriod + netbookTrackRecord — the honest after-cost gate", () => {
  it("net = mtm − rebalance cost", () => {
    const p = gradeNetbookPeriod({ BTC: 1 }, { BTC: 0.02 }, { BTC: 0.5, ETH: 0.5 }, 10);
    expect(p.mtm).toBeCloseTo(0.02, 6);
    expect(p.cost).toBeGreaterThan(0);
    expect(p.net).toBeCloseTo(p.mtm - p.cost, 9);
  });
  it("a profitable, low-turnover mirror passes netOfCostPays; a costly churn does not", () => {
    const good = Array.from({ length: 12 }, () => ({ mtm: 0.011, cost: 0.001, net: 0.01 }));
    const t = netbookTrackRecord(good);
    expect(t.n).toBe(12);
    expect(t.hitRate).toBe(1);
    expect(t.cumNet).toBeGreaterThan(0);
    expect(t.netOfCostPays).toBe(true);

    // same gross MTM, but costs eat it all → net ≤ 0 → fails
    const churned = Array.from({ length: 12 }, () => ({ mtm: 0.011, cost: 0.012, net: -0.001 }));
    expect(netbookTrackRecord(churned).netOfCostPays).toBe(false);
  });
  it("too few periods never passes, however good (forward discipline)", () => {
    const t = netbookTrackRecord([{ mtm: 0.05, cost: 0, net: 0.05 }, { mtm: 0.05, cost: 0, net: 0.05 }]);
    expect(t.netOfCostPays).toBe(false);
  });
});
