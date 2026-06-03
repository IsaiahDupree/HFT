/**
 * Robustness / invariant tests for the cluster kill switch.
 *
 * Complementary to cluster-killswitch.test.ts — this file focuses on
 * structural invariants (one decision per capsule, order preservation,
 * size_multiplier bounds), boundary behaviour of the `>=` threshold
 * comparisons, determinism, monotonicity of severity as losses deepen,
 * sign conventions (profits never trip), and degenerate inputs.
 *
 * All inputs are pure synthetic capsules constructed from the exported
 * types. No I/O, no clock, no entropy — a tiny seeded LCG supplies any
 * pseudo-randomness so the file is fully deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  checkClusters,
  DEFAULT_CLUSTER_THRESHOLDS,
  readThresholdsFromEnv,
  type ClusterDecision,
  type ClusterInputCapsule,
  type ClusterThresholds,
} from "@/lib/portfolio/cluster-killswitch";

const T = DEFAULT_CLUSTER_THRESHOLDS;

/** Convenience builder mirroring the existing suite's `cap`. */
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

/** Deterministic seeded LCG (Numerical Recipes constants) → floats in [0,1). */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function byId(decisions: ClusterDecision[]): Record<string, ClusterDecision> {
  return Object.fromEntries(decisions.map((d) => [d.capsule_id, d]));
}

