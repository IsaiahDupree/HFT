import { describe, expect, it } from "vitest";
import { detectConsensus, type ConsensusTrade } from "@/lib/wallets/consensus";

function tradeIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function t(wallet: string, marketKey: string, direction: string, opts: Partial<ConsensusTrade> = {}): ConsensusTrade {
  return {
    proxyWallet: wallet,
    trustTier: 1,
    marketKey,
    marketTitle: marketKey,
    direction,
    usd: 100,
    price: 0.5,
    ts: tradeIso(5),
    ...opts,
  };
}

describe("detectConsensus", () => {
  it("returns empty when below minWallets", () => {
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals).toEqual([]);
  });

  it("fires a signal when minWallets is met", () => {
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].wallets).toHaveLength(3);
    expect(signals[0].direction).toBe("YES");
  });

  it("dedups multiple trades per wallet (counts each wallet once)", () => {
    const signals = detectConsensus(
      [
        t("w1", "m1", "Yes"),
        t("w1", "m1", "Yes"), // duplicate
        t("w1", "m1", "Yes"), // duplicate
        t("w2", "m1", "Yes"),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    // Only 2 distinct wallets — should NOT fire
    expect(signals).toEqual([]);
  });

  it("separates by direction (Yes vs No on same market are distinct buckets)", () => {
    const signals = detectConsensus(
      [
        t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes"),
        t("w4", "m1", "No"), t("w5", "m1", "No"), t("w6", "m1", "No"),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.direction).sort()).toEqual(["NO", "YES"]);
  });

  it("filters out trades older than windowMinutes", () => {
    const signals = detectConsensus(
      [
        t("w1", "m1", "Yes", { ts: tradeIso(60) }), // 60 min ago
        t("w2", "m1", "Yes", { ts: tradeIso(5) }),
        t("w3", "m1", "Yes", { ts: tradeIso(5) }),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    // Only 2 wallets inside the 30-min window
    expect(signals).toEqual([]);
  });

  it("respects minCombinedTrust", () => {
    const signals = detectConsensus(
      [
        t("w1", "m1", "Yes", { trustTier: 1 }),
        t("w2", "m1", "Yes", { trustTier: 1 }),
        t("w3", "m1", "Yes", { trustTier: 1 }),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 10 },
    );
    // Combined trust = 3, below threshold 10
    expect(signals).toEqual([]);
  });

  it("respects minCombinedUsd", () => {
    const signals = detectConsensus(
      [
        t("w1", "m1", "Yes", { usd: 50 }),
        t("w2", "m1", "Yes", { usd: 50 }),
        t("w3", "m1", "Yes", { usd: 50 }),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, minCombinedUsd: 500 },
    );
    expect(signals).toEqual([]);
  });

  it("ranks signals by combinedTrust, then combinedUsd", () => {
    const signals = detectConsensus(
      [
        t("w1", "low-trust-mkt", "Yes", { trustTier: 1 }),
        t("w2", "low-trust-mkt", "Yes", { trustTier: 1 }),
        t("w3", "low-trust-mkt", "Yes", { trustTier: 1 }),

        t("w4", "high-trust-mkt", "Yes", { trustTier: 5 }),
        t("w5", "high-trust-mkt", "Yes", { trustTier: 5 }),
        t("w6", "high-trust-mkt", "Yes", { trustTier: 5 }),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals[0].marketKey).toBe("high-trust-mkt");
    expect(signals[1].marketKey).toBe("low-trust-mkt");
  });
});
