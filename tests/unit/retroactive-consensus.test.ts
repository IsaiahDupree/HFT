import { describe, expect, it } from "vitest";
import {
  detectRetroactiveConsensus, scoreRetroactiveSignals,
  type ClosedPositionInput,
} from "../../src/lib/wallets/retroactive-consensus";

function pos(over: Partial<ClosedPositionInput>): ClosedPositionInput {
  return {
    proxyWallet: "0xw1",
    trustTier: 1,
    conditionId: "0xc1",
    outcomeIndex: 0,
    avgPrice: 0.5,
    curPrice: 1,
    totalBought: 100,
    ...over,
  };
}

describe("detectRetroactiveConsensus", () => {
  it("emits a signal when ≥minWallets distinct wallets bet on the same outcome", () => {
    const positions = [
      pos({ proxyWallet: "0xw1", conditionId: "0xc1", outcomeIndex: 0, avgPrice: 0.40, curPrice: 1 }),
      pos({ proxyWallet: "0xw2", conditionId: "0xc1", outcomeIndex: 0, avgPrice: 0.45, curPrice: 1 }),
      pos({ proxyWallet: "0xw3", conditionId: "0xc1", outcomeIndex: 0, avgPrice: 0.42, curPrice: 1 }),
    ];
    const sigs = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1 });
    expect(sigs.length).toBe(1);
    expect(sigs[0].walletCount).toBe(3);
    expect(sigs[0].won).toBe(true);
    // VWAP across $100 × 3 at prices 0.40, 0.45, 0.42 → (0.40+0.45+0.42)/3 = 0.4233
    expect(sigs[0].consensusAvgPrice).toBeCloseTo((0.40 + 0.45 + 0.42) / 3, 2);
  });

  it("separates same-market positions by outcomeIndex (BUY YES ≠ BUY NO)", () => {
    const positions = [
      pos({ proxyWallet: "0xw1", outcomeIndex: 0, curPrice: 1 }),
      pos({ proxyWallet: "0xw2", outcomeIndex: 0, curPrice: 1 }),
      pos({ proxyWallet: "0xw3", outcomeIndex: 1, curPrice: 0 }),
      pos({ proxyWallet: "0xw4", outcomeIndex: 1, curPrice: 0 }),
    ];
    const sigs = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1 });
    expect(sigs.length).toBe(2);
    const yes = sigs.find((s) => s.outcomeIndex === 0);
    const no = sigs.find((s) => s.outcomeIndex === 1);
    expect(yes?.won).toBe(true);
    expect(no?.won).toBe(false); // YES won → NO side lost
  });

  it("collapses same-wallet duplicate rows into one wallet entry with VWAP price", () => {
    // Same wallet has TWO closed-position rows on the same outcome (slugged across batches).
    const positions = [
      pos({ proxyWallet: "0xw1", avgPrice: 0.40, totalBought: 100, curPrice: 1 }),
      pos({ proxyWallet: "0xw1", avgPrice: 0.50, totalBought: 100, curPrice: 1 }),
      pos({ proxyWallet: "0xw2", avgPrice: 0.45, totalBought: 100, curPrice: 1 }),
    ];
    const sigs = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1 });
    expect(sigs.length).toBe(1);
    expect(sigs[0].walletCount).toBe(2); // 2 distinct wallets, not 3 rows
    const w1 = sigs[0].wallets.find((w) => w.proxyWallet === "0xw1");
    expect(w1?.totalBought).toBe(200);  // summed
    expect(w1?.avgPrice).toBeCloseTo(0.45, 3); // VWAP of 0.40 and 0.50 weighted equally
  });

  it("rejects malformed positions (avgPrice ≤0 or ≥1, missing fields)", () => {
    const positions: ClosedPositionInput[] = [
      pos({ proxyWallet: "0xw1", avgPrice: 0 }),         // zero price
      pos({ proxyWallet: "0xw2", avgPrice: 1.0 }),       // ≥1
      pos({ proxyWallet: "0xw3", conditionId: "" }),     // empty market
    ];
    const sigs = detectRetroactiveConsensus(positions, { minWallets: 1, minCombinedTrust: 1 });
    expect(sigs.length).toBe(0);
  });

  it("filters by minCombinedTrust and minCombinedUsd", () => {
    const positions = [
      pos({ proxyWallet: "0xw1", trustTier: 1, totalBought: 50 }),
      pos({ proxyWallet: "0xw2", trustTier: 1, totalBought: 50 }),
    ];
    const tooLowTrust = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 5 });
    expect(tooLowTrust.length).toBe(0);
    const tooLowUsd = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1, minCombinedUsd: 500 });
    expect(tooLowUsd.length).toBe(0);
    const passes = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1, minCombinedUsd: 50 });
    expect(passes.length).toBe(1);
  });

  it("sorts signals by combinedTrust × combinedUsd descending", () => {
    const positions = [
      // signal A: 2 wallets × trust 1 × $50 each = combined 2 × $100 = 200
      pos({ proxyWallet: "0xa1", trustTier: 1, conditionId: "0xA", totalBought: 50 }),
      pos({ proxyWallet: "0xa2", trustTier: 1, conditionId: "0xA", totalBought: 50 }),
      // signal B: 2 wallets × trust 2 × $500 each = combined 4 × $1000 = 4000
      pos({ proxyWallet: "0xb1", trustTier: 2, conditionId: "0xB", totalBought: 500 }),
      pos({ proxyWallet: "0xb2", trustTier: 2, conditionId: "0xB", totalBought: 500 }),
    ];
    const sigs = detectRetroactiveConsensus(positions, { minWallets: 2, minCombinedTrust: 1 });
    expect(sigs[0].conditionId).toBe("0xB"); // larger × heavier first
    expect(sigs[1].conditionId).toBe("0xA");
  });
});

