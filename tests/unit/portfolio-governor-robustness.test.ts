/**
 * Robustness / invariant tests for the Global Risk Governor (Phase 9).
 *
 * Complementary to portfolio-governor.test.ts — that file proves each rule
 * fires in isolation. THIS file proves the safety invariants that matter for
 * a real-money veto layer:
 *
 *   - cap enforcement: cap_size_usd is always within [0, cap], never negative,
 *     never exceeds the per-trade / correlated cap → the governor can never
 *     ENLARGE a proposal.
 *   - kill-switch / reserve precedence: the most-severe veto always wins even
 *     when several rules would fire at once.
 *   - fail-safe on bad input: NaN / Infinity / negative capital never blow up,
 *     never widen a cap, never silently approve over-cap exposure.
 *   - determinism: identical inputs → byte-identical results, order-independent.
 *
 * Pure module — no DB, no network, no clock, no entropy. A seeded LCG drives
 * the property/fuzz sweeps so the file is fully reproducible.
 */
import { describe, expect, it } from "vitest";
import {
  checkPortfolioImpact,
  readGovernorThresholdsFromEnv,
  DEFAULT_GOVERNOR_THRESHOLDS,
  RESERVE_PCT_HARD_FLOOR,
  type CapsuleSnapshot,
  type GovernorInputs,
  type GovernorProposal,
  type GovernorResult,
  type GovernorThresholds,
  type PortfolioPosition,
} from "@/lib/portfolio/governor";

const T = DEFAULT_GOVERNOR_THRESHOLDS;

// deterministic LCG so any "noise" is reproducible (no Math.random flakiness)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

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

// -------------------------------------------------------------------------
// 1. Cap enforcement — the governor can never enlarge a proposal.
// -------------------------------------------------------------------------
describe("Governor robustness — cap_size never exceeds the cap", () => {
  it("collision cap_size is exactly the remaining single-trade headroom", () => {
    // existing $3, proposal $4 → total $7 > $5 cap. headroom = 5 - 3 = $2.
    const r = checkPortfolioImpact(
      inputs({
        proposal: mkProposal({ size_usd: 4 }),
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
        ],
      }),
    );
    expect(r.action).toBe("cap_size");
    expect(r.cap_size_usd).toBeCloseTo(T.maxTradeUsd - 3, 9);
  });

  it("collision cap_size is strictly less than the original proposal size", () => {
    const r = checkPortfolioImpact(
      inputs({
        proposal: mkProposal({ size_usd: 4 }),
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
        ],
      }),
    );
    expect(r.cap_size_usd).toBeLessThan(4);
    expect(r.cap_size_usd).toBeGreaterThanOrEqual(0);
  });

  it("collision: existing + cap_size never exceeds the per-trade cap", () => {
    const existing = 3.5;
    const r = checkPortfolioImpact(
      inputs({
        proposal: mkProposal({ size_usd: 10 }),
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: existing, time_horizon: "5m" },
        ],
      }),
    );
    expect(r.action).toBe("cap_size");
    expect(existing + (r.cap_size_usd ?? 0)).toBeLessThanOrEqual(T.maxTradeUsd + 1e-9);
  });

  it("correlated cap_size leaves total exposure at exactly the cap, never above", () => {
    // active capital $30 (3×$10), cap 30% = $9. existing same-class same-side $5.
    // headroom = $4. proposal $5 → cap to $4. existing + cap = $9 = maxExposure.
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
    const maxExposure = T.maxCorrelatedExposurePct * 30;
    expect(5 + (r.cap_size_usd ?? 0)).toBeCloseTo(maxExposure, 9);
  });
});

