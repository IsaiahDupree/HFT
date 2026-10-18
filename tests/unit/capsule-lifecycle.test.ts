/**
 * Tests for the capsule lifecycle module (Phase 10).
 *
 * Covers each precedence rule:
 *   - Drawdown breach → freeze (overrides everything else)
 *   - Sustained loss_overlap at full_live → demote to degraded
 *   - Correlation veto blocks promotion
 *   - Negative PnL blocks promotion past micro_live
 *   - Happy path: enough trades + low correlation + positive PnL → promote
 *   - Terminal stages (frozen / retired) → hold
 *   - Stage normalization (legacy 'live' → full_live)
 */
import { describe, expect, it } from "vitest";
import {
  decideLifecycleAction,
  DEFAULT_LIFECYCLE_THRESHOLDS,
  isActiveStage,
  normalizeStage,
  readLifecycleThresholdsFromEnv,
  type LifecycleCapsule,
} from "@/lib/portfolio/lifecycle";

const T = DEFAULT_LIFECYCLE_THRESHOLDS;

function cap(over: Partial<LifecycleCapsule>): LifecycleCapsule {
  return {
    id: "cap-A",
    stage: "paper",
    capital_allocated_usd: 10,
    current_pnl_usd: 0,
    trades_count: 0,
    loss_overlap: null,
    max_pair_corr: null,
    drawdown_pct: 0,
    ...over,
  };
}

describe("normalizeStage", () => {
  it("maps legacy 'live' → full_live", () => {
    expect(normalizeStage("live")).toBe("full_live");
  });
  it("maps legacy 'draft' → idea", () => {
    expect(normalizeStage("draft")).toBe("idea");
  });
  it("passes through new stages", () => {
    expect(normalizeStage("micro_live")).toBe("micro_live");
    expect(normalizeStage("probation_live")).toBe("probation_live");
    expect(normalizeStage("degraded")).toBe("degraded");
  });
  it("null/undefined → idea", () => {
    expect(normalizeStage(null)).toBe("idea");
    expect(normalizeStage(undefined)).toBe("idea");
  });
});

describe("isActiveStage", () => {
  it("paper, micro_live, probation_live, full_live, degraded are active", () => {
    for (const s of ["paper", "micro_live", "probation_live", "full_live", "degraded"] as const) {
      expect(isActiveStage(s)).toBe(true);
    }
  });
  it("idea, backtest, frozen, retired, paused are NOT active", () => {
    for (const s of ["idea", "backtest", "frozen", "retired", "paused"] as const) {
      expect(isActiveStage(s)).toBe(false);
    }
  });
});

describe("decideLifecycleAction — drawdown freeze", () => {
  it("freezes when drawdown crosses cap (overrides everything)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: 0.60,
      trades_count: 100,
      max_pair_corr: 0.10, // low corr, would otherwise be fine
      current_pnl_usd: 50,
    }));
    expect(d.action).toBe("freeze");
    expect(d.next_stage).toBe("frozen");
    expect(d.reason).toMatch(/drawdown/);
  });

  it("does NOT freeze a non-active stage even on high drawdown", () => {
    const d = decideLifecycleAction(cap({
      stage: "paused",
      drawdown_pct: 0.60,
    }));
    expect(d.action).not.toBe("freeze");
  });
});

describe("decideLifecycleAction — loss_overlap demote", () => {
  it("demotes full_live → degraded when loss_overlap above threshold", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      loss_overlap: 0.85,
      trades_count: 100,
      current_pnl_usd: 50,
      drawdown_pct: 0.10,
    }));
    expect(d.action).toBe("demote");
    expect(d.next_stage).toBe("degraded");
    expect(d.reason).toMatch(/loss_overlap/);
  });

  it("does NOT demote when loss_overlap below threshold", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      loss_overlap: 0.40,
      trades_count: 100,
      current_pnl_usd: 50,
    }));
    expect(d.action).not.toBe("demote");
  });

  it("does NOT demote a stage below full_live", () => {
    const d = decideLifecycleAction(cap({
      stage: "probation_live",
      loss_overlap: 0.85,
      trades_count: 100,
    }));
    expect(d.action).not.toBe("demote");
  });

  it("treats null loss_overlap as 'unknown — don't demote'", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      loss_overlap: null,
      trades_count: 100,
      current_pnl_usd: 50,
    }));
    expect(d.action).not.toBe("demote");
  });
});

