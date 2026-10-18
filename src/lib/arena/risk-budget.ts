/**
 * Risk-budget derivation — ONE dimensional USD anchor + dimensionless ratios.
 *
 * The earlier setup had many independent USD knobs (MAX_TRADE_USD, capital,
 * daily-loss cap, total-DD cap, etc.). They have hidden interdependencies —
 * notably: per-trade stake must be ≤ daily-loss cap, otherwise a single
 * losing trade trips the cap and blocks the capsule for the rest of the day.
 *
 * This module reformulates the budget so every USD number is *derived* from
 * a single anchor (`STAKE_USD`) plus dimensionless integer multipliers:
 *
 *   STAKE_USD              = $5         (the one USD anchor — the per-trade size)
 *   N_AGENTS               = 3          (live capsule count)
 *   DAILY_STAKES_AT_RISK   = 1          (losing stakes before a capsule pauses for the day)
 *   LIFETIME_STAKES_AT_RISK = 2         (losing stakes before a capsule permanently pauses)
 *
 * From these, every dollar amount derives unambiguously:
 *
 *   capital_per_agent_usd   = STAKE_USD × LIFETIME_STAKES_AT_RISK
 *   daily_loss_cap_per_agent_usd = STAKE_USD × DAILY_STAKES_AT_RISK
 *   total_dd_cap_per_agent_usd   = STAKE_USD × LIFETIME_STAKES_AT_RISK  (= capital)
 *   total_live_capital_usd  = capital_per_agent_usd × N_AGENTS
 *   max_daily_spend_usd     = STAKE_USD × DAILY_STAKES_AT_RISK × N_AGENTS × FILL_RATE_HEADROOM
 *
 * Why dimensionless multipliers (instead of percentages):
 *   - "Capsule survives X losing trades before pause" is the SEMANTIC question
 *     traders actually ask. Percentages obscure it.
 *   - You can't mis-specify a multiplier that doesn't match the trade size.
 *     A "30% daily-loss" cap on a $5 stake + $5 capital was meaningless;
 *     "1 losing stake per day" is unambiguous.
 *   - All caps now live in the same unit (count of stakes), making
 *     `capsule_loss_in_stakes` a useful metric: 0 = clean, 1 = day stop,
 *     ≥LIFETIME = capsule done.
 *
 * Env-driven so the operator can tune without code edits. Defaults match the
 * conservative tonight-config we converged on.
 */

export type RiskBudgetInputs = {
  /** USD per trade. The one dimensional anchor. */
  stakeUsd: number;
  /** How many live capsules share the budget. */
  nAgents: number;
  /** Losing stakes before a capsule pauses for the day. */
  dailyStakesAtRisk: number;
  /** Losing stakes before a capsule permanently pauses (manual reactivation needed). */
  lifetimeStakesAtRisk: number;
  /**
   * Multiplier on `stake × daily_stakes × n_agents` for the GLOBAL notional
   * daily spend cap. Higher = more attempts allowed per stake unit; lower =
   * stricter. Setting this above 1 lets capsules cycle through win/loss
   * cycles rather than capping at first stake-spend.
   *
   * Default 10 → capsules can attempt up to 10× their daily-risk in cycling
   * notional. Real loss is still bounded by `daily_stakes_at_risk × stake_usd
   * × n_agents` regardless of how many cycle attempts happen.
   */
  fillRateHeadroom: number;
};

export type RiskBudget = {
  inputs: RiskBudgetInputs;
  /** Per-capsule budget (auto-promote applies to each new capsule). */
  perCapsule: {
    capital_usd: number;
    daily_loss_cap_usd: number;
    total_dd_cap_usd: number;
    /** Per-capsule trade-count cap. Stake × this is the max notional one capsule will spend per day. */
    max_trades_per_day: number;
  };
  /** Global aggregate caps applied at execute.ts. */
  global: {
    max_trade_usd: number;        // = stake
    max_daily_usd: number;        // = stake × daily_stakes × n_agents × fill_rate_headroom
    total_live_capital_usd: number;
  };
  /** Worst-case real-money exposure summaries. */
  exposure: {
    daily_max_loss_usd: number;    // = stake × daily_stakes × n_agents
    lifetime_max_loss_usd: number; // = stake × lifetime_stakes × n_agents
  };
};

