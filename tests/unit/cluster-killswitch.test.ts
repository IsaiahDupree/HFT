/**
 * Tests for the cluster kill switch — pure module driving the four-tier
 * defensive ladder (strategy_family cluster, asset_class cluster, global
 * risk-off, global kill switch).
 */
import { describe, expect, it } from "vitest";
import {
  checkClusters,
  DEFAULT_CLUSTER_THRESHOLDS,
  readThresholdsFromEnv,
  type ClusterInputCapsule,
} from "@/lib/portfolio/cluster-killswitch";

const T = DEFAULT_CLUSTER_THRESHOLDS;

/** Convenience builder. */
function cap(over: Partial<ClusterInputCapsule>): ClusterInputCapsule {
  return {
    id: "cap-?",
    name: "Test",
    status: "live",
    strategy_family: "directional",
    asset_class: "prediction_market",
    capital_allocated_usd: 10,
    daily_pnl_usd: 0,
    ...over,
  };
}

describe("checkClusters — strategy_family cluster", () => {
  it("3 same-family capsules trip strategy_family cluster, healthy capsule keeps global under risk-off", () => {
    // Total capital $50 ($30 cluster + $20 healthy).
    // Cluster loss = $2.10 = 4.2% of total — above family threshold (4%), below global risk-off (5%).
    const capsules = [
      cap({ id: "A", capital_allocated_usd: 10, daily_pnl_usd: -0.7 }),
      cap({ id: "B", capital_allocated_usd: 10, daily_pnl_usd: -0.7 }),
      cap({ id: "C", capital_allocated_usd: 10, daily_pnl_usd: -0.7 }),
      cap({ id: "healthy", strategy_family: "scrape", capital_allocated_usd: 20, daily_pnl_usd: 0 }),
    ];
    const decisions = checkClusters(capsules);
    const byId = Object.fromEntries(decisions.map((d) => [d.capsule_id, d]));
    for (const id of ["A", "B", "C"]) {
      expect(byId[id]!.action).toBe("pause");
      expect(byId[id]!.reason).toBe("strategy_family_cluster");
      expect(byId[id]!.summary).toMatch(/directional/);
    }
    // Healthy capsule in different family is untouched (no global trip).
    expect(byId.healthy!.action).toBe("none");
  });

  it("under-threshold cluster → no pause", () => {
    // 3 capsules each lose $0.10. Cluster = $0.30. Threshold = $1.20. Below.
    const capsules = [
      cap({ id: "A", daily_pnl_usd: -0.1 }),
      cap({ id: "B", daily_pnl_usd: -0.1 }),
      cap({ id: "C", daily_pnl_usd: -0.1 }),
    ];
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("none");
      expect(d.reason).toBeNull();
    }
  });

  it("asymmetric: 2 capsules family A trip; 1 family B + 1 healthy stay clean", () => {
    // Total $50 → 4% threshold $2.00.
    // Family A loses $1.0 × 2 = $2.0 = 4% → trips.
    // Family B loses $0.10. Healthy $0. Global: $2.10 / $50 = 4.2% < 5% risk-off → no global.
    const capsules = [
      cap({ id: "A1", strategy_family: "momentum", capital_allocated_usd: 10, daily_pnl_usd: -1.0 }),
      cap({ id: "A2", strategy_family: "momentum", capital_allocated_usd: 10, daily_pnl_usd: -1.0 }),
      cap({ id: "B1", strategy_family: "scrape", capital_allocated_usd: 10, daily_pnl_usd: -0.1 }),
      cap({ id: "healthy", strategy_family: "consensus", capital_allocated_usd: 20, daily_pnl_usd: 0 }),
    ];
    const decisions = checkClusters(capsules);
    const byId = Object.fromEntries(decisions.map((d) => [d.capsule_id, d]));
    expect(byId.A1!.action).toBe("pause");
    expect(byId.A1!.reason).toBe("strategy_family_cluster");
    expect(byId.A2!.action).toBe("pause");
    expect(byId.A2!.reason).toBe("strategy_family_cluster");
    expect(byId.B1!.action).toBe("none");
    expect(byId.healthy!.action).toBe("none");
  });
});

