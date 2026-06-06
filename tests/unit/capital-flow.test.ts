import { describe, it, expect } from "vitest";
import { netCapitalFlow, flowDistortion, type LedgerUpdate } from "@/lib/exec/capital-flow";

const u = (type: string, usdc: number, time = 1): LedgerUpdate => ({ time, delta: { type, usdc: String(usdc) } });

describe("netCapitalFlow", () => {
  it("sums deposits and withdrawals (abs), ignores funding/rewards/borrow noise", () => {
    const f = netCapitalFlow([u("deposit", 10_000), u("withdraw", 4_000), u("rewardsClaim", 5), u("borrowLend", 9_000), u("withdraw", 1_000)]);
    expect(f.deposits).toBe(10_000);
    expect(f.withdrawals).toBe(5_000);
    expect(f.net).toBe(5_000);
    expect(f.nFlows).toBe(3);
  });
  it("handles the `amount` field and negative-signed values (abs)", () => {
    const f = netCapitalFlow([{ delta: { type: "withdraw", amount: -2500 } }]);
    expect(f.withdrawals).toBe(2500);
  });
  it("empty ledger is safe", () => {
    expect(netCapitalFlow([])).toEqual({ deposits: 0, withdrawals: 0, net: 0, nFlows: 0 });
  });
});

describe("flowDistortion", () => {
  it("flags a wallet that cashed out most of its capital (ROI-inflation / cash-out signal)", () => {
    // account now $20k but withdrew $180k → withdrew 90% of the $200k that was there
    const d = flowDistortion({ deposits: 0, withdrawals: 180_000, net: -180_000, nFlows: 4 }, 20_000);
    expect(d.distorted).toBe(true);
    expect(d.withdrawRatio).toBeCloseTo(180_000 / 200_000, 5);
    expect(d.reason).toMatch(/cash-out|inflated/);
  });
  it("does NOT flag a clean wallet with small flows", () => {
    const d = flowDistortion({ deposits: 5_000, withdrawals: 5_000, net: 0, nFlows: 2 }, 200_000);
    expect(d.distorted).toBe(false);
    expect(d.withdrawRatio).toBeCloseTo(5_000 / 205_000, 5);
  });
  it("respects a custom maxRatio threshold", () => {
    const flow = { deposits: 0, withdrawals: 30_000, net: -30_000, nFlows: 1 };
    expect(flowDistortion(flow, 70_000, 0.25).distorted).toBe(true);  // 30% > 25%
    expect(flowDistortion(flow, 70_000, 0.40).distorted).toBe(false); // 30% < 40%
  });
  it("a no-account no-withdrawal wallet isn't divided by zero", () => {
    expect(flowDistortion({ deposits: 0, withdrawals: 0, net: 0, nFlows: 0 }, 0).distorted).toBe(false);
  });
});
