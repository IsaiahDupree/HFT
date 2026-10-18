/**
 * Tests for the Global Risk Governor (Phase 9).
 *
 * Covers each veto rule in isolation + edge cases:
 *   - reserve capsule reject (hard rule)
 *   - same-trade collision (reject + cap_size)
 *   - correlated-exposure cap (reject + cap_size)
 *   - strategy-family allocation cap
 *   - reserve floor (hard floor 0.25 — env cannot zero out)
 *   - happy path approval
 *   - edge cases (zero capital, no open positions)
 */
import { describe, expect, it } from "vitest";
import {
  checkPortfolioImpact,
  DEFAULT_GOVERNOR_THRESHOLDS,
  readGovernorThresholdsFromEnv,
  RESERVE_PCT_HARD_FLOOR,
  type CapsuleSnapshot,
  type GovernorInputs,
  type GovernorProposal,
  type PortfolioPosition,
} from "@/lib/portfolio/governor";

const T = DEFAULT_GOVERNOR_THRESHOLDS;

function mkCapsule(over: Partial<CapsuleSnapshot> = {}): CapsuleSnapshot {
  return {
    id: "cap-A",
    status: "live",
    strategy_family: "directional",
    asset_class: "prediction_market",
    capital_allocated_usd: 10,
    ...over,
  };
}

function mkProposal(over: Partial<GovernorProposal> = {}): GovernorProposal {
  return {
    capsule_id: "cap-A",
    strategy_family: "directional",
    asset_class: "prediction_market",
    asset: "BTC",
    side: "BUY",
    size_usd: 2,
    time_horizon: "5m",
    ...over,
  };
}

function inputs(over: Partial<GovernorInputs> = {}): GovernorInputs {
  return {
    proposal: mkProposal(),
    capsules: [mkCapsule()],
    openPositions: [],
    thresholds: T,
    ...over,
  };
}

describe("Governor — reserve capsule", () => {
  it("rejects every proposal from a reserve capsule", () => {
    const r = checkPortfolioImpact(inputs({
      proposal: mkProposal({ strategy_family: "reserve" }),
    }));
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("reserve_capsule");
  });

  it("reserve veto runs before any other check (even with collision present)", () => {
    const r = checkPortfolioImpact(inputs({
      proposal: mkProposal({ strategy_family: "reserve" }),
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 4, time_horizon: "5m" },
      ],
    }));
    expect(r.reason).toBe("reserve_capsule");
  });
});

describe("Governor — same-trade collision", () => {
  it("rejects when other capsule already at single-trade cap on same (asset, side, horizon)", () => {
    const r = checkPortfolioImpact(inputs({
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
    }));
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("same_trade_collision");
    expect(r.summary).toMatch(/BTC/);
  });

  it("cap_size when there's partial headroom under cap", () => {
    // Other capsule at $3, proposal $2, total $5 = cap. Cap proposal to $2 = headroom.
    const r = checkPortfolioImpact(inputs({
      proposal: mkProposal({ size_usd: 4 }),
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
      ],
    }));
    expect(r.action).toBe("cap_size");
    expect(r.reason).toBe("same_trade_collision");
    expect(r.cap_size_usd).toBeCloseTo(2, 2);
  });

  it("no collision when other capsule on DIFFERENT asset", () => {
    // Use larger total capital so the correlation cap doesn't fire as a
    // side-effect — this test specifically isolates the collision rule.
    const r = checkPortfolioImpact(inputs({
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other", capital_allocated_usd: 100, strategy_family: "scrape" }),
      ],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "ETH", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
    }));
    expect(r.action).toBe("approve");
  });

  it("no collision when proposing capsule itself already has a position (self-stack OK)", () => {
    // Larger total capital so correlation cap doesn't fire.
    const r = checkPortfolioImpact(inputs({
      proposal: mkProposal({ size_usd: 2 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other", capital_allocated_usd: 100, strategy_family: "scrape" }),
      ],
      openPositions: [
        { capsule_id: "cap-A", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
      ],
    }));
    expect(r.action).toBe("approve");
  });

  it("collision matches across different time_horizons when proposal has no horizon", () => {
    const r = checkPortfolioImpact(inputs({
      proposal: mkProposal({ size_usd: 4, time_horizon: undefined }),
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
      ],
    }));
    expect(r.action).toBe("cap_size");
  });
});