describe("scoreRetroactiveSignals", () => {
  function signal(over: Partial<{ consensusAvgPrice: number; won: boolean }>) {
    return {
      conditionId: "0xc" + Math.random().toString(36).slice(2, 8),
      outcomeIndex: 0,
      won: over.won ?? true,
      wallets: [],
      combinedTrust: 2,
      combinedUsd: 200,
      walletCount: 2,
      consensusAvgPrice: over.consensusAvgPrice ?? 0.4,
    };
  }

  it("scores a winning bullish consensus at avg=0.40 as +150% per copy at 0bps", () => {
    const sig = signal({ consensusAvgPrice: 0.40, won: true });
    const r = scoreRetroactiveSignals([sig], { slippageBpsTiers: [0], sizeUsd: 100, minDistinctSignals: 1 });
    expect(r.buckets[0].pnl_usd).toBeCloseTo(150, 1);
    expect(r.buckets[0].win_rate).toBe(1);
  });

  it("scores a losing consensus as −$100 per copy", () => {
    const sig = signal({ consensusAvgPrice: 0.60, won: false });
    const r = scoreRetroactiveSignals([sig], { slippageBpsTiers: [0], sizeUsd: 100, minDistinctSignals: 1 });
    expect(r.buckets[0].pnl_usd).toBeCloseTo(-100, 1);
  });

  it("verdict is 'insufficient_data' until signals reach minDistinctSignals", () => {
    const sigs = [signal({ won: true }), signal({ won: true })];
    const r = scoreRetroactiveSignals(sigs, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("insufficient_data");
  });

  it("verdict flips to 'profitable' on a positive batch above the gate", () => {
    const sigs = Array.from({ length: 5 }, () => signal({ won: true, consensusAvgPrice: 0.40 }));
    const r = scoreRetroactiveSignals(sigs, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("profitable");
  });

  it("higher slippage strictly reduces winning PnL", () => {
    const sigs = Array.from({ length: 3 }, () => signal({ won: true, consensusAvgPrice: 0.40 }));
    const r = scoreRetroactiveSignals(sigs, { slippageBpsTiers: [0, 100, 500], minDistinctSignals: 1 });
    expect(r.buckets[0].pnl_usd).toBeGreaterThan(r.buckets[1].pnl_usd);
    expect(r.buckets[1].pnl_usd).toBeGreaterThan(r.buckets[2].pnl_usd);
  });
});