/** Default multipliers — overridable via env. */
const DEFAULTS: Required<Pick<RiskBudgetInputs, "stakeUsd" | "nAgents" | "dailyStakesAtRisk" | "lifetimeStakesAtRisk" | "fillRateHeadroom">> = {
  stakeUsd: 5,
  nAgents: 3,
  dailyStakesAtRisk: 1,
  lifetimeStakesAtRisk: 2,
  fillRateHeadroom: 10,
};

/** Read inputs from env with defaults, then derive. Pure / side-effect-free. */
export function readRiskBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): RiskBudget {
  const inputs: RiskBudgetInputs = {
    stakeUsd: numFromEnv(env.RISK_STAKE_USD, DEFAULTS.stakeUsd),
    nAgents: numFromEnv(env.RISK_N_AGENTS ?? env.ARENA_AUTO_PROMOTE_TOP_N, DEFAULTS.nAgents),
    dailyStakesAtRisk: numFromEnv(env.RISK_DAILY_STAKES_AT_RISK, DEFAULTS.dailyStakesAtRisk),
    lifetimeStakesAtRisk: numFromEnv(env.RISK_LIFETIME_STAKES_AT_RISK, DEFAULTS.lifetimeStakesAtRisk),
    fillRateHeadroom: numFromEnv(env.RISK_FILL_RATE_HEADROOM, DEFAULTS.fillRateHeadroom),
  };
  return deriveBudget(inputs);
}

/** Pure derivation. Tested independently of env. */
export function deriveBudget(inputs: RiskBudgetInputs): RiskBudget {
  const { stakeUsd, nAgents, dailyStakesAtRisk, lifetimeStakesAtRisk, fillRateHeadroom } = inputs;
  const capital_usd = stakeUsd * lifetimeStakesAtRisk;
  const daily_loss_cap_usd = stakeUsd * dailyStakesAtRisk;
  const total_dd_cap_usd = stakeUsd * lifetimeStakesAtRisk;   // capsule's capital == lifetime-loss cap
  const total_live_capital_usd = capital_usd * nAgents;
  const max_daily_usd = stakeUsd * dailyStakesAtRisk * nAgents * fillRateHeadroom;
  return {
    inputs,
    perCapsule: {
      capital_usd,
      daily_loss_cap_usd,
      total_dd_cap_usd,
      // Each capsule can attempt up to (daily-stakes × fill-rate-headroom) cycle trades per day.
      // Real loss is still bounded by daily_loss_cap_usd regardless.
      max_trades_per_day: Math.max(1, Math.round(dailyStakesAtRisk * fillRateHeadroom)),
    },
    global: {
      max_trade_usd: stakeUsd,
      max_daily_usd,
      total_live_capital_usd,
    },
    exposure: {
      daily_max_loss_usd: stakeUsd * dailyStakesAtRisk * nAgents,
      lifetime_max_loss_usd: stakeUsd * lifetimeStakesAtRisk * nAgents,
    },
  };
}

/** One-line human-readable summary for status bars / audit logs. */
export function summarizeBudget(b: RiskBudget): string {
  return (
    `stake=$${b.inputs.stakeUsd} × ${b.inputs.nAgents} agents · ` +
    `${b.inputs.dailyStakesAtRisk} losing/day → $${b.exposure.daily_max_loss_usd} max daily loss · ` +
    `${b.inputs.lifetimeStakesAtRisk} losing total → $${b.exposure.lifetime_max_loss_usd} max lifetime`
  );
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  // Strip inline comments and quotes (defensively — _env.ts already does this)
  const cleaned = raw.replace(/\s*#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
