import { describe, it, expect } from "vitest";
import { walletStatsFromClosed, verifyWalletStats, type ClosedPositionRow } from "@/lib/wallets/wallet-verification";
import { detectConsensus, type ConsensusTrade } from "@/lib/wallets/consensus";

describe("walletStatsFromClosed", () => {
  it("sums realized PnL, counts resolved, computes win rate from curPrice", () => {
    const rows: ClosedPositionRow[] = [{ realizedPnl: 100, curPrice: 1 }, { realizedPnl: 50, curPrice: 1 }, { realizedPnl: -30, curPrice: 0 }];
    const s = walletStatsFromClosed(rows);
    expect(s.realizedPnlUsd).toBe(120);
    expect(s.nResolved).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
  });
  it("empty is safe", () => { expect(walletStatsFromClosed([])).toEqual({ realizedPnlUsd: 0, nResolved: 0, winRate: 0 }); });
});

describe("verifyWalletStats — real realized profit over enough resolved markets", () => {
  it("verifies a genuinely profitable wallet with a track record", () => {
    expect(verifyWalletStats({ realizedPnlUsd: 5_000, nResolved: 20, winRate: 0.6 }).verified).toBe(true);
  });
  it("rejects too-thin a track record (can't tell)", () => {
    expect(verifyWalletStats({ realizedPnlUsd: 5_000, nResolved: 4, winRate: 1 }).verified).toBe(false);
  });
  it("rejects a NOT-actually-profitable wallet even with many markets", () => {
    expect(verifyWalletStats({ realizedPnlUsd: -2_000, nResolved: 50, winRate: 0.8 }).verified).toBe(false); // 80% win but loses money
  });
});

describe("detectConsensus — verifiedWallets gate drops unverified votes", () => {
  const now = new Date().toISOString();
  const trade = (w: string, dir = "Yes"): ConsensusTrade => ({ proxyWallet: w, trustTier: 2, marketKey: "m1", direction: dir, usd: 100, price: 0.5, ts: now });
  it("a 3-wallet signal collapses to insufficient when 2 wallets are unverified", () => {
    const trades = [trade("0xA"), trade("0xB"), trade("0xC")];
    const open = { windowMinutes: 1440, minWallets: 3, minCombinedTrust: 3 };
    expect(detectConsensus(trades, open)).toHaveLength(1);                                   // all 3 vote → fires
    expect(detectConsensus(trades, { ...open, verifiedWallets: new Set(["0xA"]) })).toHaveLength(0); // only 1 verified → no signal
    expect(detectConsensus(trades, { ...open, verifiedWallets: new Set(["0xA", "0xB", "0xC"]) })).toHaveLength(1); // all verified → fires
  });
});
