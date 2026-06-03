/**
 * Robustness / invariant tests for the arena mutation operator
 * (`src/lib/arena/mutate.ts`). Complements arena-genome.test.ts — that file
 * proves children stay zod-valid + within bounds and that integers stay
 * integral; THESE tests cover deeper invariants:
 *   - determinism under a seeded RNG (same seed + same parent ⇒ same child)
 *   - no NaN / no non-finite numbers ever leak through perturbation
 *   - categorical (string-enum) fields always stay inside their allowed list
 *   - 6-decimal quantization of non-integer floats
 *   - multi_strategy structural invariants (2..4 subs, never nested composite,
 *     sub-kinds preserved or swapped to a real sub-kind)
 *   - kind-switch (5%) jumps produce a fresh, valid genome of a DIFFERENT kind
 *   - input genome is never mutated in place (parent untouched)
 *   - mutate() dispatcher honours ARENA_MUTATION_MODE for the programmatic path
 *
 * All inputs are pure synthetic genomes built from the real schema via the
 * library's own `randomGenome`. No IO, no network, no files, no clock reads,
 * no real entropy — every "random" draw comes from a deterministic seeded LCG.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mutateProgrammatic,
  mutate,
} from "@/lib/arena/mutate";
import {
  GENOME_KINDS,
  SUB_GENOME_KINDS,
  GenomeSchema,
  getParamBounds,
  randomGenome,
  serializeGenome,
  type Genome,
  type GenomeKind,
} from "@/lib/arena/genome";

// Deterministic LCG (same constants as the sibling genome test) → float [0,1).
// Fully reproducible — no Math.random, no Date.now anywhere in this file.
function seededRng(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const POOL_OPTS = { polyConditionIdPool: ["seed-x", "seed-y", "seed-z"] };

/** Recursively collect every numeric value reachable in a genome's params. */
function collectNumbers(g: Genome): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "number") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as object).forEach(walk);
  };
  walk(g.params);
  return out;
}

/** All categorical (string-enum) bound entries for a kind. */
function categoricalBounds(kind: GenomeKind): Array<[string, string[]]> {
  return Object.entries(getParamBounds(kind)).filter(
    ([, b]) => Array.isArray(b) && b.length > 1 && typeof b[0] === "string",
  ) as Array<[string, string[]]>;
}

