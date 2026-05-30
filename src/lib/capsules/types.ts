/**
 * Capsule — bounded capital allocation around a single agent/strategy.
 * Ported from TradingBot/src/capsules/capsule.py for the Polymarket+Coinbase
 * workspace. Status lifecycle: draft → paper/live ⇄ paused → stopped|closed.
 */

export type CapsuleStatus = "draft" | "paper" | "live" | "paused" | "stopped" | "closed";

/**
 * Strategy family taxonomy — what kind of edge does this capsule pursue?
 * Used by the correlation engine + cluster kill switches to detect when
 * multiple capsules are effectively the same strategy in different costumes.
 *
 * See PRD: docs/prd/capsule-portfolio-governance-2026-05-27.md §4.1
 */
export type StrategyFamily =
  | "momentum"          // trend-following, breakout, moving-average crossover
  | "mean_reversion"    // z-score, bollinger, range-bound entries
  | "vol_breakout"      // ATR breakout, volatility expansion entries
  | "directional"       // pure long/short direction on a single market
  | "market_making"     // post-and-fade limit-order capture
  | "market_neutral"    // pairs, spreads, hedge-based
  | "consensus"         // cross-wallet / cross-source agreement following
  | "scrape"            // near-resolution / convergence harvesting
  | "oracle"            // LLM / model-driven probability estimation
  | "experimental"      // unclassified / new / under-evaluation
  | "reserve";          // un-deployable money (governor blocks all proposals)

/** Asset class — the broadest correlation grouping. */
export type AssetClass =
  | "crypto"
  | "equity"
  | "macro"
  | "stable"
  | "prediction_market";

/** Time horizon — how long the typical trade holds. */
export type TimeHorizon = "1m" | "5m" | "15m" | "1h" | "1d" | "to_resolution";

/** Regime the strategy is built for. "any" = no regime preference. */
export type RegimeDependency =
  | "trending"
  | "chop"
  | "high_vol"
  | "low_vol"
  | "breakout"
  | "any";

/** Direction the strategy can take. */
export type DirectionalBias =
  | "long_only"
  | "short_only"
  | "long_short"
  | "neutral";

/**
 * Full diversity profile for a capsule. All fields optional so existing
 * capsules without populated profiles still parse cleanly.
 */
export type DiversityProfile = {
  strategy_family?: StrategyFamily;
  asset_class?: AssetClass;
  allowed_assets?: string[];           // subset of asset_class, e.g. ["BTC","ETH"]
  time_horizon?: TimeHorizon;
  regime_dependency?: RegimeDependency;
  directional_bias?: DirectionalBias;
  extra?: Record<string, unknown>;     // free-form escape hatch
};

/** Confidence flag — operator-set values are locked against re-inference. */
export type DiversityConfidence = "inferred" | "operator_set";

export type Capsule = {
  id: string;
  agent_id: number | null;
  strategy_id: number | null;
  name: string;
  status: CapsuleStatus;

  capital_allocated_usd: number;
  capital_deployed_usd: number;
  capital_available_usd: number;

  max_daily_loss_usd: number;
  max_total_drawdown_usd: number;
  max_position_pct: number;       // 0..1
  max_open_positions: number;
  max_trades_per_day: number;

  allowed_venues: string[];        // ['polymarket','coinbase']
  allowed_symbols: string[] | null;
  min_seconds_between_trades: number;

  current_pnl_usd: number;
  daily_pnl_usd: number;
  open_positions: number;
  trades_today: number;

  // Cost-basis tracking (single-symbol-accurate aggregate).
  open_position_qty: number;
  open_position_cost_usd: number;
  daily_pnl_reset_date: string | null;

  // Diversity profile (Phase 6). Optional — older capsules may not have these.
  strategy_family?: StrategyFamily | null;
  asset_class?: AssetClass | null;
  allowed_assets?: string[] | null;
  time_horizon?: TimeHorizon | null;
  regime_dependency?: RegimeDependency | null;
  directional_bias?: DirectionalBias | null;
  diversity_profile?: DiversityProfile | null;
  diversity_confidence?: DiversityConfidence;

  created_at: string;
  updated_at: string;
  activated_at: string | null;
};

export type CapBreachSeverity = "warning" | "breach";

export type CapBreach = {
  cap_name: string;
  current_value: number;
  limit: number;
  severity: CapBreachSeverity;
};

export type CapsuleCheckCode =
  | "CAPSULE_NOT_FOUND"
  | "CAPSULE_NOT_ACTIVE"
  | "CAPSULE_VENUE_NOT_ALLOWED"
  | "CAPSULE_SYMBOL_NOT_ALLOWED"
  | "CAPSULE_MAX_OPEN_POSITIONS"
  | "CAPSULE_MAX_TRADES_PER_DAY"
  | "CAPSULE_MAX_POSITION_PCT"
  | "CAPSULE_COOLDOWN"
  | "CAPSULE_DAILY_LOSS"
  | "CAPSULE_TOTAL_DRAWDOWN";

export type CapsuleCheckResult =
  | { ok: true }
  | { ok: false; code: CapsuleCheckCode; reason: string };