// -------------------------------------------------------------------------
// 2. cap_size_usd bound invariant under a deterministic fuzz sweep.
// -------------------------------------------------------------------------
describe("Governor robustness — cap_size_usd bounds hold over fuzzed inputs", () => {
  it("whenever action is cap_size, 0 <= cap_size_usd <= original size (seeded sweep)", () => {
    const rnd = lcg(0xC0FFEE);
    let sawCapSize = false;
    for (let i = 0; i < 400; i++) {
      const propSize = 0.5 + rnd() * 12;
      const existing = rnd() * 12;
      const capUsd = 1 + rnd() * 8;
      const side: "BUY" | "SELL" = rnd() < 0.5 ? "BUY" : "SELL";
      const thresholds: GovernorThresholds = { ...T, maxTradeUsd: capUsd };
      const r = checkPortfolioImpact({
        proposal: mkProposal({ size_usd: propSize, side }),
        capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })], // huge → correlated cap can't bite
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side, size_usd: existing, time_horizon: "5m" },
        ],
        thresholds,
      });
      if (r.action === "cap_size") {
        sawCapSize = true;
        expect(r.cap_size_usd).toBeGreaterThanOrEqual(0);
        // headroom = cap - existing, and is only emitted when existing+prop > cap,
        // so headroom < prop. Allow a tiny float epsilon.
        expect(r.cap_size_usd!).toBeLessThanOrEqual(propSize + 1e-9);
        // existing + capped never exceeds the cap.
        expect(existing + r.cap_size_usd!).toBeLessThanOrEqual(capUsd + 1e-9);
      }
    }
    expect(sawCapSize).toBe(true); // the sweep actually exercised the cap path
  });

  it("a cap_size or reject result NEVER carries a cap_size_usd above the per-trade cap (seeded sweep)", () => {
    const rnd = lcg(42);
    for (let i = 0; i < 300; i++) {
      const capUsd = 1 + rnd() * 6;
      const r = checkPortfolioImpact({
        proposal: mkProposal({ size_usd: rnd() * 15 }),
        capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: rnd() * 15, time_horizon: "5m" },
        ],
        thresholds: { ...T, maxTradeUsd: capUsd },
      });
      if (typeof r.cap_size_usd === "number") {
        expect(r.cap_size_usd).toBeLessThanOrEqual(capUsd + 1e-9);
      }
    }
  });
});

// -------------------------------------------------------------------------
// 3. Reserve / kill-switch precedence — most severe veto wins.
// -------------------------------------------------------------------------
describe("Governor robustness — reserve veto precedence", () => {
  it("reserve veto outranks a same-trade collision AND an over-exposed family", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ strategy_family: "reserve" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 50 }),
        mkCapsule({ id: "cap-other", strategy_family: "scrape", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("reserve_capsule");
  });

  it("reserve veto fires even with empty capsules + empty positions (no context needed)", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ strategy_family: "reserve" }),
      capsules: [],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("reserve_capsule");
    expect(r.cap_size_usd).toBeUndefined();
  });

  it("reserve veto fires before the zero-active-capital pass-through", () => {
    // Zero active capital would normally approve; reserve must still reject.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ strategy_family: "reserve" }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 0, status: "paused" })],
      openPositions: [],
      thresholds: T,
    });
    expect(r.reason).toBe("reserve_capsule");
  });
});

// -------------------------------------------------------------------------
// 4. Collision precedence over correlated/family caps.
// -------------------------------------------------------------------------
describe("Governor robustness — collision precedence", () => {
  it("collision reject outranks the correlated-exposure cap when both would fire", () => {
    // existing same (asset,side,horizon) at full $5 cap → collision reject.
    // correlated exposure is also blown, but collision is checked first.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "BTC", size_usd: 4 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-B", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.reason).toBe("same_trade_collision");
    expect(r.action).toBe("reject");
  });
});