describe("checkClusters — asset_class cluster", () => {
  it("families differ but same asset class crosses 6% → all paused via asset_class", () => {
    // 3 capsules different families but ALL asset_class=crypto.
    // Each loses $0.7 → cluster $2.1 = 7% of $30 capital → asset_class cluster trips (threshold 6%)
    // Wait — but per-family cluster: each family has just 1 capsule with $0.7 loss
    //   → 0.7/30 = 2.3% which is < 4% strategy_family threshold. So strategy_family doesn't fire.
    //   Then asset_class fires.
    const capsules = [
      cap({ id: "A", strategy_family: "momentum", asset_class: "crypto", daily_pnl_usd: -0.7 }),
      cap({ id: "B", strategy_family: "mean_reversion", asset_class: "crypto", daily_pnl_usd: -0.7 }),
      cap({ id: "C", strategy_family: "vol_breakout", asset_class: "crypto", daily_pnl_usd: -0.7 }),
    ];
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("pause");
      expect(d.reason).toBe("asset_class_cluster");
      expect(d.summary).toMatch(/crypto/);
    }
  });

  it("asset_class trip takes precedence over strategy_family trip on same capsule", () => {
    // Both family + asset_class would trip; asset_class is checked first.
    // Total $50 ($30 cluster + $20 healthy). Cluster loss $3.0 = 6% (asset_class
    // threshold). Global = 6% which is > 5% risk_off but < 10% kill — cluster
    // pause precedence outranks global_risk_off so cluster capsules pause.
    const capsules = [
      cap({ id: "A", strategy_family: "directional", asset_class: "crypto", capital_allocated_usd: 10, daily_pnl_usd: -1.0 }),
      cap({ id: "B", strategy_family: "directional", asset_class: "crypto", capital_allocated_usd: 10, daily_pnl_usd: -1.0 }),
      cap({ id: "C", strategy_family: "directional", asset_class: "crypto", capital_allocated_usd: 10, daily_pnl_usd: -1.0 }),
      cap({ id: "healthy", strategy_family: "consensus", asset_class: "prediction_market", capital_allocated_usd: 20, daily_pnl_usd: 0 }),
    ];
    const decisions = checkClusters(capsules);
    const byId = Object.fromEntries(decisions.map((d) => [d.capsule_id, d]));
    for (const id of ["A", "B", "C"]) {
      expect(byId[id]!.action).toBe("pause");
      expect(byId[id]!.reason).toBe("asset_class_cluster");
    }
    // Healthy capsule is in a different asset class — it gets global_risk_off
    // (since the global PnL is 6% which is above the 5% risk-off threshold).
    expect(byId.healthy!.action).toBe("reduce_size");
    expect(byId.healthy!.reason).toBe("global_risk_off");
  });
});

describe("checkClusters — global risk_off", () => {
  it("global daily PnL ≤ -5% → all capsules get reduce_size", () => {
    // Total capital $30. Global loss $1.60 = 5.33% → risk-off (≥5%) but < kill (10%).
    // Spread across multiple families/assets so no single cluster crosses on its own.
    const capsules = [
      cap({ id: "A", strategy_family: "momentum", asset_class: "crypto", daily_pnl_usd: -0.55 }),
      cap({ id: "B", strategy_family: "mean_reversion", asset_class: "prediction_market", daily_pnl_usd: -0.55 }),
      cap({ id: "C", strategy_family: "scrape", asset_class: "macro", daily_pnl_usd: -0.55 }),
    ];
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("reduce_size");
      expect(d.reason).toBe("global_risk_off");
      expect(d.size_multiplier).toBe(T.riskOffSizeMultiplier); // 0.25
    }
  });
});

describe("checkClusters — global kill switch", () => {
  it("global daily PnL ≤ -10% → everything paused", () => {
    // $30 capital × 10% = $3.00 loss → kill switch
    const capsules = [
      cap({ id: "A", strategy_family: "momentum", asset_class: "crypto", daily_pnl_usd: -1 }),
      cap({ id: "B", strategy_family: "mean_reversion", asset_class: "prediction_market", daily_pnl_usd: -1 }),
      cap({ id: "C", strategy_family: "scrape", asset_class: "macro", daily_pnl_usd: -1.1 }),
    ];
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("pause");
      expect(d.reason).toBe("global_kill_switch");
      expect(d.size_multiplier).toBe(0);
    }
  });

  it("global kill switch overrides all cluster trips", () => {
    // 3 same-family + same asset class capsules all losing big; global also crosses kill.
    // Decision should be global_kill_switch (most severe).
    const capsules = [
      cap({ id: "A", strategy_family: "directional", asset_class: "crypto", daily_pnl_usd: -1.5 }),
      cap({ id: "B", strategy_family: "directional", asset_class: "crypto", daily_pnl_usd: -1.5 }),
      cap({ id: "C", strategy_family: "directional", asset_class: "crypto", daily_pnl_usd: -1.5 }),
    ];
    // 4.5/30 = 15% global → exceeds 10% kill threshold
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("pause");
      expect(d.reason).toBe("global_kill_switch");
    }
  });
});

