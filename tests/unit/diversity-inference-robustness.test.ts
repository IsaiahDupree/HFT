/**
 * Robustness / invariant tests for the capsule diversity-profile inference module.
 *
 * Complementary to capsule-diversity-inference.test.ts — that file pins specific
 * kind→profile mappings and taxonomy coverage. This file instead exercises:
 *
 *   - DETERMINISM: same input always yields the same (deeply equal) output.
 *   - VALIDITY / BOUNDS: every inferred field is a member of its declared
 *     taxonomy export (the profile is always a well-formed point in the space).
 *   - DEEP-COPY INDEPENDENCE: distinct calls never share mutable references;
 *     mutating one result never leaks into another or into the map.
 *   - "DIVERSITY SCORING" (the honest reading for a mapping module): a profile
 *     diversity metric over a *set* of profiles. An identical set collapses to a
 *     single distinct profile (minimum diversity); a set of orthogonal kinds
 *     spans many distinct facet-tuples (high diversity). The metric is bounded,
 *     symmetric (order-independent), and deterministic.
 *
 * Everything is built from fixed synthetic inputs. A tiny seeded LCG supplies any
 * pseudo-randomness so the whole file is fully deterministic — no clock, no
 * entropy, no DB, no network, no files.
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
import type { DiversityProfile } from "@/lib/capsules/types";

// --- Deterministic seeded LCG (Numerical Recipes constants). No entropy/clock. ---
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000; // [0,1)
  };
}

/** Canonical facet-tuple of a profile — the key used for "distinctness". */
function facetKey(p: DiversityProfile): string {
  return [
    p.strategy_family ?? "_",
    p.asset_class ?? "_",
    p.time_horizon ?? "_",
    p.regime_dependency ?? "_",
    p.directional_bias ?? "_",
    (p.allowed_assets ?? []).join(","),
  ].join("|");
}

/**
 * Profile-diversity score over a set of kinds: the number of distinct profile
 * facet-tuples produced. Bounded by [min(1,n), n]. Pure + order-independent.
 */
function diversityScore(kinds: string[]): number {
  if (kinds.length === 0) return 0;
  const keys = new Set(kinds.map((k) => facetKey(inferDiversityProfile(k))));
  return keys.size;
}

// A hand-picked set of kinds chosen to be mutually distinct in facet-space.
const ORTHOGONAL_KINDS = [
  "poly_fade_spike",
  "cb_breakout",
  "cb_momentum_burst",
  "cross_venue_arb",
  "polymarket_market_maker",
  "llm_probability_oracle",
  "near-resolution-scrape",
];

describe("inferDiversityProfile — determinism", () => {
  it("is deterministic: repeated calls deep-equal each other (known kind)", () => {
    const first = inferDiversityProfile("cb_breakout");
    for (let i = 0; i < 50; i++) {
      expect(inferDiversityProfile("cb_breakout")).toEqual(first);
    }
  });

  it("is deterministic for the fallback path (unknown + null + empty all equal)", () => {
    const fromUnknown = inferDiversityProfile("does-not-exist-xyz");
    expect(inferDiversityProfile("another-unknown-abc")).toEqual(fromUnknown);
    expect(inferDiversityProfile(null)).toEqual(fromUnknown);
    expect(inferDiversityProfile(undefined)).toEqual(fromUnknown);
    expect(inferDiversityProfile("")).toEqual(fromUnknown);
  });

  it("is deterministic across every known kind under a seeded shuffle", () => {
    const rng = makeLcg(0xc0ffee);
    const kinds = knownKinds();
    // Snapshot each kind once.
    const baseline = new Map(kinds.map((k) => [k, inferDiversityProfile(k)]));
    // Probe them again in a seeded random order — results must still match.
    const order = [...kinds];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const k of order) {
      expect(inferDiversityProfile(k)).toEqual(baseline.get(k));
    }
  });
});