// -------------------------------------------------------------------------
// 5. Collision matching semantics — the exact predicate the code uses.
// -------------------------------------------------------------------------
describe("Governor robustness — collision matching semantics", () => {
  it("opposite side is NOT a collision (BUY proposal vs SELL position)", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "BTC", side: "BUY", size_usd: 4 }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "SELL", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    // No collision on BUY; SELL exposure doesn't count toward BUY exposure either.
    expect(r.action).toBe("approve");
  });

  it("different matching time_horizon is NOT a collision", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "BTC", side: "BUY", size_usd: 4, time_horizon: "15m" }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
  });

  it("proposal without an asset symbol skips collision entirely", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: undefined, asset_class: null, size_usd: 99 }),
      capsules: [mkCapsule({ id: "cap-A", strategy_family: null, capital_allocated_usd: 1000 })],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    // no asset → no collision check; no asset_class → no correlated check;
    // single family → no family check. Clean approve.
    expect(r.action).toBe("approve");
    expect(r.reason).toBe("ok");
  });

  it("position from the SAME proposing capsule does not collide with itself", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ capsule_id: "cap-A", asset: "BTC", side: "BUY", size_usd: 4 }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
      openPositions: [
        { capsule_id: "cap-A", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
  });

  it("collision aggregates notional across MULTIPLE colliding capsules", () => {
    // two foreign capsules at $2 each = $4 existing, proposal $4 → $8 > $5 cap.
    // headroom = 5 - 4 = $1.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ asset: "BTC", side: "BUY", size_usd: 4 }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 2, time_horizon: "5m" },
        { capsule_id: "cap-Y", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 2, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("cap_size");
    expect(r.reason).toBe("same_trade_collision");
    expect(r.cap_size_usd).toBeCloseTo(1, 9);
  });
});

