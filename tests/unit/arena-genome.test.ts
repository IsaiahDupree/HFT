import { describe, expect, it } from "vitest";
import { GENOME_KINDS, GenomeSchema, getParamBounds, randomGenome, serializeGenome, parseGenome, genomeNickname } from "@/lib/arena/genome";
import { mutateProgrammatic } from "@/lib/arena/mutate";

function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("Genome — random + parse + nickname", () => {
  it.each(GENOME_KINDS)("randomGenome($0) produces a zod-valid genome", (kind) => {
    const g = randomGenome(seededRng(1), kind, { polyConditionIdPool: ["seed-x", "seed-y"] });
    expect(g.kind).toBe(kind);
    GenomeSchema.parse(g); // throws if invalid
    expect(typeof genomeNickname(g)).toBe("string");
  });

  it("serialize → parse round-trips for every kind", () => {
    for (const k of GENOME_KINDS) {
      const g = randomGenome(seededRng(7), k, { polyConditionIdPool: ["seed-x"] });
      const back = parseGenome(serializeGenome(g));
      expect(back).toEqual(g);
    }
  });

  it("randomGenome respects parameter bounds for numeric fields", () => {
    for (const k of GENOME_KINDS) {
      const bounds = getParamBounds(k);
      const g = randomGenome(seededRng(99), k, { polyConditionIdPool: ["seed-x"] });
      for (const [field, b] of Object.entries(bounds)) {
        if (Array.isArray(b) && b.length === 2 && typeof b[0] === "number") {
          const v = (g.params as Record<string, unknown>)[field] as number;
          expect(v).toBeGreaterThanOrEqual(b[0] as number);
          expect(v).toBeLessThanOrEqual(b[1] as number);
        }
      }
    }
  });
});

describe("mutateProgrammatic — bounded perturbation", () => {
  it.each(GENOME_KINDS)("mutating $0 produces a zod-valid child within bounds", (kind) => {
    const rng = seededRng(123);
    const parent = randomGenome(rng, kind, { polyConditionIdPool: ["seed-x"] });
    // Run 50 mutations; every single one must be valid (clamped) and parse cleanly.
    for (let i = 0; i < 50; i++) {
      const child = mutateProgrammatic(parent, rng, { polyConditionIdPool: ["seed-x", "seed-y"] });
      GenomeSchema.parse(child);
      // 95% of the time the kind stays the same (5% kind switch); check bounds for whichever kind we get.
      const bounds = getParamBounds(child.kind);
      for (const [field, b] of Object.entries(bounds)) {
        if (Array.isArray(b) && b.length === 2 && typeof b[0] === "number") {
          const v = (child.params as Record<string, unknown>)[field] as number;
          expect(v).toBeGreaterThanOrEqual(b[0] as number);
          expect(v).toBeLessThanOrEqual(b[1] as number);
        }
      }
    }
  });

  it("integer fields stay integer after perturbation", () => {
    const rng = seededRng(456);
    const parent = randomGenome(rng, "poly_fade_spike");
    for (let i = 0; i < 30; i++) {
      const child = mutateProgrammatic(parent, rng);
      if (child.kind === "poly_fade_spike") {
        expect(Number.isInteger((child.params as any).lookback_h)).toBe(true);
        expect(Number.isInteger((child.params as any).confirm_quiet_h)).toBe(true);
        expect(Number.isInteger((child.params as any).time_stop_h)).toBe(true);
      }
    }
  });

  it("eventually explores a different kind given a non-trivial sample size", () => {
    const rng = seededRng(11);
    const parent = randomGenome(rng, "random_walk_baseline");
    const kindsSeen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const child = mutateProgrammatic(parent, rng, { polyConditionIdPool: ["seed-x"] });
      kindsSeen.add(child.kind);
    }
    // 5% kind-switch prob → with 200 trials, very high probability of seeing more than one kind.
    expect(kindsSeen.size).toBeGreaterThanOrEqual(2);
  });
});
