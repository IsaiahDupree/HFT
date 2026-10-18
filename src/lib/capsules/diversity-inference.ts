/**
 * Diversity-profile inference — maps a paper agent's genome kind onto a
 * canonical `DiversityProfile`. Pure module; no DB or I/O.
 *
 * Used by:
 *   - scripts/infer-capsule-diversity.ts (one-shot population of live DB)
 *   - the correlation engine (Phase 7) when a capsule lacks an explicit profile
 *   - the /arena UI to render diversity chips
 *
 * Why one canonical mapping in code rather than per-strategy metadata?
 *   - Existing genomes don't carry diversity metadata; this lets us populate
 *     without touching every strategy module.
 *   - Operator can override per-capsule (sets diversity_confidence='operator_set');
 *     inference skips operator-locked rows.
 *   - Adding a new genome kind = one entry in the KIND_PROFILES map.
 */
import type {
  AssetClass,
  DirectionalBias,
  DiversityProfile,
  RegimeDependency,
  StrategyFamily,
  TimeHorizon,
} from "./types";

/**
 * Canonical mapping: genome kind → diversity profile.
 *
 * Coverage: every kind in src/lib/arena/genome.ts SubGenomeSchema + the gen-2
 * strategy slugs from scripts/seed-strategies-gen2.ts. Unknown kinds fall
 * back to `experimental` with conservative defaults.
 */
const KIND_PROFILES: Record<string, DiversityProfile> = {
  // --- Gen-1 genome kinds ---
  poly_fade_spike: {
    strategy_family: "mean_reversion",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "chop",
    directional_bias: "long_short",
  },
  poly_breakout: {
    strategy_family: "vol_breakout",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "breakout",
    directional_bias: "long_short",
  },
  poly_short_binary_directional: {
    strategy_family: "directional",
    asset_class: "prediction_market",
    allowed_assets: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
    time_horizon: "5m",
    regime_dependency: "trending",
    directional_bias: "long_short",
  },
  cb_breakout: {
    strategy_family: "vol_breakout",
    asset_class: "crypto",
    allowed_assets: ["BTC", "ETH", "SOL"],
    time_horizon: "15m",
    regime_dependency: "breakout",
    directional_bias: "long_only",
  },
  cb_mean_reversion: {
    strategy_family: "mean_reversion",
    asset_class: "crypto",
    allowed_assets: ["BTC", "ETH", "SOL"],
    time_horizon: "1h",
    regime_dependency: "chop",
    directional_bias: "long_only",
  },
  cb_momentum_burst: {
    strategy_family: "momentum",
    asset_class: "crypto",
    allowed_assets: ["BTC", "ETH", "SOL"],
    time_horizon: "5m",
    regime_dependency: "trending",
    directional_bias: "long_only",
  },
  cross_venue_arb: {
    strategy_family: "market_neutral",
    asset_class: "crypto",
    time_horizon: "5m",
    regime_dependency: "any",
    directional_bias: "neutral",
  },
  category_specialist: {
    strategy_family: "directional",
    asset_class: "prediction_market",
    time_horizon: "1d",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  wallet_copy_filtered: {
    strategy_family: "consensus",
    asset_class: "prediction_market",
    time_horizon: "to_resolution",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  polymarket_market_maker: {
    strategy_family: "market_making",
    asset_class: "prediction_market",
    time_horizon: "5m",
    regime_dependency: "chop",
    directional_bias: "neutral",
  },
  llm_probability_oracle: {
    strategy_family: "oracle",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  random_walk_baseline: {
    strategy_family: "experimental",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  multi_strategy: {
    // Composite — exact profile depends on sub-genomes. We mark as experimental
    // until/unless a richer inference walks the sub-genome list.
    strategy_family: "experimental",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "any",
    directional_bias: "long_short",
  },

  // --- Gen-2 strategy slugs (from seed-strategies-gen2.ts) ---
  "near-resolution-scrape": {
    strategy_family: "scrape",
    asset_class: "prediction_market",
    time_horizon: "to_resolution",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  "cross-timeframe-spread-trade": {
    strategy_family: "market_neutral",
    asset_class: "prediction_market",
    allowed_assets: ["BTC", "ETH", "SOL", "XRP"],
    time_horizon: "5m",
    regime_dependency: "any",
    directional_bias: "neutral",
  },
  "orderbook-imbalance-watch": {
    strategy_family: "experimental",
    asset_class: "prediction_market",
    time_horizon: "1m",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
  "midwindow-trajectory": {
    strategy_family: "momentum",
    asset_class: "prediction_market",
    allowed_assets: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
    time_horizon: "5m",
    regime_dependency: "trending",
    directional_bias: "long_short",
  },
  "consensus-tail-follow": {
    strategy_family: "consensus",
    asset_class: "prediction_market",
    time_horizon: "1h",
    regime_dependency: "any",
    directional_bias: "long_short",
  },
};

/** Fallback profile for unknown kinds — conservative experimental defaults. */
const UNKNOWN_PROFILE: DiversityProfile = {
  strategy_family: "experimental",
  asset_class: "prediction_market",
  time_horizon: "1h",
  regime_dependency: "any",
  directional_bias: "long_short",
};

/**
 * Infer a diversity profile from a genome kind string. Returns the canonical
 * profile for known kinds; falls back to `experimental` for unknown.
 *
 * Pure, deterministic — same input always produces the same output.
 */
export function inferDiversityProfile(kind: string | null | undefined): DiversityProfile {
  if (!kind) return UNKNOWN_PROFILE;
  const profile = KIND_PROFILES[kind];
  if (!profile) return UNKNOWN_PROFILE;
  // Return a fresh copy so callers can mutate without polluting the map.
  return { ...profile, allowed_assets: profile.allowed_assets ? [...profile.allowed_assets] : undefined };
}

/** All kinds with explicit (non-fallback) profiles. Useful for tests. */
export function knownKinds(): string[] {
  return Object.keys(KIND_PROFILES).sort();
}

/**
 * Whether a kind has an explicit profile (not the fallback).
 * Returns false for unknown / falsy input.
 */
export function isKnownKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return KIND_PROFILES[kind] !== undefined;
}

/** Type-narrowing helpers — useful for the cluster engine. */
export const STRATEGY_FAMILIES: StrategyFamily[] = [
  "momentum",
  "mean_reversion",
  "vol_breakout",
  "directional",
  "market_making",
  "market_neutral",
  "consensus",
  "scrape",
  "oracle",
  "experimental",
  "reserve",
];

export const ASSET_CLASSES: AssetClass[] = [
  "crypto",
  "equity",
  "macro",
  "stable",
  "prediction_market",
];

export const REGIME_DEPENDENCIES: RegimeDependency[] = [
  "trending",
  "chop",
  "high_vol",
  "low_vol",
  "breakout",
  "any",
];

export const DIRECTIONAL_BIASES: DirectionalBias[] = [
  "long_only",
  "short_only",
  "long_short",
  "neutral",
];

export const TIME_HORIZONS: TimeHorizon[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "1d",
  "to_resolution",
];
