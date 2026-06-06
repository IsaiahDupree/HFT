import { describe, it, expect } from "vitest";
import { evaluateForward, trackRecord, type Snapshot } from "@/lib/exec/copy-paper";

const snap = (entries: Snapshot["entries"], ts = 1_000_000_000_000): Snapshot => ({ ts, iso: "t0", entries });

describe("evaluateForward — grade a prior consensus vs realized price (no lookahead)", () => {
  it("a LONG consensus that rose, and a SHORT that fell, both score positive copyRet", () => {
    const prior = snap([{ coin: "BTC", netNotional: 100_000, price: 60_000 }, { coin: "ETH", netNotional: -50_000, price: 2_000 }]);
    const now: Record<string, number> = { BTC: 63_000, ETH: 1_900 }; // BTC +5% (long ✓), ETH −5% (short ✓)
    const e = evaluateForward(prior, (c) => now[c], prior.ts + 86_400_000);
    expect(e.nEval).toBe(2);
    expect(e.perCoin[0].copyRet).toBeCloseTo(0.05, 6);   // long BTC, +5%
    expect(e.perCoin[1].copyRet).toBeCloseTo(0.05, 6);   // short ETH, −5% price → +5% copy
    expect(e.hitRate).toBe(1);
    expect(e.horizonHours).toBeCloseTo(24, 6);
  });

  it("a LONG consensus that FELL scores negative (the signal was wrong)", () => {
    const e = evaluateForward(snap([{ coin: "BTC", netNotional: 100_000, price: 60_000 }]), () => 57_000, 1_000_000_000_000 + 3_600_000);
    expect(e.perCoin[0].copyRet).toBeCloseTo(-0.05, 6);
    expect(e.perCoin[0].correct).toBe(false);
    expect(e.hitRate).toBe(0);
  });

  it("portfolioRet is |notional|-weighted across coins", () => {
    const prior = snap([{ coin: "BTC", netNotional: 900_000, price: 60_000 }, { coin: "ETH", netNotional: 100_000, price: 2_000 }]);
    const now: Record<string, number> = { BTC: 66_000, ETH: 1_800 }; // BTC long +10%, ETH long −10%
    const e = evaluateForward(prior, (c) => now[c], prior.ts + 3_600_000);
    // 0.9·(+0.10) + 0.1·(−0.10) = 0.09 − 0.01 = 0.08
    expect(e.portfolioRet).toBeCloseTo(0.08, 6);
  });

  it("skips entries with no current price, zero net, or bad prior price", () => {
    const prior = snap([{ coin: "BTC", netNotional: 0, price: 60_000 }, { coin: "X", netNotional: 1, price: 0 }, { coin: "ETH", netNotional: 100, price: 2_000 }]);
    const e = evaluateForward(prior, (c) => (c === "ETH" ? 2_100 : undefined), prior.ts + 3_600_000);
    expect(e.nEval).toBe(1);
    expect(e.perCoin[0].coin).toBe("ETH");
  });

  it("empty / no-priceable consensus is safe (zero, no throw)", () => {
    const e = evaluateForward(snap([]), () => 1, 1_000_000_000_001);
    expect(e).toMatchObject({ nEval: 0, portfolioRet: 0, hitRate: 0 });
  });
});

describe("trackRecord — the accumulating OOS answer", () => {
  it("compounds portfolio returns and averages hit rate over snapshots with data", () => {
    const t = trackRecord([{ portfolioRet: 0.02, hitRate: 1, nEval: 2 }, { portfolioRet: -0.01, hitRate: 0.5, nEval: 2 }, { portfolioRet: 0, hitRate: 0, nEval: 0 }]);
    expect(t.n).toBe(2);                                  // the nEval=0 snapshot is ignored
    expect(t.meanRet).toBeCloseTo((0.02 - 0.01) / 2, 9);
    expect(t.hitRate).toBeCloseTo((1 + 0.5) / 2, 9);
    expect(t.cumRet).toBeCloseTo(1.02 * 0.99 - 1, 9);
  });
});