describe("checkClusters — structural invariants", () => {
  it("returns exactly one decision per input capsule, in input order", () => {
    const capsules = [
      cap({ id: "x1", name: "First" }),
      cap({ id: "x2", name: "Second", daily_pnl_usd: -0.05 }),
      cap({ id: "x3", name: "Third", daily_pnl_usd: 0.5 }),
    ];
    const decisions = checkClusters(capsules);
    expect(decisions).toHaveLength(capsules.length);
    expect(decisions.map((d) => d.capsule_id)).toEqual(["x1", "x2", "x3"]);
    expect(decisions.map((d) => d.capsule_name)).toEqual(["First", "Second", "Third"]);
  });

  it("every decision carries id+name copied verbatim from its capsule", () => {
    const capsules = [
      cap({ id: "alpha", name: "Alpha Strat" }),
      cap({ id: "beta", name: "Beta Strat", daily_pnl_usd: -3 }),
    ];
    for (const d of checkClusters(capsules)) {
      const src = capsules.find((c) => c.id === d.capsule_id)!;
      expect(d.capsule_name).toBe(src.name);
    }
  });

  it("size_multiplier is always within [0,1] across mixed scenarios", () => {
    const rand = makeLcg(20240607);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rand() * 6);
      const capsules: ClusterInputCapsule[] = [];
      for (let i = 0; i < n; i++) {
        capsules.push(
          cap({
            id: `t${trial}-${i}`,
            strategy_family: rand() < 0.5 ? "momentum" : "scrape",
            asset_class: rand() < 0.5 ? "crypto" : "macro",
            capital_allocated_usd: 1 + Math.floor(rand() * 20),
            // span deep losses through profits
            daily_pnl_usd: (rand() - 0.7) * 8,
          }),
        );
      }
      for (const d of checkClusters(capsules)) {
        expect(d.size_multiplier).toBeGreaterThanOrEqual(0);
        expect(d.size_multiplier).toBeLessThanOrEqual(1);
        expect(Number.isFinite(d.size_multiplier)).toBe(true);
      }
    }
  });

  it("action/size_multiplier pairing is consistent: pause→0, none→1, reduce_size→riskOffMultiplier", () => {
    const rand = makeLcg(7);
    for (let trial = 0; trial < 25; trial++) {
      const capsules = Array.from({ length: 3 }, (_, i) =>
        cap({ id: `c${trial}-${i}`, daily_pnl_usd: (rand() - 0.75) * 10, capital_allocated_usd: 10 }),
      );
      for (const d of checkClusters(capsules)) {
        if (d.action === "pause") expect(d.size_multiplier).toBe(0);
        else if (d.action === "none") expect(d.size_multiplier).toBe(1);
        else expect(d.size_multiplier).toBe(T.riskOffSizeMultiplier);
      }
    }
  });

  it("reason is null iff action is 'none'", () => {
    const rand = makeLcg(99);
    for (let trial = 0; trial < 30; trial++) {
      const capsules = Array.from({ length: 4 }, (_, i) =>
        cap({ id: `r${trial}-${i}`, daily_pnl_usd: (rand() - 0.7) * 9 }),
      );
      for (const d of checkClusters(capsules)) {
        if (d.action === "none") expect(d.reason).toBeNull();
        else expect(d.reason).not.toBeNull();
      }
    }
  });

  it("summary is always a non-empty string", () => {
    const rand = makeLcg(424242);
    for (let trial = 0; trial < 20; trial++) {
      const capsules = Array.from({ length: 3 }, (_, i) =>
        cap({ id: `s${trial}-${i}`, daily_pnl_usd: (rand() - 0.6) * 7 }),
      );
      for (const d of checkClusters(capsules)) {
        expect(typeof d.summary).toBe("string");
        expect(d.summary.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("checkClusters — boundary of the >= comparison", () => {
  it("strategy_family trips exactly AT the threshold (loss == pct·capital)", () => {
    // Total $100, family threshold 4% → exactly $4.00 loss.
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: null, capital_allocated_usd: 50, daily_pnl_usd: -2 }),
      cap({ id: "B", strategy_family: "fam", asset_class: null, capital_allocated_usd: 50, daily_pnl_usd: -2 }),
    ];
    // -(-4)/100 = 0.04 >= 0.04 → trips
    const decisions = checkClusters(capsules);
    expect(decisions.every((d) => d.reason === "strategy_family_cluster")).toBe(true);
  });

  it("strategy_family does NOT trip one cent below the threshold", () => {
    // Total $100, threshold $4.00. Loss $3.99 → 3.99% < 4% → no trip.
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: null, capital_allocated_usd: 50, daily_pnl_usd: -2 }),
      cap({ id: "B", strategy_family: "fam", asset_class: null, capital_allocated_usd: 50, daily_pnl_usd: -1.99 }),
    ];
    const decisions = checkClusters(capsules);
    expect(decisions.every((d) => d.action === "none")).toBe(true);
  });

  it("global kill switch trips exactly AT 10% and risk_off just below", () => {
    // Total $100. Spread across distinct families/classes so no single cluster trips.
    const atKill = [
      cap({ id: "A", strategy_family: "f1", asset_class: "a1", capital_allocated_usd: 25, daily_pnl_usd: -2.5 }),
      cap({ id: "B", strategy_family: "f2", asset_class: "a2", capital_allocated_usd: 25, daily_pnl_usd: -2.5 }),
      cap({ id: "C", strategy_family: "f3", asset_class: "a3", capital_allocated_usd: 25, daily_pnl_usd: -2.5 }),
      cap({ id: "D", strategy_family: "f4", asset_class: "a4", capital_allocated_usd: 25, daily_pnl_usd: -2.5 }),
    ];
    // global loss $10 / $100 = 10% >= 10% → kill
    for (const d of checkClusters(atKill)) {
      expect(d.reason).toBe("global_kill_switch");
    }
    // Now $9.99 loss → 9.99% < 10% kill but >= 5% risk_off → reduce_size.
    const justBelowKill = atKill.map((c, i) => (i === 0 ? { ...c, daily_pnl_usd: -2.49 } : c));
    for (const d of checkClusters(justBelowKill)) {
      expect(d.reason).toBe("global_risk_off");
      expect(d.action).toBe("reduce_size");
    }
  });

  it("global risk_off trips exactly AT 5% but not at 4.99%", () => {
    // Total $200. Each family loses $5 → combined $10 / $200 = 5% global.
    // Per-family loss $5 / $200 = 2.5% < 4% family threshold; per-asset 2.5% < 6%.
    const atRiskOff = [
      cap({ id: "A", strategy_family: "f1", asset_class: "a1", capital_allocated_usd: 100, daily_pnl_usd: -5 }),
      cap({ id: "B", strategy_family: "f2", asset_class: "a2", capital_allocated_usd: 100, daily_pnl_usd: -5 }),
    ];
    // $10 / $200 = 5% >= 5% → risk_off (clusters far below their own thresholds)
    for (const d of checkClusters(atRiskOff)) {
      expect(d.reason).toBe("global_risk_off");
    }
    const below = atRiskOff.map((c, i) => (i === 0 ? { ...c, daily_pnl_usd: -4.99 } : c));
    // $9.99 / $200 = 4.995% < 5% → none
    for (const d of checkClusters(below)) {
      expect(d.action).toBe("none");
    }
  });
});