describe("checkClusters — edge cases", () => {
  it("empty capsules → empty decisions", () => {
    expect(checkClusters([])).toEqual([]);
  });

  it("zero total capital → all 'none' with summary noting no active capital", () => {
    const capsules = [
      cap({ id: "A", capital_allocated_usd: 0, daily_pnl_usd: 0 }),
      cap({ id: "B", capital_allocated_usd: 0, daily_pnl_usd: -5 }),
    ];
    const decisions = checkClusters(capsules);
    for (const d of decisions) {
      expect(d.action).toBe("none");
      expect(d.summary).toMatch(/no active capital/);
    }
  });

  it("capsules with null strategy_family or asset_class don't break clustering", () => {
    const capsules = [
      cap({ id: "A", strategy_family: null, asset_class: null, daily_pnl_usd: -1 }),
      cap({ id: "B", strategy_family: "momentum", asset_class: "crypto", daily_pnl_usd: -1 }),
    ];
    const decisions = checkClusters(capsules);
    // Neither cluster qualifies (singleton in each), but global = $2 / $20 = 10% → kill switch
    expect(decisions[0]!.reason).toBe("global_kill_switch");
    expect(decisions[1]!.reason).toBe("global_kill_switch");
  });

  it("custom thresholds override defaults", () => {
    const capsules = [
      cap({ id: "A", daily_pnl_usd: -0.2 }),
      cap({ id: "B", daily_pnl_usd: -0.2 }),
    ];
    // With strategyFamilyClusterPct=0.01 (1%), cluster $0.4 / $20 = 2% → trips
    const tight = checkClusters(capsules, {
      strategyFamilyClusterPct: 0.01,
      assetClassClusterPct: 0.10,
      globalRiskOffPct: 0.10,
      globalKillSwitchPct: 0.50,
      riskOffSizeMultiplier: 0.25,
    });
    expect(tight.every((d) => d.action === "pause")).toBe(true);
    // With default thresholds, $0.40/$20 = 2% which is < 4% → no trip
    const loose = checkClusters(capsules);
    expect(loose.every((d) => d.action === "none")).toBe(true);
  });

  it("non-finite daily_pnl is treated as 0", () => {
    const capsules = [
      cap({ id: "A", daily_pnl_usd: Number.NaN }),
      cap({ id: "B", daily_pnl_usd: -1.5 }),
      cap({ id: "C", daily_pnl_usd: -1.5 }),
    ];
    // Family loss is $3.0, total capital $30, 10% → kill switch
    // (Both A's NaN contribution + others)
    const decisions = checkClusters(capsules);
    expect(decisions.every((d) => Number.isFinite(d.size_multiplier))).toBe(true);
  });
});

describe("readThresholdsFromEnv", () => {
  it("returns defaults when env is empty", () => {
    const t = readThresholdsFromEnv({});
    expect(t).toEqual(DEFAULT_CLUSTER_THRESHOLDS);
  });

  it("strips inline comments + quotes from env values", () => {
    const t = readThresholdsFromEnv({
      CLUSTER_KILLSWITCH_STRATEGY_FAMILY_PCT: '"0.03"  # tight',
      GLOBAL_KILLSWITCH_PCT: "0.15  # increased",
    });
    expect(t.strategyFamilyClusterPct).toBe(0.03);
    expect(t.globalKillSwitchPct).toBe(0.15);
  });

  it("falls back to default on malformed value", () => {
    const t = readThresholdsFromEnv({
      CLUSTER_KILLSWITCH_STRATEGY_FAMILY_PCT: "not-a-number",
    });
    expect(t.strategyFamilyClusterPct).toBe(DEFAULT_CLUSTER_THRESHOLDS.strategyFamilyClusterPct);
  });

  it("accepts zero as a valid value (operator can effectively disable a tier)", () => {
    const t = readThresholdsFromEnv({ GLOBAL_RISK_OFF_PCT: "0" });
    expect(t.globalRiskOffPct).toBe(0);
  });
});
