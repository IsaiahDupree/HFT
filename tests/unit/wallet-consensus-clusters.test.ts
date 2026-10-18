/**
 * Cluster-aware consensus signal tests — verifies that providing a cluster
 * map collapses same-cluster wallets into a single effective vote, and that
 * the minEffectiveWallets gate works as expected.
 */
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

describe("detectConsensus — cluster awareness", () => {
  it("effectiveWallets equals walletCount when no clusters provided (back-compat)", () => {
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].walletCount).toBe(3);
    expect(signals[0].effectiveWallets).toBe(3);
    expect(signals[0].clusterIds.sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("collapses same-cluster wallets into one effective vote", () => {
    // 3 wallets, but w1 and w2 belong to the same cluster "C1"
    const clusters = new Map([
      ["w1", "C1"],
      ["w2", "C1"],
      ["w3", "C2"],
    ]);
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, clusters },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].walletCount).toBe(3);
    expect(signals[0].effectiveWallets).toBe(2); // C1 and C2
    expect(signals[0].clusterIds.sort()).toEqual(["C1", "C2"]);
  });

  it("accepts plain object as cluster lookup (not just Map)", () => {
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      {
        windowMinutes: 30,
        minWallets: 3,
        minCombinedTrust: 0,
        clusters: { w1: "C1", w2: "C1", w3: "C2" },
      },
    );
    expect(signals[0].effectiveWallets).toBe(2);
  });

  it("wallets not in the cluster map are treated as their own unique cluster", () => {
    const clusters = new Map([["w1", "C1"], ["w2", "C1"]]);
    // w3 not in map — should be its own effective vote
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, clusters },
    );
    expect(signals[0].effectiveWallets).toBe(2); // C1 (w1+w2) + w3
  });

  it("minEffectiveWallets filters out signals dominated by one cluster", () => {
    // 4 wallets all same cluster → effectiveWallets = 1
    const clusters = new Map([
      ["w1", "C1"], ["w2", "C1"], ["w3", "C1"], ["w4", "C1"],
    ]);
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes"), t("w4", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, clusters, minEffectiveWallets: 2 },
    );
    expect(signals).toEqual([]);
  });

  it("sorts signals by effectiveWallets first when comparing across markets", () => {
    // Market A: 4 raw wallets all same cluster (effective=1)
    // Market B: 3 raw wallets all distinct clusters (effective=3)
    const clusters = new Map([
      ["wA1", "CA"], ["wA2", "CA"], ["wA3", "CA"], ["wA4", "CA"],
      ["wB1", "CB1"], ["wB2", "CB2"], ["wB3", "CB3"],
    ]);
    const signals = detectConsensus(
      [
        t("wA1", "mA", "Yes"), t("wA2", "mA", "Yes"), t("wA3", "mA", "Yes"), t("wA4", "mA", "Yes"),
        t("wB1", "mB", "Yes"), t("wB2", "mB", "Yes"), t("wB3", "mB", "Yes"),
      ],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, clusters },
    );
    expect(signals).toHaveLength(2);
    // Market B should come first — more independent agreements
    expect(signals[0].marketKey).toBe("mB");
    expect(signals[0].effectiveWallets).toBe(3);
    expect(signals[1].marketKey).toBe("mA");
    expect(signals[1].effectiveWallets).toBe(1);
  });

  it("each wallet record carries the cluster ID when clusters are provided", () => {
    const clusters = { w1: "C1", w2: "C1", w3: "C2" };
    const signals = detectConsensus(
      [t("w1", "m1", "Yes"), t("w2", "m1", "Yes"), t("w3", "m1", "Yes")],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0, clusters },
    );
    for (const w of signals[0].wallets) {
      expect(w.clusterId).toBeDefined();
    }
    expect(signals[0].wallets.find((w) => w.proxyWallet === "w1")!.clusterId).toBe("C1");
    expect(signals[0].wallets.find((w) => w.proxyWallet === "w3")!.clusterId).toBe("C2");
  });
});