describe("inferDiversityProfile — validity / bounds invariants", () => {
  it("every inferred field for every known kind lies inside its declared taxonomy", () => {
    for (const kind of [...knownKinds(), "an-unknown-kind"]) {
      const p = inferDiversityProfile(kind);
      expect(STRATEGY_FAMILIES).toContain(p.strategy_family);
      expect(ASSET_CLASSES).toContain(p.asset_class);
      expect(TIME_HORIZONS).toContain(p.time_horizon);
      expect(REGIME_DEPENDENCIES).toContain(p.regime_dependency);
      expect(DIRECTIONAL_BIASES).toContain(p.directional_bias);
    }
  });

  it("allowed_assets is either undefined or a non-empty array of non-empty strings", () => {
    for (const kind of knownKinds()) {
      const p = inferDiversityProfile(kind);
      if (p.allowed_assets === undefined) continue;
      expect(Array.isArray(p.allowed_assets)).toBe(true);
      expect(p.allowed_assets.length).toBeGreaterThan(0);
      for (const a of p.allowed_assets) {
        expect(typeof a).toBe("string");
        expect(a.length).toBeGreaterThan(0);
      }
    }
  });

  it("fallback profile never carries an allowed_assets restriction", () => {
    expect(inferDiversityProfile("unknown-kind-1").allowed_assets).toBeUndefined();
    expect(inferDiversityProfile(null).allowed_assets).toBeUndefined();
  });

  it("known kinds always populate the five core enum facets (no partial profiles)", () => {
    for (const kind of knownKinds()) {
      const p = inferDiversityProfile(kind);
      expect(p.strategy_family).toBeDefined();
      expect(p.asset_class).toBeDefined();
      expect(p.time_horizon).toBeDefined();
      expect(p.regime_dependency).toBeDefined();
      expect(p.directional_bias).toBeDefined();
    }
  });
});

