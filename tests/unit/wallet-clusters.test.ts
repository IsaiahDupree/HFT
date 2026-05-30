import { describe, expect, it } from "vitest";
import { detectClusters, clusterMap, clusterOf, type ClusterTrade } from "@/lib/wallets/clusters";

const T0 = Date.parse("2026-05-25T12:00:00Z");

function tradeAt(wallet: string, marketKey: string, direction: string, minutesFromBase: number): ClusterTrade {
  return {
    proxyWallet: wallet,
    marketKey,
    direction,
    ts: new Date(T0 + minutesFromBase * 60_000).toISOString(),
  };
}

/**
 * Build N coordinated trades for one wallet: same markets, same directions,
 * same time buckets. Used to manufacture clusters in tests.
 */
function coordinatedSeries(wallet: string, jitterMin = 0): ClusterTrade[] {
  const markets = ["m1", "m2", "m3", "m4", "m5", "m6"];
  const dirs = ["YES", "NO", "YES", "YES", "NO", "YES"];
  return markets.map((m, i) => tradeAt(wallet, m, dirs[i], i * 10 + jitterMin));
}

describe("detectClusters", () => {
  it("returns no clusters when wallets share nothing", () => {
    const trades: ClusterTrade[] = [
      ...["m1", "m2", "m3", "m4", "m5"].map((m, i) => tradeAt("wA", m, "YES", i * 10)),
      ...["x1", "x2", "x3", "x4", "x5"].map((m, i) => tradeAt("wB", m, "YES", i * 10)),
    ];
    const clusters = detectClusters(trades);
    expect(clusters).toEqual([]);
  });

  it("clusters two wallets with identical trade signatures", () => {
    const trades = [
      ...coordinatedSeries("wA"),
      ...coordinatedSeries("wB"), // exact same signatures within same buckets
    ];
    const clusters = detectClusters(trades, { minSimilarity: 0.5 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.sort()).toEqual(["wA", "wB"]);
    expect(clusters[0].cohesion).toBeGreaterThan(0.9);
  });

  it("transitively merges A–B and B–C overlapping wallets into one cluster", () => {
    // A and B share 5 sigs; B and C share 5 sigs (different from A's); A and C share nothing
    const sharedAB = coordinatedSeries("placeholder").map((t) => ({ ...t, proxyWallet: "" }));
    const tradesA = coordinatedSeries("wA");
    const tradesB = coordinatedSeries("wB");
    const tradesC = coordinatedSeries("wC", 200); // jitter so wC's buckets differ from A
    // Make B also share wC's later-bucket sigs
    const tradesBPlusC = coordinatedSeries("wB", 200);
    const trades = [...tradesA, ...tradesB, ...tradesBPlusC, ...tradesC];
    const clusters = detectClusters(trades, { minSimilarity: 0.3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.sort()).toEqual(["wA", "wB", "wC"]);
  });

  it("does NOT cluster wallets whose overlap is below minSimilarity", () => {
    // wA and wB share 1 of 5 signatures = 1/9 ≈ 0.11 similarity
    const trades: ClusterTrade[] = [
      tradeAt("wA", "m1", "YES", 0),
      tradeAt("wA", "m2", "YES", 10),
      tradeAt("wA", "m3", "YES", 20),
      tradeAt("wA", "m4", "YES", 30),
      tradeAt("wA", "m5", "YES", 40),
      tradeAt("wB", "m1", "YES", 0), // shared
      tradeAt("wB", "x2", "YES", 10),
      tradeAt("wB", "x3", "YES", 20),
      tradeAt("wB", "x4", "YES", 30),
      tradeAt("wB", "x5", "YES", 40),
    ];
    const clusters = detectClusters(trades, { minSimilarity: 0.3 });
    expect(clusters).toEqual([]);
  });

  it("ignores wallets with fewer than minSignatures trades", () => {
    const trades: ClusterTrade[] = [
      ...coordinatedSeries("wA"),
      // wB only has 2 trades — under default minSignatures=5
      tradeAt("wB", "m1", "YES", 0),
      tradeAt("wB", "m2", "NO", 10),
    ];
    const clusters = detectClusters(trades);
    expect(clusters).toEqual([]);
  });

  it("time-bucket separation prevents accidental clustering", () => {
    // Same markets + directions, but 12 HOURS apart — different buckets, no cluster
    const trades = [
      ...coordinatedSeries("wA", 0),
      ...coordinatedSeries("wB", 12 * 60),
    ];
    const clusters = detectClusters(trades, { minSimilarity: 0.5, bucketMinutes: 5 });
    expect(clusters).toEqual([]);
  });

  it("invalid timestamps are skipped without crashing", () => {
    const trades = [
      ...coordinatedSeries("wA"),
      ...coordinatedSeries("wB"),
      { proxyWallet: "wC", marketKey: "m1", direction: "YES", ts: "not-an-iso" } as ClusterTrade,
    ];
    const clusters = detectClusters(trades, { minSimilarity: 0.5 });
    expect(clusters).toHaveLength(1);
  });

  it("ranks clusters by size, then cohesion", () => {
    // Cluster 1: wA + wB (high cohesion)
    // Cluster 2: wC + wD + wE (lower cohesion)
    const t1 = [...coordinatedSeries("wA"), ...coordinatedSeries("wB")];
    // wC, wD, wE each have 5+ trades, all share at least min similarity
    const sharedMarkets = ["mc1", "mc2", "mc3", "mc4", "mc5", "mc6"];
    const t2: ClusterTrade[] = [];
    for (const wallet of ["wC", "wD", "wE"]) {
      sharedMarkets.forEach((m, i) => {
        t2.push(tradeAt(wallet, m, "YES", 500 + i * 10));
      });
    }
    const trades = [...t1, ...t2];
    const clusters = detectClusters(trades, { minSimilarity: 0.5 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0].size).toBe(3); // larger cluster first
    expect(clusters[1].size).toBe(2);
  });

  it("clusterMap returns wallet → clusterId lookup", () => {
    const trades = [...coordinatedSeries("wA"), ...coordinatedSeries("wB")];
    const clusters = detectClusters(trades, { minSimilarity: 0.5 });
    const m = clusterMap(clusters);
    expect(m.get("wA")).toBeDefined();
    expect(m.get("wA")).toBe(m.get("wB"));
    expect(m.get("not-in-cluster")).toBeUndefined();
  });

  it("clusterOf returns the cluster containing a given wallet", () => {
    const trades = [...coordinatedSeries("wA"), ...coordinatedSeries("wB")];
    const clusters = detectClusters(trades, { minSimilarity: 0.5 });
    const c = clusterOf("wA", clusters);
    expect(c).not.toBeNull();
    expect(c!.members).toContain("wB");
    expect(clusterOf("wZ", clusters)).toBeNull();
  });
});