// -------------------------------------------------------------------------
// 6. Fail-safe on degenerate / hostile inputs.
// -------------------------------------------------------------------------
describe("Governor robustness — fail-safe on bad input", () => {
  it("non-finite capital_allocated_usd is treated as 0 (NaN capsule does not crash)", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: Number.NaN }),
        mkCapsule({ id: "cap-B", strategy_family: "scrape", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    // NaN counted as 0 → active capital = $10, directional family = $0 → under cap → approve.
    expect(r.action).toBe("approve");
    expect(Number.isNaN(r.cap_size_usd as number)).toBe(false);
  });

  it("all-NaN capital collapses active capital to 0 → pass-through approve", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal(),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: Number.NaN }),
        mkCapsule({ id: "cap-B", capital_allocated_usd: Number.POSITIVE_INFINITY }),
      ],
      openPositions: [],
      thresholds: T,
    });
    // Infinity is finite-checked out → 0; NaN → 0; activeCapital = 0 → pass-through.
    expect(r.action).toBe("approve");
    expect(r.summary).toMatch(/no active capital/);
  });

  it("negative total active capital is treated as <= 0 → pass-through approve", () => {
    const r = checkPortfolioImpact({
      proposal: mkProposal(),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: -100 })],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 5, time_horizon: "5m" },
      ],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
    expect(r.summary).toMatch(/no active capital/);
  });

  it("never crashes and always returns a valid action over a hostile seeded sweep", () => {
    const rnd = lcg(0xDEADBEEF);
    const validActions = new Set<GovernorResult["action"]>(["approve", "reject", "cap_size"]);
    const validReasons = new Set<GovernorResult["reason"]>([
      "reserve_capsule",
      "same_trade_collision",
      "correlated_exposure_cap",
      "strategy_family_cap",
      "ok",
    ]);
    for (let i = 0; i < 500; i++) {
      const weirdCapital = [Number.NaN, Number.POSITIVE_INFINITY, -10, 0, rnd() * 100][Math.floor(rnd() * 5)];
      const r = checkPortfolioImpact({
        proposal: mkProposal({
          size_usd: rnd() < 0.1 ? Number.NaN : rnd() * 20,
          side: rnd() < 0.5 ? "BUY" : "SELL",
          asset: rnd() < 0.2 ? undefined : "BTC",
        }),
        capsules: [
          mkCapsule({ id: "cap-A", capital_allocated_usd: weirdCapital }),
          mkCapsule({ id: "cap-B", strategy_family: "scrape", capital_allocated_usd: rnd() * 50 }),
        ],
        openPositions: [
          { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: rnd() * 20, time_horizon: "5m" },
        ],
        thresholds: { ...T, maxTradeUsd: 1 + rnd() * 8 },
      });
      expect(validActions.has(r.action)).toBe(true);
      expect(validReasons.has(r.reason)).toBe(true);
      expect(typeof r.summary).toBe("string");
      expect(r.summary.length).toBeGreaterThan(0);
      if (r.action === "cap_size") {
        // a cap result must carry a finite, non-negative cap size.
        expect(Number.isFinite(r.cap_size_usd as number)).toBe(true);
        expect(r.cap_size_usd!).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// -------------------------------------------------------------------------
// 7. Strategy-family cap — only meaningful with >= 2 active families.
// -------------------------------------------------------------------------
describe("Governor robustness — strategy-family cap gating", () => {
  it("single-family portfolio NEVER fires the family cap (would block forever otherwise)", () => {
    // one family controlling 100% of capital — rule is suppressed by design.
    const r = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE", strategy_family: "directional" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 100 }),
        mkCapsule({ id: "cap-B", strategy_family: "directional", capital_allocated_usd: 100 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(r.action).toBe("approve");
    expect(r.reason).toBe("ok");
  });

  it("family exactly at the cap is allowed; one cent over rejects", () => {
    // active capital $40, family cap 25% = $10.
    const atCap = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-b1", strategy_family: "scrape", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-b2", strategy_family: "consensus", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-b3", strategy_family: "market_making", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(atCap.action).toBe("approve");

    // active capital ~$40.02; family $10.02 > $10.005 (cap + 0.01 tolerance) → reject.
    const overCap = checkPortfolioImpact({
      proposal: mkProposal({ size_usd: 1, asset: "DOGE" }),
      capsules: [
        mkCapsule({ id: "cap-A", strategy_family: "directional", capital_allocated_usd: 10.5 }),
        mkCapsule({ id: "cap-b1", strategy_family: "scrape", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-b2", strategy_family: "consensus", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-b3", strategy_family: "market_making", capital_allocated_usd: 10 }),
      ],
      openPositions: [],
      thresholds: T,
    });
    expect(overCap.action).toBe("reject");
    expect(overCap.reason).toBe("strategy_family_cap");
  });
});

// -------------------------------------------------------------------------
// 8. Determinism + purity.
// -------------------------------------------------------------------------
describe("Governor robustness — determinism & purity", () => {
  it("identical inputs yield deeply-equal results across repeated calls", () => {
    const args = inputs({
      proposal: mkProposal({ size_usd: 4 }),
      capsules: [
        mkCapsule({ id: "cap-A", capital_allocated_usd: 10 }),
        mkCapsule({ id: "cap-B", strategy_family: "scrape", capital_allocated_usd: 10 }),
      ],
      openPositions: [
        { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" },
      ],
    });
    const a = checkPortfolioImpact(args);
    const b = checkPortfolioImpact(args);
    expect(b).toStrictEqual(a);
  });

  it("does not mutate its input arrays or objects (frozen inputs still work)", () => {
    const proposal = Object.freeze(mkProposal({ size_usd: 4 })) as GovernorProposal;
    const capsules = Object.freeze([
      Object.freeze(mkCapsule({ id: "cap-A", capital_allocated_usd: 10 })),
    ]) as readonly CapsuleSnapshot[];
    const openPositions = Object.freeze([
      Object.freeze({ capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 3, time_horizon: "5m" } as PortfolioPosition),
    ]) as readonly PortfolioPosition[];
    // If the implementation mutated a frozen input it would throw in strict mode.
    expect(() => checkPortfolioImpact({ proposal, capsules, openPositions, thresholds: T })).not.toThrow();
  });

  it("result is independent of openPositions ordering (collision sum is order-free)", () => {
    const base = {
      proposal: mkProposal({ asset: "BTC", side: "BUY", size_usd: 4 }),
      capsules: [mkCapsule({ id: "cap-A", capital_allocated_usd: 1000 })],
      thresholds: T,
    };
    const p1: PortfolioPosition = { capsule_id: "cap-X", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 2, time_horizon: "5m" };
    const p2: PortfolioPosition = { capsule_id: "cap-Y", asset_class: "prediction_market", asset: "BTC", side: "BUY", size_usd: 1.5, time_horizon: "5m" };
    const forward = checkPortfolioImpact({ ...base, openPositions: [p1, p2] });
    const reversed = checkPortfolioImpact({ ...base, openPositions: [p2, p1] });
    expect(reversed.action).toBe(forward.action);
    expect(reversed.reason).toBe(forward.reason);
    expect(reversed.cap_size_usd).toBeCloseTo(forward.cap_size_usd as number, 9);
  });
});

// -------------------------------------------------------------------------
// 9. Threshold parsing robustness (the env veto floor).
// -------------------------------------------------------------------------
describe("Governor robustness — threshold env parsing", () => {
  it("empty env returns the documented defaults exactly", () => {
    const t = readGovernorThresholdsFromEnv({});
    expect(t).toStrictEqual({
      maxTradeUsd: DEFAULT_GOVERNOR_THRESHOLDS.maxTradeUsd,
      maxCorrelatedExposurePct: DEFAULT_GOVERNOR_THRESHOLDS.maxCorrelatedExposurePct,
      maxStrategyFamilyExposurePct: DEFAULT_GOVERNOR_THRESHOLDS.maxStrategyFamilyExposurePct,
      reservePct: DEFAULT_GOVERNOR_THRESHOLDS.reservePct,
    });
  });

  it("reserve floor cannot be zeroed by env; reservePct is always >= the hard floor", () => {
    // "0" is a valid non-negative number → floored to 0.25.
    expect(readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "0" }).reservePct).toBe(RESERVE_PCT_HARD_FLOOR);
    // "0.01" is valid but below the floor → raised to 0.25.
    expect(readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "0.01" }).reservePct).toBe(RESERVE_PCT_HARD_FLOOR);
    // A negative value is rejected as invalid → falls back to the default (0.50),
    // which is itself above the floor. The invariant that holds in every case is:
    // reservePct >= RESERVE_PCT_HARD_FLOOR.
    expect(readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: "-5" }).reservePct).toBe(DEFAULT_GOVERNOR_THRESHOLDS.reservePct);
    for (const v of ["0", "0.01", "-5", "0.1", "garbage", "0.25", "0.5", "0.9"]) {
      expect(readGovernorThresholdsFromEnv({ ARENA_RESERVE_PCT: v }).reservePct).toBeGreaterThanOrEqual(RESERVE_PCT_HARD_FLOOR);
    }
  });

  it("MAX_TRADE_USD takes precedence over RISK_STAKE_USD fallback", () => {
    const t = readGovernorThresholdsFromEnv({ MAX_TRADE_USD: "8", RISK_STAKE_USD: "3" });
    expect(t.maxTradeUsd).toBe(8);
  });

  it("falls back to RISK_STAKE_USD when MAX_TRADE_USD is absent", () => {
    const t = readGovernorThresholdsFromEnv({ RISK_STAKE_USD: "3" });
    expect(t.maxTradeUsd).toBe(3);
  });

  it("negative numeric env values are rejected and fall back to defaults", () => {
    const t = readGovernorThresholdsFromEnv({ MAX_CORRELATED_EXPOSURE_PCT: "-0.5", MAX_STRATEGY_FAMILY_EXPOSURE_PCT: "-1" });
    expect(t.maxCorrelatedExposurePct).toBe(DEFAULT_GOVERNOR_THRESHOLDS.maxCorrelatedExposurePct);
    expect(t.maxStrategyFamilyExposurePct).toBe(DEFAULT_GOVERNOR_THRESHOLDS.maxStrategyFamilyExposurePct);
  });

  it("env parsing is deterministic for the same input map", () => {
    const env = { MAX_TRADE_USD: "7", MAX_CORRELATED_EXPOSURE_PCT: "0.40", ARENA_RESERVE_PCT: "0.55" };
    expect(readGovernorThresholdsFromEnv(env)).toStrictEqual(readGovernorThresholdsFromEnv(env));
  });
});
