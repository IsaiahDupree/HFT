/**
 * Resolution-pickup test — validates the loop the user is operationally
 * waiting on: when a consensus signal's market *transitions* from unresolved
 * to resolved, the next `consensus:backtest` run should pick it up and the
 * verdict should change accordingly.
 *
 * Pure: we drive the backtester with two snapshots of `resolvedByCondition`
 * (before and after the imagined resolution) using the same signal list.
 */
import { describe, expect, it } from "vitest";
import { backtestConsensusSignals } from "../../src/lib/wallets/consensus-backtest";
import type { ConsensusSignal } from "../../src/lib/wallets/consensus";
import type { ResolvedMarket } from "../../src/lib/wallets/copy-backtest";

function sig(over: Partial<ConsensusSignal>): ConsensusSignal {
  return {
    marketKey: "0xc1", direction: "Yes",
    wallets: [{ proxyWallet: "0xw1", trustTier: 1, usd: 100, ts: "2026-01-01T00:00:00Z" }],
    combinedTrust: 1, combinedUsd: 100, walletCount: 1, effectiveWallets: 1,
    clusterIds: ["0xw1"], avgPrice: 0.5,
    windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-01T01:00:00Z",
    ...over,
  };
}
const yesWon = (cond: string): ResolvedMarket => ({
  conditionId: cond, winningIndex: 0, outcomePayouts: [1, 0], clobTokenIds: ["y", "n"],
});

describe("Resolution pickup — verdict flips when markets resolve", () => {
  // Five distinct historical consensus signals, all bullish "Yes" at $0.40.
  // Identical signal list across the two runs — only the resolved set changes.
  const signals = Array.from({ length: 5 }, (_, i) =>
    sig({ marketKey: `0xmkt${i}`, direction: "Yes", avgPrice: 0.40 }),
  );

  it("returns INSUFFICIENT_DATA when none of the signal markets have resolved", () => {
    const r = backtestConsensusSignals(signals, new Map(), { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("insufficient_data");
    expect(r.signals_used).toBe(0);
    expect(r.signals_skipped_unresolved).toBe(5);
  });

  it("still INSUFFICIENT_DATA when only some markets have resolved (below threshold)", () => {
    // Resolve 3 of 5 → still below the gate (default = 5).
    const partial = new Map([
      ["0xmkt0", yesWon("0xmkt0")],
      ["0xmkt1", yesWon("0xmkt1")],
      ["0xmkt2", yesWon("0xmkt2")],
    ]);
    const r = backtestConsensusSignals(signals, partial, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("insufficient_data");
    expect(r.signals_used).toBe(3);
    expect(r.verdict.n_distinct_signals).toBe(3);
  });

  it("flips to PROFITABLE once all 5 resolve in the bullish direction", () => {
    const allResolved = new Map(signals.map((s) => [s.marketKey, yesWon(s.marketKey)]));
    const r = backtestConsensusSignals(signals, allResolved, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("profitable");
    expect(r.signals_used).toBe(5);
    expect(r.verdict.n_distinct_signals).toBe(5);
    expect(r.best_pnl_usd).toBeGreaterThan(0);
  });

  it("flips to LOSS when all 5 resolve AGAINST the bullish bet", () => {
    const noWon = (cond: string): ResolvedMarket => ({
      conditionId: cond, winningIndex: 1, outcomePayouts: [0, 1], clobTokenIds: ["y", "n"],
    });
    const allLost = new Map(signals.map((s) => [s.marketKey, noWon(s.marketKey)]));
    const r = backtestConsensusSignals(signals, allLost, { minDistinctSignals: 5 });
    expect(r.verdict.rating).toBe("loss");
    expect(r.signals_used).toBe(5);
  });

  it("verdict transition is monotonic with respect to additional resolutions", () => {
    // Adding more (favorable) resolutions must never reduce pnl_pct.
    const stepped = (k: number) => {
      const m = new Map<string, ResolvedMarket>();
      for (let i = 0; i < k; i++) m.set(`0xmkt${i}`, yesWon(`0xmkt${i}`));
      return backtestConsensusSignals(signals, m, { minDistinctSignals: 5, slippageBpsTiers: [0] }).buckets[0].pnl_usd;
    };
    const a = stepped(0);
    const b = stepped(2);
    const c = stepped(5);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });
});
