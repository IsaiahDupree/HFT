/**
 * Tests for the capsule diversity-profile inference module.
 *
 * Asserts:
 *   - Every known genome kind maps to a non-experimental profile (with the
 *     intentional exception of random_walk_baseline and multi_strategy).
 *   - Each strategy family appears in the map at least once (taxonomy is fully
 *     used by some known kind).
 *   - Unknown kinds fall back to the conservative experimental profile.
 *   - Returns fresh copies (mutating one result doesn't pollute the map).
 *   - The exhaustive taxonomies (STRATEGY_FAMILIES, ASSET_CLASSES, etc.) are
 *     defined for downstream consumers.
 */
import { describe, expect, it } from "vitest";
import {
  ASSET_CLASSES,
  DIRECTIONAL_BIASES,
  REGIME_DEPENDENCIES,
  STRATEGY_FAMILIES,
  TIME_HORIZONS,
  inferDiversityProfile,
  isKnownKind,
  knownKinds,
} from "@/lib/capsules/diversity-inference";
import type { StrategyFamily } from "@/lib/capsules/types";

describe("inferDiversityProfile", () => {
  it("returns a known profile for poly_short_binary_directional", () => {
    const p = inferDiversityProfile("poly_short_binary_directional");
    expect(p.strategy_family).toBe("directional");
    expect(p.asset_class).toBe("prediction_market");
    expect(p.time_horizon).toBe("5m");
    expect(p.regime_dependency).toBe("trending");
    expect(p.allowed_assets).toEqual(["BTC", "ETH", "SOL", "XRP", "DOGE"]);
  });

  it("returns scrape family for near-resolution-scrape gen-2 slug", () => {
    const p = inferDiversityProfile("near-resolution-scrape");
    expect(p.strategy_family).toBe("scrape");
    expect(p.time_horizon).toBe("to_resolution");
  });

  it("returns consensus family for consensus-tail-follow", () => {
    const p = inferDiversityProfile("consensus-tail-follow");
    expect(p.strategy_family).toBe("consensus");
  });

  it("returns momentum family for midwindow-trajectory", () => {
    const p = inferDiversityProfile("midwindow-trajectory");
    expect(p.strategy_family).toBe("momentum");
    expect(p.regime_dependency).toBe("trending");
  });

  it("returns market_neutral for cross-timeframe-spread-trade", () => {
    const p = inferDiversityProfile("cross-timeframe-spread-trade");
    expect(p.strategy_family).toBe("market_neutral");
    expect(p.directional_bias).toBe("neutral");
  });

  it("returns market_making for polymarket_market_maker", () => {
    const p = inferDiversityProfile("polymarket_market_maker");
    expect(p.strategy_family).toBe("market_making");
    expect(p.regime_dependency).toBe("chop");
  });

  it("returns oracle family for llm_probability_oracle", () => {
    const p = inferDiversityProfile("llm_probability_oracle");
    expect(p.strategy_family).toBe("oracle");
  });

  it("returns vol_breakout for cb_breakout", () => {
    const p = inferDiversityProfile("cb_breakout");
    expect(p.strategy_family).toBe("vol_breakout");
    expect(p.asset_class).toBe("crypto");
    expect(p.regime_dependency).toBe("breakout");
  });

  it("returns mean_reversion for cb_mean_reversion + poly_fade_spike", () => {
    expect(inferDiversityProfile("cb_mean_reversion").strategy_family).toBe("mean_reversion");
    expect(inferDiversityProfile("poly_fade_spike").strategy_family).toBe("mean_reversion");
  });

  it("returns experimental fallback for unknown kinds", () => {
    const p = inferDiversityProfile("totally-made-up-strategy");
    expect(p.strategy_family).toBe("experimental");
    expect(p.regime_dependency).toBe("any");
  });

  it("returns experimental fallback for null/undefined kind", () => {
    expect(inferDiversityProfile(null).strategy_family).toBe("experimental");
    expect(inferDiversityProfile(undefined).strategy_family).toBe("experimental");
    expect(inferDiversityProfile("").strategy_family).toBe("experimental");
  });

  it("returns experimental for known-but-baseline kinds (random_walk_baseline, multi_strategy)", () => {
    expect(inferDiversityProfile("random_walk_baseline").strategy_family).toBe("experimental");
    expect(inferDiversityProfile("multi_strategy").strategy_family).toBe("experimental");
  });

  it("returned object is a fresh copy — mutating doesn't pollute map", () => {
    const a = inferDiversityProfile("poly_short_binary_directional");
    a.allowed_assets!.push("MUTATED");
    const b = inferDiversityProfile("poly_short_binary_directional");
    expect(b.allowed_assets).toEqual(["BTC", "ETH", "SOL", "XRP", "DOGE"]);
    expect(b.allowed_assets).not.toContain("MUTATED");
  });

  it("every known kind has a non-null strategy_family", () => {
    for (const kind of knownKinds()) {
      const p = inferDiversityProfile(kind);
      expect(p.strategy_family).toBeTruthy();
      expect(p.asset_class).toBeTruthy();
      expect(p.regime_dependency).toBeTruthy();
    }
  });

  it("the strategy family taxonomy is covered — every non-reserve family appears in at least one known kind", () => {
    const seen = new Set<StrategyFamily>();
    for (const kind of knownKinds()) {
      const fam = inferDiversityProfile(kind).strategy_family;
      if (fam) seen.add(fam);
    }
    // `reserve` is a special pseudo-family used only by the reserve capsule
    // (Phase 11) — not assigned by inference. Other 10 families must be covered.
    for (const family of STRATEGY_FAMILIES) {
      if (family === "reserve") continue;
      expect(seen.has(family), `family "${family}" has no known kind that maps to it`).toBe(true);
    }
  });
});

describe("isKnownKind", () => {
  it("returns true for explicit kinds in the map", () => {
    expect(isKnownKind("poly_short_binary_directional")).toBe(true);
    expect(isKnownKind("midwindow-trajectory")).toBe(true);
    expect(isKnownKind("near-resolution-scrape")).toBe(true);
  });

  it("returns false for unknown / null / empty", () => {
    expect(isKnownKind("nope")).toBe(false);
    expect(isKnownKind(null)).toBe(false);
    expect(isKnownKind(undefined)).toBe(false);
    expect(isKnownKind("")).toBe(false);
  });
});

describe("taxonomy exports", () => {
  it("STRATEGY_FAMILIES is non-empty and unique", () => {
    expect(STRATEGY_FAMILIES.length).toBeGreaterThan(0);
    expect(new Set(STRATEGY_FAMILIES).size).toBe(STRATEGY_FAMILIES.length);
  });
  it("ASSET_CLASSES, REGIME_DEPENDENCIES, TIME_HORIZONS, DIRECTIONAL_BIASES all populated", () => {
    expect(ASSET_CLASSES.length).toBeGreaterThan(0);
    expect(REGIME_DEPENDENCIES.length).toBeGreaterThan(0);
    expect(TIME_HORIZONS.length).toBeGreaterThan(0);
    expect(DIRECTIONAL_BIASES.length).toBeGreaterThan(0);
  });
});