describe("decideLifecycleAction — correlation veto on promote", () => {
  it("blocks promotion when max_pair_corr above threshold", () => {
    const d = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: 10, // ≥ minTradesMicro (5)
      max_pair_corr: 0.80, // > 0.55 threshold
      current_pnl_usd: 5,
    }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/too similar/);
  });

  it("allows promotion when max_pair_corr below threshold", () => {
    const d = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: 10,
      max_pair_corr: 0.30,
      current_pnl_usd: 5,
    }));
    expect(d.action).toBe("promote");
    expect(d.next_stage).toBe("micro_live");
  });

  it("treats null max_pair_corr as 'no data yet — don't block'", () => {
    const d = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: 10,
      max_pair_corr: null,
      current_pnl_usd: 5,
    }));
    expect(d.action).toBe("promote");
  });
});

describe("decideLifecycleAction — PnL gate on promote past micro_live", () => {
  it("blocks promotion from micro_live with negative PnL", () => {
    const d = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 30, // ≥ minTradesProbation
      max_pair_corr: 0.20,
      current_pnl_usd: -2,
    }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/PnL/);
  });

  it("allows promotion with non-negative PnL", () => {
    const d = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 30,
      max_pair_corr: 0.20,
      current_pnl_usd: 0,
    }));
    expect(d.action).toBe("promote");
    expect(d.next_stage).toBe("probation_live");
  });

  it("paper → micro_live doesn't require positive PnL (first promotion lenient)", () => {
    const d = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: 10,
      max_pair_corr: 0.20,
      current_pnl_usd: -1, // negative but still gets promoted from paper
    }));
    expect(d.action).toBe("promote");
  });
});

describe("decideLifecycleAction — promotion ladder", () => {
  it("paper (≥5 trades) → micro_live", () => {
    const d = decideLifecycleAction(cap({ stage: "paper", trades_count: 5, max_pair_corr: 0.30 }));
    expect(d.next_stage).toBe("micro_live");
  });

  it("micro_live (≥20 trades + positive PnL + low corr) → probation_live", () => {
    const d = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 20,
      max_pair_corr: 0.30,
      current_pnl_usd: 5,
    }));
    expect(d.next_stage).toBe("probation_live");
  });

  it("probation_live (≥50 trades + positive PnL + low corr) → full_live", () => {
    const d = decideLifecycleAction(cap({
      stage: "probation_live",
      trades_count: 50,
      max_pair_corr: 0.30,
      current_pnl_usd: 10,
    }));
    expect(d.next_stage).toBe("full_live");
  });

  it("full_live with no demote conditions → hold (top of ladder)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      trades_count: 200,
      loss_overlap: 0.20,
      current_pnl_usd: 50,
      drawdown_pct: 0.10,
    }));
    expect(d.action).toBe("hold");
    expect(d.next_stage).toBeNull();
  });

  it("trades count below threshold → hold with descriptive reason", () => {
    const d = decideLifecycleAction(cap({ stage: "paper", trades_count: 3, max_pair_corr: 0.30 }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/3 trades < 5/);
  });
});

describe("decideLifecycleAction — terminal stages", () => {
  it("frozen → hold", () => {
    const d = decideLifecycleAction(cap({ stage: "frozen", trades_count: 100, max_pair_corr: 0.20 }));
    expect(d.action).toBe("hold");
  });

  it("retired → hold", () => {
    const d = decideLifecycleAction(cap({ stage: "retired", trades_count: 100 }));
    expect(d.action).toBe("hold");
  });
});

describe("readLifecycleThresholdsFromEnv", () => {
  it("returns defaults on empty env", () => {
    expect(readLifecycleThresholdsFromEnv({})).toEqual(DEFAULT_LIFECYCLE_THRESHOLDS);
  });

  it("strips inline comments", () => {
    const t = readLifecycleThresholdsFromEnv({
      LIFECYCLE_MAX_CORR_PROMOTE: "0.40 # tighter",
    });
    expect(t.maxCorrPromote).toBe(0.40);
  });

  it("falls back on malformed values", () => {
    const t = readLifecycleThresholdsFromEnv({
      LIFECYCLE_LOSS_OVERLAP_DEMOTE: "not-a-number",
    });
    expect(t.lossOverlapDemote).toBe(T.lossOverlapDemote);
  });
});