describe("inferDiversityProfile — deep-copy independence", () => {
  it("two calls for the same kind return distinct top-level object references", () => {
    const a = inferDiversityProfile("cb_breakout");
    const b = inferDiversityProfile("cb_breakout");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("allowed_assets arrays are independent copies across calls", () => {
    const a = inferDiversityProfile("poly_short_binary_directional");
    const b = inferDiversityProfile("poly_short_binary_directional");
    expect(a.allowed_assets).not.toBe(b.allowed_assets);
    expect(a.allowed_assets).toEqual(b.allowed_assets);
  });

  it("mutating one allowed_assets result never leaks into a *different* kind", () => {
    const a = inferDiversityProfile("cross-timeframe-spread-trade");
    a.allowed_assets!.length = 0;
    a.allowed_assets!.push("CORRUPT");
    const other = inferDiversityProfile("midwindow-trajectory");
    expect(other.allowed_assets).toEqual(["BTC", "ETH", "SOL", "XRP", "DOGE"]);
    expect(other.allowed_assets).not.toContain("CORRUPT");
  });

  it("reassigning enum fields on a result never pollutes future inferences", () => {
    const a = inferDiversityProfile("cb_breakout");
    a.strategy_family = "experimental";
    a.asset_class = "stable";
    const fresh = inferDiversityProfile("cb_breakout");
    expect(fresh.strategy_family).toBe("vol_breakout");
    expect(fresh.asset_class).toBe("crypto");
  });
});

describe("diversity scoring over profile sets", () => {
  it("empty set scores 0", () => {
    expect(diversityScore([])).toBe(0);
  });

  it("identical set collapses to minimum diversity (score 1) regardless of size", () => {
    expect(diversityScore(["cb_breakout"])).toBe(1);
    expect(diversityScore(Array(2).fill("cb_breakout"))).toBe(1);
    expect(diversityScore(Array(25).fill("cb_breakout"))).toBe(1);
  });

  it("a set of one kind repeated is no more diverse than a single instance", () => {
    const single = diversityScore(["llm_probability_oracle"]);
    const repeated = diversityScore(Array(10).fill("llm_probability_oracle"));
    expect(repeated).toBe(single);
    expect(repeated).toBe(1);
  });

  it("orthogonal kinds yield maximum diversity (all distinct)", () => {
    expect(diversityScore(ORTHOGONAL_KINDS)).toBe(ORTHOGONAL_KINDS.length);
  });

  it("score is bounded by [1, n] for any non-empty set", () => {
    const rng = makeLcg(0x5eed1);
    const pool = knownKinds();
    for (let trial = 0; trial < 20; trial++) {
      const n = 1 + Math.floor(rng() * 8);
      const kinds = Array.from({ length: n }, () => pool[Math.floor(rng() * pool.length)]);
      const score = diversityScore(kinds);
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(n);
      expect(score).toBeLessThanOrEqual(new Set(kinds).size);
    }
  });

  it("score is order-independent (symmetric under seeded permutation)", () => {
    const rng = makeLcg(0xabcde);
    const base = [...ORTHOGONAL_KINDS, "cb_breakout", "poly_fade_spike"];
    const baseScore = diversityScore(base);
    for (let trial = 0; trial < 10; trial++) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(diversityScore(shuffled)).toBe(baseScore);
    }
  });

  it("score is deterministic: same set scored repeatedly gives the same value", () => {
    const set = ["poly_fade_spike", "cb_breakout", "near-resolution-scrape"];
    const first = diversityScore(set);
    for (let i = 0; i < 20; i++) {
      expect(diversityScore(set)).toBe(first);
    }
  });

  it("adding a duplicate kind cannot increase diversity (monotone under dedup)", () => {
    const before = diversityScore(ORTHOGONAL_KINDS);
    const withDup = diversityScore([...ORTHOGONAL_KINDS, ORTHOGONAL_KINDS[0]]);
    expect(withDup).toBe(before);
  });

  it("adding a genuinely new distinct kind increases diversity by exactly 1", () => {
    const base = ["cb_breakout", "poly_fade_spike"];
    const before = diversityScore(base);
    // 'polymarket_market_maker' has a facet-tuple distinct from both above.
    const after = diversityScore([...base, "polymarket_market_maker"]);
    expect(after).toBe(before + 1);
  });

  it("unknown kinds all share one fallback facet — they do not inflate diversity", () => {
    const score = diversityScore(["nope-a", "nope-b", "nope-c"]);
    expect(score).toBe(1);
    // Mixing unknowns with one known kind yields exactly two distinct profiles.
    expect(diversityScore(["nope-a", "nope-b", "cb_breakout"])).toBe(2);
  });
});

describe("isKnownKind / knownKinds — robustness", () => {
  it("isKnownKind agrees with inference: known => non-fallback identity", () => {
    // For every kind reported as known, inference must NOT return the bare
    // fallback shape (experimental + any + 1h + prediction_market) UNLESS that
    // kind is one of the intentionally-experimental baselines.
    const experimentalBaselines = new Set(["random_walk_baseline", "multi_strategy"]);
    for (const kind of knownKinds()) {
      expect(isKnownKind(kind)).toBe(true);
      const p = inferDiversityProfile(kind);
      if (!experimentalBaselines.has(kind)) {
        const looksLikeFallback =
          p.strategy_family === "experimental" &&
          p.regime_dependency === "any" &&
          p.time_horizon === "1h" &&
          p.asset_class === "prediction_market";
        expect(looksLikeFallback).toBe(false);
      }
    }
  });

  it("knownKinds is sorted, unique, and non-empty", () => {
    const kinds = knownKinds();
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds).size).toBe(kinds.length);
    const sorted = [...kinds].sort();
    expect(kinds).toEqual(sorted);
  });

  it("knownKinds returns a fresh array each call (caller mutation is safe)", () => {
    const a = knownKinds();
    const originalLength = a.length;
    a.push("INJECTED");
    const b = knownKinds();
    expect(b).not.toContain("INJECTED");
    expect(b.length).toBe(originalLength);
  });

  it("isKnownKind is case- and whitespace-sensitive (no fuzzy matching)", () => {
    expect(isKnownKind("cb_breakout")).toBe(true);
    expect(isKnownKind("CB_BREAKOUT")).toBe(false);
    expect(isKnownKind(" cb_breakout")).toBe(false);
    expect(isKnownKind("cb_breakout ")).toBe(false);
  });

  it("a known kind and its mangled variants diverge: known is itself, mangled is fallback", () => {
    const known = inferDiversityProfile("cb_breakout");
    const mangled = inferDiversityProfile("CB_BREAKOUT");
    expect(known.strategy_family).toBe("vol_breakout");
    expect(mangled.strategy_family).toBe("experimental"); // fell back
    expect(facetKey(known)).not.toBe(facetKey(mangled));
  });
});