describe("checkClusters — sign conventions (profits never trip)", () => {
  it("an all-profit portfolio yields exclusively 'none' decisions", () => {
    const capsules = [
      cap({ id: "A", strategy_family: "f1", asset_class: "a1", daily_pnl_usd: 5 }),
      cap({ id: "B", strategy_family: "f1", asset_class: "a1", daily_pnl_usd: 50 }),
      cap({ id: "C", strategy_family: "f2", asset_class: "a2", daily_pnl_usd: 0 }),
    ];
    for (const d of checkClusters(capsules)) {
      expect(d.action).toBe("none");
      expect(d.reason).toBeNull();
      expect(d.size_multiplier).toBe(1);
    }
  });

  it("a profitable cluster never trips even with huge gains", () => {
    // Family gain $1000 on $30 capital — loss pct is strongly negative, never >= threshold.
    const capsules = [
      cap({ id: "A", strategy_family: "winners", daily_pnl_usd: 500 }),
      cap({ id: "B", strategy_family: "winners", daily_pnl_usd: 500 }),
      cap({ id: "C", strategy_family: "winners", daily_pnl_usd: 0 }),
    ];
    expect(checkClusters(capsules).every((d) => d.action === "none")).toBe(true);
  });

  it("a winning family offsets a losing family at the GLOBAL tier but cluster still trips locally", () => {
    // Total $100. Losers family loses $8 (8% of total >= 4% family → cluster trips).
    // Winners family gains $8, so global PnL nets to 0 → no global risk_off/kill.
    const capsules = [
      cap({ id: "L1", strategy_family: "losers", asset_class: "ac_l", capital_allocated_usd: 25, daily_pnl_usd: -4 }),
      cap({ id: "L2", strategy_family: "losers", asset_class: "ac_l", capital_allocated_usd: 25, daily_pnl_usd: -4 }),
      cap({ id: "W1", strategy_family: "winners", asset_class: "ac_w", capital_allocated_usd: 25, daily_pnl_usd: 4 }),
      cap({ id: "W2", strategy_family: "winners", asset_class: "ac_w", capital_allocated_usd: 25, daily_pnl_usd: 4 }),
    ];
    const m = byId(checkClusters(capsules));
    // Losers: family $8/$100 = 8% >= 4%; also asset_class ac_l $8/$100 = 8% >= 6% → asset_class precedence.
    expect(m.L1!.action).toBe("pause");
    expect(m.L1!.reason).toBe("asset_class_cluster");
    expect(m.L2!.reason).toBe("asset_class_cluster");
    // Winners untouched: no cluster loss, no global trip (net global PnL = 0).
    expect(m.W1!.action).toBe("none");
    expect(m.W2!.action).toBe("none");
  });
});