describe("Governor — correlated exposure cap", () => {
  it("rejects when same-class same-side exposure already at cap", () => {
    // Active capital $30, cap 30% = $9. Existing exposure $9 → no headroom.
    // Need a different asset to avoid collision rule firing first.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "SOL", size_usd: 2 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-B", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-C", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-B", asset_class: "prediction_market", asset: "ETH", side: "BUY", size_usd: 5, time_horizon: "5m" },
        { capsule_id: "cap-C", asset_class: "prediction_market", asset: "XRP", side: "BUY", size_usd: 4, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("correlated_exposure_cap");
  });

  it("cap_size when there's headroom under exposure cap", () => {
    // Active capital $30, cap 30% = $9. Existing exposure $5. Headroom $4.
    // Proposal $5 → cap to $4.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "SOL", size_usd: 5 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-B", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-C", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-B", asset_class: "prediction_market", asset: "ETH", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("cap_size");
    expect(r.reason).toBe("correlated_exposure_cap");
    expect(r.cap_size_usd).toBeCloseTo(4, 2);
  });

  it("opposite side doesn't contribute to exposure", () => {
    // Active capital $30, cap 30% = $9. SELL existing $9, BUY proposal $4 → approved.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "SOL", size_usd: 4 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-B", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-C", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-B", asset_class: "prediction_market", asset: "ETH", side: "SELL", size_usd: 9, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
  });
});

describe("Governor — strategy-family cap", () => {
  it("rejects when family already over-allocated", () => {
    // Active capital $30, family cap 25% = $7.50. Directional family has $20 (4 capsules × $5).
    // Proposal in same family → reject.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 5 }),
        mkCapsule({ id: "cap-B", strategy_family: "directional", capital_allocated_usd: 5 }),
        mkCapsule({ id: "cap-C", strategy_family: "directional", capital_allocated_usd: 5 }),
        mkCapsule({ id: "cap-D", strategy_family: "directional", capital_allocated_usd: 5 }),
        mkCapsule({ id: "cap-other", strategy_family: "scrape", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("strategy_family_cap");
    expect(r.summary).toMatch(/directional/);
  });

  it("approves when family within cap", () => {
    // Active capital $40, family cap 25% = $10. Directional has $10 exactly → at cap, allow.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other-1", strategy_family: "scrape", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other-2", strategy_family: "consensus", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other-3", strategy_family: "market_making", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
  });
});

describe("Governor — reserve floor (hard)", () => {
  it("readGovernorThresholdsFromEnv floors ARENA_RESERVE_PCT at 0.25", () => {
    const t = readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "0" });
    expect(t.reservePct).toBe(RESERVE_PCT_HARD_FLOOR);
  });

  it("env value above 0.25 is honored", () => {
    const t = readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "0.60" });
    expect(t.reservePct).toBe(0.60);
  });

  it("env value below 0.25 is raised to 0.25 (cannot disable reserve)", () => {
    const t = readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "0.10" });
    expect(t.reservePct).toBe(RESERVE_PCT_HARD_FLOOR);
  });

  it("strips inline comments + quotes", () => {
    const t = readGovernorThresholdsFromEnv({ MAX_CORRELATED_EXPOSURE_PCT: '"0.40" # operator override' });
    expect(t.maxCorrelatedExposurePct).toBe(0.40);
  });

  it("malformed env values fall back to defaults", () => {
    const t = readGovernorThresholdsFromEnv({ MAX_CORRELATED_EXPOSURE_PCT: "garbage" });
    expect(t.maxCorrelatedExposurePct).toBe(DEFAULT_GOVERNOR_THRESHOLDS.maxCorrelatedExposurePct);
  });
});

describe("Governor — happy path + edge cases", () => {
  it("approves clean proposal with no collisions / no over-exposure", () => {
    const r = checkPortfolioImpact(inputs());
    expect(r.action).toBe("approve");
    expect(r.reason).toBe("ok");
  });

  it("approves when total active capital is zero (no capsules to govern)", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal(),
      capsules: [],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
    expect(r.summary).toMatch(/no active capital/);
  });

  it("reserve-family capsules are excluded from active-capital denominator", () => {
    // Reserve capsule has $1000 but is excluded — active capital = $30.
    // Family-cap 25% = $7.50 → directional has $10 → over cap → reject.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        { id: "cap-reserve", status: "live", strategy_family: "reserve", asset_class: "prediction_market", capital_allocated_usd: 1000 },
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other-1", strategy_family: "scrape", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-other-2", strategy_family: "consensus", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("strategy_family_cap");
  });

  it("paused / stopped capsules don't count toward family or active capital", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 10, status: "paused" }),
        mkCapsule({ id: "cap-B", strategy_family: "directional", capital_allocated_usd: 10, status: "stopped" }),
        mkCapsule({ id: "cap-C", strategy_family: "directional", capital_allocated_usd: 10, status: "live" }),
        mkCapsule({ id: "cap-other", strategy_family: "scrape", capital_allocated_usd: 30, status: "live" }),
      ],
      openPositions: [],
      thresholds: T,
    });
    // Active capital = $10 + $30 = $40. Directional family active = $10 = 25% — at cap, OK.
    expect(r.action).toBe("approve");
  });
});