describe("mutateProgrammatic — determinism", () => {
  it.each(GENOME_KINDS)("same seed + same parent ⇒ identical child for %s", (kind) => {
    const parent = randomGenome(seededRng(7), kind, POOL_OPTS);
    const a = mutateProgrammatic(parent, seededRng(101), POOL_OPTS);
    const b = mutateProgrammatic(parent, seededRng(101), POOL_OPTS);
    expect(serializeGenome(a)).toBe(serializeGenome(b));
  });

  it("different seeds eventually produce a different child (non-degenerate)", () => {
    const parent = randomGenome(seededRng(3), "poly_breakout", POOL_OPTS);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      seen.add(serializeGenome(mutateProgrammatic(parent, seededRng(seed * 13 + 1), POOL_OPTS)));
    }
    // The operator is stochastic — across 40 distinct seeds we must observe
    // more than a single outcome (otherwise perturbation is a no-op).
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("mutateProgrammatic — finiteness (no NaN / Infinity)", () => {
  it.each(GENOME_KINDS)("every numeric param is finite across 60 mutations of %s", (kind) => {
    const rng = seededRng(2024);
    const parent = randomGenome(rng, kind, POOL_OPTS);
    for (let i = 0; i < 60; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      for (const n of collectNumbers(child)) {
        expect(Number.isNaN(n)).toBe(false);
        expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  it("survives a degenerate rng that returns exactly 0 (gaussian log(0) guard)", () => {
    // gaussian() guards u1 with Math.max(1e-12, rng()); a constant-0 rng must
    // NOT produce -Infinity from Math.log. It also forces no kind-switch
    // (0 < 0.05 is true → kind switch) so we land in randomFresh, still valid.
    const zeroRng = () => 0;
    const parent = randomGenome(seededRng(5), "poly_fade_spike", POOL_OPTS);
    const child = mutateProgrammatic(parent, zeroRng, POOL_OPTS);
    GenomeSchema.parse(child);
    for (const n of collectNumbers(child)) {
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("survives a degenerate rng that returns just-under-1 values", () => {
    // rng → 0.999... pushes gaussian large positive/negative; clamp must still
    // keep params finite and within bounds. 0.999 > 0.05 → no kind switch.
    const hiRng = () => 0.999999;
    for (const kind of ["poly_breakout", "cb_breakout", "cb_mean_reversion"] as GenomeKind[]) {
      const parent = randomGenome(seededRng(9), kind, POOL_OPTS);
      const child = mutateProgrammatic(parent, hiRng, POOL_OPTS);
      GenomeSchema.parse(child);
      for (const n of collectNumbers(child)) expect(Number.isFinite(n)).toBe(true);
    }
  });
});

describe("mutateProgrammatic — bounds & quantization", () => {
  it.each(GENOME_KINDS)("numeric params stay within declared bounds for %s", (kind) => {
    const rng = seededRng(321);
    const parent = randomGenome(rng, kind, POOL_OPTS);
    for (let i = 0; i < 80; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
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

  it("non-integer floats are quantized to at most 6 decimal places", () => {
    // perturbNumeric returns Number(clamped.toFixed(6)) for non-int keys.
    const rng = seededRng(654);
    const parent = randomGenome(rng, "cb_breakout", POOL_OPTS);
    const intKeys = new Set(["lookback_min", "time_stop_min"]);
    for (let i = 0; i < 50; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      if (child.kind !== "cb_breakout") continue;
      for (const [field, val] of Object.entries(child.params)) {
        if (typeof val !== "number" || intKeys.has(field)) continue;
        // round-trip through toFixed(6) must be a fixed point.
        expect(Number(val.toFixed(6))).toBe(val);
      }
    }
  });
});

describe("mutateProgrammatic — categorical fields", () => {
  it.each(GENOME_KINDS.filter((k) => categoricalBounds(k).length > 0))(
    "string-enum fields stay inside their allowed list for %s",
    (kind) => {
      const cats = categoricalBounds(kind);
      const rng = seededRng(777);
      const parent = randomGenome(rng, kind, POOL_OPTS);
      for (let i = 0; i < 100; i++) {
        const child = mutateProgrammatic(parent, rng, POOL_OPTS);
        if (child.kind !== kind) continue; // skip kind-switch results
        for (const [field, list] of cats) {
          const v = (child.params as Record<string, unknown>)[field];
          expect(list).toContain(v);
        }
      }
    },
  );

  it("a categorical flip, when it happens, lands on a DIFFERENT allowed value", () => {
    // cb_breakout.product_id has 3 choices. Force enough mutations to observe
    // at least one flip and confirm the new value is still a member of the set.
    const rng = seededRng(1357);
    const parent = randomGenome(rng, "cb_breakout", POOL_OPTS);
    const allowed = ["BTC-USD", "ETH-USD", "SOL-USD"];
    let flips = 0;
    for (let i = 0; i < 300; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      if (child.kind !== "cb_breakout") continue;
      const pid = child.params.product_id;
      expect(allowed).toContain(pid);
      if (parent.kind === "cb_breakout" && pid !== parent.params.product_id) flips++;
    }
    expect(flips).toBeGreaterThan(0);
  });
});

describe("mutateProgrammatic — kind switching", () => {
  it("a forced kind switch yields a valid genome of a different kind", () => {
    // rng()=0 on the FIRST draw triggers the 5% kind-switch branch (0 < 0.05).
    // Use a sequence: first draw 0 (switch), then a steady stream for randomFresh.
    let calls = 0;
    const switchRng = () => {
      calls++;
      // First call selects the kind-switch branch; subsequent calls feed
      // randomGenome. 0.5 keeps every downstream draw mid-range & deterministic.
      return calls === 1 ? 0 : 0.5;
    };
    const parent = randomGenome(seededRng(11), "cb_mean_reversion", POOL_OPTS);
    const child = mutateProgrammatic(parent, switchRng, POOL_OPTS);
    GenomeSchema.parse(child);
    expect(child.kind).not.toBe(parent.kind);
    expect(GENOME_KINDS).toContain(child.kind);
  });

  it("over many seeds, mutation explores more than one kind", () => {
    const parent = randomGenome(seededRng(11), "random_walk_baseline", POOL_OPTS);
    const kinds = new Set<string>();
    const rng = seededRng(8675309);
    for (let i = 0; i < 400; i++) kinds.add(mutateProgrammatic(parent, rng, POOL_OPTS).kind);
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});

describe("mutateProgrammatic — multi_strategy structural invariants", () => {
  function multiParent(seed: number): Extract<Genome, { kind: "multi_strategy" }> {
    const g = randomGenome(seededRng(seed), "multi_strategy", POOL_OPTS);
    if (g.kind !== "multi_strategy") throw new Error("expected multi_strategy");
    return g;
  }

  it("child of a multi_strategy parent is always multi_strategy with 2..4 subs", () => {
    const rng = seededRng(246);
    const parent = multiParent(31);
    for (let i = 0; i < 120; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      expect(child.kind).toBe("multi_strategy");
      if (child.kind !== "multi_strategy") continue;
      expect(child.params.subs.length).toBeGreaterThanOrEqual(2);
      expect(child.params.subs.length).toBeLessThanOrEqual(4);
    }
  });

  it("no sub-genome is ever a nested multi_strategy", () => {
    const rng = seededRng(909);
    const parent = multiParent(57);
    for (let i = 0; i < 120; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      if (child.kind !== "multi_strategy") continue;
      for (const sub of child.params.subs) {
        expect(sub.kind).not.toBe("multi_strategy");
        expect(SUB_GENOME_KINDS).toContain(sub.kind);
      }
    }
  });

  it("multi_strategy preserves selection mode and child stays zod-valid", () => {
    const rng = seededRng(135);
    const parent = multiParent(63);
    for (let i = 0; i < 80; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      GenomeSchema.parse(child);
      if (child.kind === "multi_strategy") {
        expect(child.params.selection).toBe(parent.params.selection);
      }
    }
  });

  it("reorder branch preserves the multiset of sub-kinds", () => {
    // r in [0.90, 1.0) hits the shuffle branch. After the FIRST rng() (=r),
    // randomFresh is not called; only swaps happen → the bag of kinds is
    // identical to the parent (order may differ).
    const parent = multiParent(71);
    const parentKinds = [...parent.params.subs.map((s) => s.kind)].sort();
    let r = 0.95;
    const reorderRng = () => {
      // first call returns r (selects reorder), later calls feed the shuffle.
      const v = r;
      r = 0.42; // deterministic stream for Fisher-Yates indices
      return v;
    };
    const child = mutateProgrammatic(parent, reorderRng, POOL_OPTS);
    expect(child.kind).toBe("multi_strategy");
    if (child.kind === "multi_strategy") {
      const childKinds = [...child.params.subs.map((s) => s.kind)].sort();
      expect(childKinds).toEqual(parentKinds);
    }
  });
});

describe("mutateProgrammatic — purity (parent not mutated in place)", () => {
  it.each(GENOME_KINDS)("the parent genome object is unchanged after mutating %s", (kind) => {
    const parent = randomGenome(seededRng(50), kind, POOL_OPTS);
    const before = serializeGenome(parent);
    const rng = seededRng(99);
    for (let i = 0; i < 25; i++) mutateProgrammatic(parent, rng, POOL_OPTS);
    expect(serializeGenome(parent)).toBe(before);
  });
});

describe("mutateProgrammatic — cross_venue_arb poly_condition_id", () => {
  it("poly_condition_id always remains a member of the parent kind's valid space", () => {
    // When the pool branch fires (20%) the id comes from the pool; otherwise
    // the parent's id is kept. Either way it must be a non-empty string from
    // {parent's id} ∪ pool.
    const parent = randomGenome(seededRng(5), "cross_venue_arb", POOL_OPTS);
    const parentId = parent.kind === "cross_venue_arb" ? parent.params.poly_condition_id : "";
    const allowed = new Set<string>([parentId, ...POOL_OPTS.polyConditionIdPool]);
    const rng = seededRng(424242);
    for (let i = 0; i < 200; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      if (child.kind !== "cross_venue_arb") continue;
      expect(typeof child.params.poly_condition_id).toBe("string");
      expect(child.params.poly_condition_id.length).toBeGreaterThanOrEqual(3);
      expect(allowed.has(child.params.poly_condition_id)).toBe(true);
    }
  });

  it("with no pool supplied, poly_condition_id is kept from the parent", () => {
    const parent = randomGenome(seededRng(5), "cross_venue_arb", POOL_OPTS);
    const parentId = parent.kind === "cross_venue_arb" ? parent.params.poly_condition_id : "";
    const rng = seededRng(8);
    for (let i = 0; i < 60; i++) {
      const child = mutateProgrammatic(parent, rng, {}); // no pool
      if (child.kind === "cross_venue_arb") {
        expect(child.params.poly_condition_id).toBe(parentId);
      }
    }
  });
});

describe("mutate() dispatcher — programmatic path", () => {
  const orig = process.env.ARENA_MUTATION_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ARENA_MUTATION_MODE;
    else process.env.ARENA_MUTATION_MODE = orig;
  });

  const perf = { fitness: 0.1, pnl_pct: -2, max_dd_pct: 5, trades_count: 3 };

  it("default mode (programmatic) returns a zod-valid child deterministically", async () => {
    delete process.env.ARENA_MUTATION_MODE;
    const parent = randomGenome(seededRng(13), "poly_fade_spike", POOL_OPTS);
    const a = await mutate(parent, perf, POOL_OPTS, seededRng(202));
    const b = await mutate(parent, perf, POOL_OPTS, seededRng(202));
    GenomeSchema.parse(a);
    expect(serializeGenome(a)).toBe(serializeGenome(b));
  });

  it("explicit 'programmatic' mode equals calling mutateProgrammatic directly", async () => {
    process.env.ARENA_MUTATION_MODE = "programmatic";
    const parent = randomGenome(seededRng(17), "cb_breakout", POOL_OPTS);
    const viaDispatch = await mutate(parent, perf, POOL_OPTS, seededRng(303));
    const direct = mutateProgrammatic(parent, seededRng(303), POOL_OPTS);
    expect(serializeGenome(viaDispatch)).toBe(serializeGenome(direct));
  });

  it("mode comparison is case-insensitive (PROGRAMMATIC ⇒ programmatic path)", async () => {
    process.env.ARENA_MUTATION_MODE = "PROGRAMMATIC";
    const parent = randomGenome(seededRng(19), "poly_breakout", POOL_OPTS);
    const child = await mutate(parent, perf, POOL_OPTS, seededRng(404));
    const direct = mutateProgrammatic(parent, seededRng(404), POOL_OPTS);
    expect(serializeGenome(child)).toBe(serializeGenome(direct));
  });
});

describe("mutateProgrammatic — every kind produces a parseable child (smoke matrix)", () => {
  it.each(GENOME_KINDS)("100 mutations of %s all parse cleanly", (kind) => {
    const rng = seededRng(31337);
    const parent = randomGenome(rng, kind, POOL_OPTS);
    for (let i = 0; i < 100; i++) {
      const child = mutateProgrammatic(parent, rng, POOL_OPTS);
      // Re-parse: any silent corruption (extra key, out-of-range, NaN) throws.
      expect(() => GenomeSchema.parse(child)).not.toThrow();
    }
  });
});
