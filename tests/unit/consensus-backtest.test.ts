import { describe, expect, it } from "vitest";
import { backtestConsensusSignals } from "../../src/lib/wallets/consensus-backtest";
import type { ConsensusSignal } from "../../src/lib/wallets/consensus";
import type { ResolvedMarket } from "../../src/lib/wallets/copy-backtest";

const yesWon = (cond: string): ResolvedMarket => ({
  conditionId: cond, winningIndex: 0, outcomePayouts: [1, 0], clobTokenIds: ["y", "n"],
});
const noWon = (cond: string): ResolvedMarket => ({
  conditionId: cond, winningIndex: 1, outcomePayouts: [0, 1], clobTokenIds: ["y", "n"],
});

const baseSig = (over: Partial<ConsensusSignal>): ConsensusSignal => ({
  marketKey: "0xc1",
  direction: "Yes",
  wallets: [{ proxyWallet: "0xw1", trustTier: 1, usd: 100, ts: "2026-01-01T00:00:00Z" }],
  combinedTrust: 1,
  combinedUsd: 100,
  walletCount: 1,
  effectiveWallets: 1,
  clusterIds: ["0xw1"],
  avgPrice: 0.5,
  windowStart: "2026-01-01T00:00:00Z",
  windowEnd: "2026-01-01T01:00:00Z",
  ...over,
});

describe("backtestConsensusSignals", () => {
  it("scores bullish 'Yes' signal at $0.40 as a winning copy when YES wins", () => {
    const sigs = [baseSig({ marketKey: "0xc1", direction: "Yes", avgPrice: 0.40 })];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", yesWon("0xc1")]]), {
      slippageBpsTiers: [0], minDistinctSignals: 1,
    });
    expect(r.signals_used).toBe(1);
    expect(r.buckets[0].pnl_usd).toBeCloseTo(150, 1); // (1-0.40)/0.40 × 100 = 150
    expect(r.buckets[0].win_rate).toBe(1);
  });

  it("scores 'No' direction as bearish (= buy NO at 1-p)", () => {
    // direction "No", avgPrice = 0.30 (i.e. wallets bought NO at $0.30 = the YES-side mid was 0.70)
    // Wait — the signal records avgPrice as the BUY-side price for the wallet's direction.
    // In our model: bearish on outcome 0 → buy outcome 1 at (1 − avgPrice).
    // If the signal says direction=No and avgPrice=0.7 (meaning they bought NO at 0.30), we
    // interpret entry as (1 - 0.7) = 0.3.
    const sigs = [baseSig({ marketKey: "0xc1", direction: "No", avgPrice: 0.70 })];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", noWon("0xc1")]]), {
      slippageBpsTiers: [0], minDistinctSignals: 1,
    });
    // NO wins → bearish copy wins. Entry = 1-0.70 = 0.30 → payout = (1-0.30)/0.30 = 2.333…
    expect(r.buckets[0].pnl_usd).toBeCloseTo(233.33, 1);
    expect(r.buckets[0].win_rate).toBe(1);
  });

  it("scores bullish signal as a loss when YES doesn't win", () => {
    const sigs = [baseSig({ marketKey: "0xc1", direction: "Yes", avgPrice: 0.60 })];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", noWon("0xc1")]]), {
      slippageBpsTiers: [0], minDistinctSignals: 1,
    });
    expect(r.buckets[0].pnl_usd).toBeCloseTo(-100, 1);
    expect(r.buckets[0].win_rate).toBe(0);
  });

  it("counts unresolved markets separately from indecipherable directions", () => {
    const sigs = [
      baseSig({ marketKey: "0xunknown", direction: "Yes" }),       // unresolved
      baseSig({ marketKey: "0xc1", direction: "??UNKNOWN??" }),    // indecipherable
      baseSig({ marketKey: "0xc1", direction: "Yes", avgPrice: 0.40 }), // used
    ];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", yesWon("0xc1")]]));
    expect(r.signals_skipped_unresolved).toBe(1);
    expect(r.signals_skipped_indecipherable).toBe(1);
    expect(r.signals_used).toBe(1);
  });

  it("verdict='insufficient_data' when distinct resolved signals < minDistinctSignals", () => {
    const sigs = [baseSig({ marketKey: "0xc1", direction: "Yes", avgPrice: 0.40 })];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", yesWon("0xc1")]]), { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("insufficient_data");
  });

  it("verdict='profitable' on a profitable batch ≥ minDistinctSignals", () => {
    const markets = new Map<string, ResolvedMarket>();
    const sigs: ConsensusSignal[] = [];
    for (let i = 0; i < 5; i++) {
      const c = `0xm${i}`;
      markets.set(c, yesWon(c));
      sigs.push(baseSig({ marketKey: c, direction: "Yes", avgPrice: 0.40 }));
    }
    const r = backtestConsensusSignals(sigs, markets, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("profitable");
  });

  it("higher slippage tiers strictly reduce PnL", () => {
    const sigs = Array.from({ length: 3 }, (_, i) => baseSig({ marketKey: "0xc1", direction: "Yes", avgPrice: 0.40 }));
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", yesWon("0xc1")]]), {
      slippageBpsTiers: [0, 100, 500], minDistinctSignals: 1,
    });
    expect(r.buckets[0].pnl_usd).toBeGreaterThan(r.buckets[1].pnl_usd);
    expect(r.buckets[1].pnl_usd).toBeGreaterThan(r.buckets[2].pnl_usd);
  });

  it("directionMode='outcome_index' uses raw '0'/'1' direction labels", () => {
    const sigs = [baseSig({ marketKey: "0xc1", direction: "0", avgPrice: 0.40 })];
    const r = backtestConsensusSignals(sigs, new Map([["0xc1", yesWon("0xc1")]]), {
      slippageBpsTiers: [0], directionMode: "outcome_index", minDistinctSignals: 1,
    });
    expect(r.signals_used).toBe(1);
    expect(r.buckets[0].pnl_usd).toBeCloseTo(150, 1);
  });
});