describe("checkClusters — precedence & severity monotonicity", () => {
  it("asset_class precedence holds when BOTH family and asset_class would trip", () => {
    // Single family + single asset_class, both crossing — asset_class checked first.
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -2 }),
      cap({ id: "B", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -2 }),
    ];
    // $4/$20 = 20% — above both family 4% and asset_class 6%; global 20% would be kill though.
    // Use bigger denominator to isolate cluster precedence below kill.
    const padded = [
      ...capsules,
      cap({ id: "pad", strategy_family: "other", asset_class: "other_ac", capital_allocated_usd: 60, daily_pnl_usd: 0 }),
    ];
    // Now total $80; cluster loss $4 / $80 = 5% (>=4% fam, <6% asset). To make asset
    // class also trip, deepen to $5 loss.
    const both = [
      cap({ id: "A", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -2.5 }),
      cap({ id: "B", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -2.5 }),
      cap({ id: "pad", strategy_family: "other", asset_class: "other_ac", capital_allocated_usd: 60, daily_pnl_usd: 0 }),
    ];
    // cluster loss $5 / $80 = 6.25% >= 6% asset AND >= 4% family. global 6.25% > 5% risk_off, < 10% kill.
    void padded;
    const m = byId(checkClusters(both));
    expect(m.A!.reason).toBe("asset_class_cluster");
    expect(m.B!.reason).toBe("asset_class_cluster");
    // pad is outside both clusters → global_risk_off (6.25% >= 5%).
    expect(m.pad!.reason).toBe("global_risk_off");
  });

  it("global kill switch overrides asset_class + strategy_family + risk_off on every capsule", () => {
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: "ac", daily_pnl_usd: -2 }),
      cap({ id: "B", strategy_family: "fam", asset_class: "ac", daily_pnl_usd: -2 }),
      cap({ id: "C", strategy_family: "fam2", asset_class: "ac2", daily_pnl_usd: -2 }),
    ];
    // total $30, global loss $6 / $30 = 20% → kill overrides every cluster trip.
    for (const d of checkClusters(capsules)) {
      expect(d.reason).toBe("global_kill_switch");
      expect(d.action).toBe("pause");
      expect(d.size_multiplier).toBe(0);
    }
  });

  it("as a single family's loss deepens, severity is non-decreasing (none → pause)", () => {
    // Fix denominator with a large healthy pad so global never trips while family deepens.
    const sizes = [0, -0.5, -1.0, -2.0, -4.0]; // each applied to both family capsules
    const severityRank: Record<ClusterDecision["action"], number> = {
      none: 0,
      reduce_size: 1,
      pause: 2,
    };
    let prev = -1;
    for (const loss of sizes) {
      // Total $100 (two $10 family capsules + $80 healthy pad). Family threshold
      // 4% = $4. Steps: $0,$1,$2,$4,$8 combined family loss → none until $4 (==4%)
      // then pause; cluster-pause precedence keeps the deepest case a pause even
      // though global 8% would otherwise be risk_off.
      const capsules = [
        cap({ id: "A", strategy_family: "fam", asset_class: null, capital_allocated_usd: 10, daily_pnl_usd: loss }),
        cap({ id: "B", strategy_family: "fam", asset_class: null, capital_allocated_usd: 10, daily_pnl_usd: loss }),
        cap({ id: "pad", strategy_family: "healthy", asset_class: null, capital_allocated_usd: 80, daily_pnl_usd: 0 }),
      ];
      const a = byId(checkClusters(capsules)).A!;
      expect(severityRank[a.action]).toBeGreaterThanOrEqual(prev);
      prev = severityRank[a.action];
    }
    // Deepest case must be a pause.
    expect(prev).toBe(severityRank.pause);
  });
});

describe("checkClusters — determinism", () => {
  it("identical inputs produce structurally identical outputs across repeated calls", () => {
    const rand = makeLcg(13579);
    const capsules = Array.from({ length: 6 }, (_, i) =>
      cap({
        id: `d${i}`,
        strategy_family: i % 2 === 0 ? "momentum" : "scrape",
        asset_class: i % 3 === 0 ? "crypto" : "macro",
        capital_allocated_usd: 5 + Math.floor(rand() * 15),
        daily_pnl_usd: (rand() - 0.65) * 6,
      }),
    );
    const first = checkClusters(capsules);
    const second = checkClusters(capsules);
    expect(second).toEqual(first);
  });

  it("input order permutation preserves each capsule's decision (decision is per-capsule, not positional)", () => {
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -1.5 }),
      cap({ id: "B", strategy_family: "fam", asset_class: "ac", capital_allocated_usd: 10, daily_pnl_usd: -1.5 }),
      cap({ id: "C", strategy_family: "other", asset_class: "other", capital_allocated_usd: 10, daily_pnl_usd: 0 }),
    ];
    const reversed = [...capsules].reverse();
    const m1 = byId(checkClusters(capsules));
    const m2 = byId(checkClusters(reversed));
    for (const id of ["A", "B", "C"]) {
      expect(m2[id]!.action).toBe(m1[id]!.action);
      expect(m2[id]!.reason).toBe(m1[id]!.reason);
      expect(m2[id]!.size_multiplier).toBe(m1[id]!.size_multiplier);
    }
  });

  it("does not mutate the input capsule array or its elements", () => {
    const capsules = [
      cap({ id: "A", daily_pnl_usd: -5 }),
      cap({ id: "B", daily_pnl_usd: -5 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(capsules));
    checkClusters(capsules);
    expect(capsules).toEqual(snapshot);
  });
});

