/**
 * Tests for the dimensionless risk-budget derivation.
 *
 * The whole point of this module is that EVERY dollar amount is a pure
 * function of (stake_usd, n_agents, daily_stakes_at_risk, lifetime_stakes_at_risk,
 * fill_rate_headroom). These tests lock in the equations.
 */
import { describe, expect, it } from "vitest";
import { deriveBudget, readRiskBudgetFromEnv, summarizeBudget } from "@/lib/arena/risk-budget";

describe("deriveBudget — equations", () => {
  it("default conservative config: $5 stake × 3 agents × 1 loss/day × 2 lifetime", () => {
    const b = deriveBudget({
      stakeUsd: 5, nAgents: 3,
      dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2,
      fillRateHeadroom: 10,
    });
    expect(b.perCapsule.capital_usd).toBe(10);              // 5 × 2
    expect(b.perCapsule.daily_loss_cap_usd).toBe(5);        // 5 × 1
    expect(b.perCapsule.total_dd_cap_usd).toBe(10);         // 5 × 2 (= capital)
    expect(b.perCapsule.max_trades_per_day).toBe(10);       // 1 × 10
    expect(b.global.max_trade_usd).toBe(5);
    expect(b.global.max_daily_usd).toBe(150);                // 5 × 1 × 3 × 10
    expect(b.global.total_live_capital_usd).toBe(30);        // 10 × 3
    expect(b.exposure.daily_max_loss_usd).toBe(15);          // 5 × 1 × 3
    expect(b.exposure.lifetime_max_loss_usd).toBe(30);       // 5 × 2 × 3
  });

  it("scales linearly with stake_usd — doubling stake doubles every dollar amount", () => {
    const small = deriveBudget({ stakeUsd: 5, nAgents: 3, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 10 });
    const big = deriveBudget({ stakeUsd: 10, nAgents: 3, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 10 });
    expect(big.perCapsule.capital_usd).toBe(small.perCapsule.capital_usd * 2);
    expect(big.global.max_daily_usd).toBe(small.global.max_daily_usd * 2);
    expect(big.exposure.lifetime_max_loss_usd).toBe(small.exposure.lifetime_max_loss_usd * 2);
  });

  it("scales linearly with n_agents", () => {
    const three = deriveBudget({ stakeUsd: 5, nAgents: 3, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 10 });
    const six = deriveBudget({ stakeUsd: 5, nAgents: 6, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 10 });
    // per-capsule numbers stay the same
    expect(six.perCapsule.capital_usd).toBe(three.perCapsule.capital_usd);
    expect(six.perCapsule.daily_loss_cap_usd).toBe(three.perCapsule.daily_loss_cap_usd);
    // global numbers double
    expect(six.global.total_live_capital_usd).toBe(three.global.total_live_capital_usd * 2);
    expect(six.exposure.daily_max_loss_usd).toBe(three.exposure.daily_max_loss_usd * 2);
  });

  it("max_trades_per_day floors at 1 even with tiny headroom", () => {
    const b = deriveBudget({ stakeUsd: 5, nAgents: 1, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 0.1 });
    expect(b.perCapsule.max_trades_per_day).toBeGreaterThanOrEqual(1);
  });

  it("INVARIANT: per-capsule capital == per-capsule total-DD cap (lifetime exposure == capital)", () => {
    for (const lifetime of [1, 2, 3, 5]) {
      const b = deriveBudget({ stakeUsd: 5, nAgents: 3, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: lifetime, fillRateHeadroom: 10 });
      expect(b.perCapsule.capital_usd).toBe(b.perCapsule.total_dd_cap_usd);
    }
  });

  it("INVARIANT: daily_loss_cap_per_capsule <= capital_per_capsule (one bad day can't exceed lifetime budget)", () => {
    for (const daily of [1, 2, 3]) {
      for (const lifetime of [daily, daily + 1, daily * 2]) {
        const b = deriveBudget({ stakeUsd: 5, nAgents: 3, dailyStakesAtRisk: daily, lifetimeStakesAtRisk: lifetime, fillRateHeadroom: 10 });
        expect(b.perCapsule.daily_loss_cap_usd).toBeLessThanOrEqual(b.perCapsule.capital_usd);
      }
    }
  });

  it("INVARIANT: max_trade_usd == stake_usd (single-trade size is the anchor)", () => {
    const b = deriveBudget({ stakeUsd: 7, nAgents: 2, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 3, fillRateHeadroom: 5 });
    expect(b.global.max_trade_usd).toBe(7);
  });
});

describe("readRiskBudgetFromEnv — env parsing", () => {
  it("uses defaults when no env vars set", () => {
    const b = readRiskBudgetFromEnv({});
    expect(b.inputs.stakeUsd).toBe(5);
    expect(b.inputs.nAgents).toBe(3);
    expect(b.inputs.dailyStakesAtRisk).toBe(1);
    expect(b.inputs.lifetimeStakesAtRisk).toBe(2);
    expect(b.inputs.fillRateHeadroom).toBe(10);
  });

  it("overrides from RISK_* env names", () => {
    const b = readRiskBudgetFromEnv({
      RISK_STAKE_USD: "10",
      RISK_N_AGENTS: "5",
      RISK_DAILY_STAKES_AT_RISK: "2",
      RISK_LIFETIME_STAKES_AT_RISK: "4",
      RISK_FILL_RATE_HEADROOM: "20",
    });
    expect(b.inputs.stakeUsd).toBe(10);
    expect(b.inputs.nAgents).toBe(5);
    expect(b.inputs.dailyStakesAtRisk).toBe(2);
    expect(b.inputs.lifetimeStakesAtRisk).toBe(4);
    expect(b.inputs.fillRateHeadroom).toBe(20);
  });

  it("falls back to ARENA_AUTO_PROMOTE_TOP_N when RISK_N_AGENTS unset (backwards compat)", () => {
    const b = readRiskBudgetFromEnv({ ARENA_AUTO_PROMOTE_TOP_N: "4" });
    expect(b.inputs.nAgents).toBe(4);
  });

  it("strips inline #-comments from env values (defense in depth)", () => {
    const b = readRiskBudgetFromEnv({ RISK_STAKE_USD: "5  # tonight basis" });
    expect(b.inputs.stakeUsd).toBe(5);
  });

  it("ignores malformed env values and falls back to default", () => {
    const b = readRiskBudgetFromEnv({ RISK_STAKE_USD: "not-a-number" });
    expect(b.inputs.stakeUsd).toBe(5);
  });

  it("rejects negative env values (only positive makes sense)", () => {
    const b = readRiskBudgetFromEnv({ RISK_STAKE_USD: "-10" });
    expect(b.inputs.stakeUsd).toBe(5);  // falls back to default
  });
});

describe("summarizeBudget", () => {
  it("produces a one-line human-readable summary", () => {
    const b = deriveBudget({ stakeUsd: 5, nAgents: 3, dailyStakesAtRisk: 1, lifetimeStakesAtRisk: 2, fillRateHeadroom: 10 });
    const s = summarizeBudget(b);
    expect(s).toContain("$5");
    expect(s).toContain("3 agents");
    expect(s).toContain("1 losing/day");
    expect(s).toContain("$15 max daily");
    expect(s).toContain("$30 max lifetime");
  });
});