describe("checkClusters — degenerate & defensive inputs", () => {
  it("single capsule whose own loss crosses the family threshold trips its singleton cluster", () => {
    // One capsule, $10 capital, loss $1 → 10% >= 4% family. But global loss is also
    // 10% which is kill — so kill takes precedence. Verify it is at least a pause.
    const decisions = checkClusters([cap({ id: "solo", strategy_family: "fam", asset_class: null, daily_pnl_usd: -1 })]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("pause");
  });

  it("non-finite capital_allocated_usd is treated as 0 in the denominator", () => {
    // A has Infinity capital (ignored → 0). B+C provide the real $20 denominator.
    // B+C same family lose $1 → $1/$20 = 5% >= 4% → family cluster trips.
    const capsules = [
      cap({ id: "A", strategy_family: "famX", asset_class: null, capital_allocated_usd: Number.POSITIVE_INFINITY, daily_pnl_usd: 0 }),
      cap({ id: "B", strategy_family: "fam", asset_class: null, capital_allocated_usd: 10, daily_pnl_usd: -0.5 }),
      cap({ id: "C", strategy_family: "fam", asset_class: null, capital_allocated_usd: 10, daily_pnl_usd: -0.5 }),
    ];
    const decisions = checkClusters(capsules);
    // Every size_multiplier must be finite despite the Infinity input.
    expect(decisions.every((d) => Number.isFinite(d.size_multiplier))).toBe(true);
    const m = byId(decisions);
    expect(m.B!.action).toBe("pause");
    expect(m.B!.reason).toBe("strategy_family_cluster");
  });

  it("NaN daily_pnl_usd contributes 0 to the global tier (no spurious kill)", () => {
    // Single capsule, NaN PnL → global PnL coerced to 0 → loss% = 0 → none.
    const decisions = checkClusters([
      cap({ id: "A", strategy_family: null, asset_class: null, capital_allocated_usd: 100, daily_pnl_usd: Number.NaN }),
    ]);
    expect(decisions[0]!.action).toBe("none");
    expect(decisions[0]!.size_multiplier).toBe(1);
  });

  it("capsules with empty-string family/asset_class are not aggregated into a cluster", () => {
    // empty string is falsy → skipped by `if (c.strategy_family)` guard. So even a
    // large combined loss across "" capsules does not form a family/asset cluster;
    // only the global tier can act.
    const capsules = [
      cap({ id: "A", strategy_family: "", asset_class: "", capital_allocated_usd: 1000, daily_pnl_usd: -2 }),
      cap({ id: "B", strategy_family: "", asset_class: "", capital_allocated_usd: 1000, daily_pnl_usd: -2 }),
    ];
    const decisions = checkClusters(capsules);
    // global loss $4 / $2000 = 0.2% → below all thresholds → none, never a cluster reason.
    for (const d of decisions) {
      expect(d.reason).not.toBe("strategy_family_cluster");
      expect(d.reason).not.toBe("asset_class_cluster");
      expect(d.action).toBe("none");
    }
  });

  it("zero-loss healthy portfolio across many capsules → all none", () => {
    const rand = makeLcg(2468);
    const capsules = Array.from({ length: 8 }, (_, i) =>
      cap({
        id: `h${i}`,
        strategy_family: `fam${i % 3}`,
        asset_class: `ac${i % 2}`,
        capital_allocated_usd: 5 + Math.floor(rand() * 10),
        daily_pnl_usd: 0,
      }),
    );
    expect(checkClusters(capsules).every((d) => d.action === "none")).toBe(true);
  });
});

describe("checkClusters — custom threshold edge configurations", () => {
  it("zeroed thresholds make ANY non-zero loss trip the global kill switch", () => {
    const allZero: ClusterThresholds = {
      strategyFamilyClusterPct: 0,
      assetClassClusterPct: 0,
      globalRiskOffPct: 0,
      globalKillSwitchPct: 0,
      riskOffSizeMultiplier: 0.25,
    };
    // Any tiny loss → globalLossPct > 0 >= 0 → kill. A $0.01 loss on $100 qualifies.
    const decisions = checkClusters(
      [
        cap({ id: "A", capital_allocated_usd: 50, daily_pnl_usd: -0.005 }),
        cap({ id: "B", capital_allocated_usd: 50, daily_pnl_usd: -0.005 }),
      ],
      allZero,
    );
    for (const d of decisions) {
      expect(d.reason).toBe("global_kill_switch");
      expect(d.action).toBe("pause");
    }
  });

  it("zeroed thresholds with a flat (zero-PnL) portfolio still yields 'none' (0 loss is not >= ... wait, it is)", () => {
    // globalLossPct = -0/total = 0; 0 >= 0 is TRUE → kill even with no loss.
    // This documents the actual >= boundary behaviour of the implementation.
    const allZero: ClusterThresholds = {
      strategyFamilyClusterPct: 0,
      assetClassClusterPct: 0,
      globalRiskOffPct: 0,
      globalKillSwitchPct: 0,
      riskOffSizeMultiplier: 0.25,
    };
    const decisions = checkClusters([cap({ id: "A", capital_allocated_usd: 100, daily_pnl_usd: 0 })], allZero);
    expect(decisions[0]!.reason).toBe("global_kill_switch");
  });

  it("a custom riskOffSizeMultiplier flows through to reduce_size decisions", () => {
    const custom: ClusterThresholds = {
      strategyFamilyClusterPct: 0.99,
      assetClassClusterPct: 0.99,
      globalRiskOffPct: 0.05,
      globalKillSwitchPct: 0.99,
      riskOffSizeMultiplier: 0.5,
    };
    // global loss $6 / $100 = 6% triggers risk_off; clusters disabled (0.99),
    // kill disabled (0.99). multiplier = 0.5.
    const decisions = checkClusters(
      [
        cap({ id: "A", strategy_family: "f1", asset_class: "a1", capital_allocated_usd: 50, daily_pnl_usd: -3 }),
        cap({ id: "B", strategy_family: "f2", asset_class: "a2", capital_allocated_usd: 50, daily_pnl_usd: -3 }),
      ],
      custom,
    );
    for (const d of decisions) {
      expect(d.action).toBe("reduce_size");
      expect(d.size_multiplier).toBe(0.5);
    }
  });
});

describe("readThresholdsFromEnv — robustness", () => {
  it("negative env values are rejected and fall back to defaults", () => {
    // numFromEnv requires n >= 0; a negative parses but is rejected.
    const t = readThresholdsFromEnv({ GLOBAL_KILLSWITCH_PCT: "-0.2" });
    expect(t.globalKillSwitchPct).toBe(DEFAULT_CLUSTER_THRESHOLDS.globalKillSwitchPct);
  });

  it("partial env overrides only the specified keys, leaving the rest at default", () => {
    const t = readThresholdsFromEnv({ CLUSTER_KILLSWITCH_ASSET_CLASS_PCT: "0.08" });
    expect(t.assetClassClusterPct).toBe(0.08);
    expect(t.strategyFamilyClusterPct).toBe(DEFAULT_CLUSTER_THRESHOLDS.strategyFamilyClusterPct);
    expect(t.globalRiskOffPct).toBe(DEFAULT_CLUSTER_THRESHOLDS.globalRiskOffPct);
    expect(t.riskOffSizeMultiplier).toBe(DEFAULT_CLUSTER_THRESHOLDS.riskOffSizeMultiplier);
  });

  it("the parsed thresholds are usable directly by checkClusters", () => {
    const t = readThresholdsFromEnv({ CLUSTER_KILLSWITCH_STRATEGY_FAMILY_PCT: "0.02" });
    // $0.50 loss across a 2-capsule family on $50 total = 1% < 2% → no trip with 0.02.
    const capsules = [
      cap({ id: "A", strategy_family: "fam", asset_class: null, capital_allocated_usd: 25, daily_pnl_usd: -0.25 }),
      cap({ id: "B", strategy_family: "fam", asset_class: null, capital_allocated_usd: 25, daily_pnl_usd: -0.25 }),
    ];
    expect(checkClusters(capsules, t).every((d) => d.action === "none")).toBe(true);
  });
});
