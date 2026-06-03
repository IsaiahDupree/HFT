import { describe, expect, it } from "vitest";
import { aggressivePresets, type Preset } from "@/lib/arena/seed-presets";
import {
  GENOME_KINDS,
  SUB_GENOME_KINDS,
  GenomeSchema,
  SubGenomeSchema,
  getParamBounds,
  serializeGenome,
  parseGenome,
  genomeNickname,
  type Genome,
  type GenomeKind,
} from "@/lib/arena/genome";

/**
 * Robustness / invariant tests for the aggressive seed presets.
 *
 * These complement (do NOT duplicate) arena-genome.test.ts which exercises
 * randomGenome/mutate. Here we pin down the hand-authored preset table:
 * every preset must be a zod-valid genome, sit within the *runtime* param
 * bounds (getParamBounds — which are TIGHTER than the raw zod schema), have a
 * unique nick, and be a deterministic pure value independent of any IO.
 */

// Small seeded LCG kept around so the file is fully deterministic if any
// pseudo-random sampling is ever needed. No wall-clock / entropy sources used.
function seededLcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Assert one numeric param is inside its declared runtime bound. */
function expectNumericInBounds(
  params: Record<string, unknown>,
  field: string,
  bound: [number, number],
): void {
  const v = params[field];
  expect(typeof v).toBe("number");
  expect(v as number).toBeGreaterThanOrEqual(bound[0]);
  expect(v as number).toBeLessThanOrEqual(bound[1]);
}

/** Walk a genome's top-level numeric/enum params and check against getParamBounds. */
function assertGenomeWithinBounds(g: Genome): void {
  const bounds = getParamBounds(g.kind);
  const params = g.params as Record<string, unknown>;
  for (const [field, b] of Object.entries(bounds)) {
    if (Array.isArray(b) && b.length === 2 && typeof b[0] === "number") {
      expectNumericInBounds(params, field, b as [number, number]);
    } else if (Array.isArray(b) && b.every((x) => typeof x === "string")) {
      // enum field — if present, value must be in the allowed list.
      if (params[field] !== undefined) {
        expect(b as string[]).toContain(params[field]);
      }
    }
  }
}

const PRESETS: Preset[] = aggressivePresets();

describe("aggressivePresets — shape + count", () => {
  it("returns a non-empty array of Preset objects", () => {
    expect(Array.isArray(PRESETS)).toBe(true);
    expect(PRESETS.length).toBeGreaterThan(0);
  });

  it("returns exactly 10 presets (stable table size)", () => {
    expect(PRESETS.length).toBe(10);
  });

  it("every preset has a non-empty string nick and a genome object", () => {
    for (const p of PRESETS) {
      expect(typeof p.nick).toBe("string");
      expect(p.nick.length).toBeGreaterThan(0);
      expect(p.genome).toBeTruthy();
      expect(typeof p.genome).toBe("object");
      expect(typeof p.genome.kind).toBe("string");
      expect(p.genome.params).toBeTruthy();
    }
  });

  it("every preset object has exactly the keys {genome, nick}", () => {
    for (const p of PRESETS) {
      expect(Object.keys(p).sort()).toEqual(["genome", "nick"]);
    }
  });
});

describe("aggressivePresets — validity against the genome schema", () => {
  it("every preset.genome parses cleanly via GenomeSchema", () => {
    for (const p of PRESETS) {
      // throws if the genome is structurally invalid or out of zod bounds.
      const parsed = GenomeSchema.parse(p.genome);
      expect(parsed.kind).toBe(p.genome.kind);
    }
  });

  it("every preset.genome.kind is in the GENOME_KINDS vocabulary", () => {
    for (const p of PRESETS) {
      expect(GENOME_KINDS).toContain(p.genome.kind as GenomeKind);
    }
  });

  it("every preset sits within the (tighter) runtime param bounds", () => {
    for (const p of PRESETS) {
      assertGenomeWithinBounds(p.genome);
    }
  });

  it("genomeNickname is computable for every preset genome", () => {
    for (const p of PRESETS) {
      const nn = genomeNickname(p.genome);
      expect(typeof nn).toBe("string");
      expect(nn.length).toBeGreaterThan(0);
    }
  });
});

describe("aggressivePresets — uniqueness", () => {
  it("all nicks are unique", () => {
    const nicks = PRESETS.map((p) => p.nick);
    expect(new Set(nicks).size).toBe(nicks.length);
  });

  it("nicks all share the 'agg-' prefix convention", () => {
    for (const p of PRESETS) {
      expect(p.nick.startsWith("agg-")).toBe(true);
    }
  });

  it("serialized genomes are all distinct (no accidental duplicate presets)", () => {
    const blobs = PRESETS.map((p) => serializeGenome(p.genome));
    expect(new Set(blobs).size).toBe(blobs.length);
  });
});

describe("aggressivePresets — round-trip + determinism", () => {
  it("serialize → parse round-trips every preset genome unchanged", () => {
    for (const p of PRESETS) {
      const back: Genome = parseGenome(serializeGenome(p.genome));
      expect(back).toEqual(p.genome);
    }
  });

  it("is a pure function — two calls produce deeply-equal output", () => {
    const a = aggressivePresets();
    const b = aggressivePresets();
    expect(a).toEqual(b);
  });

  it("returns fresh objects each call (no shared mutable reference)", () => {
    const a = aggressivePresets();
    const b = aggressivePresets();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0].genome).not.toBe(b[0].genome);
  });

  it("mutating a returned preset does not affect a subsequent call", () => {
    const a = aggressivePresets();
    (a[0] as { nick: string }).nick = "MUTATED";
    const b = aggressivePresets();
    expect(b[0].nick).not.toBe("MUTATED");
  });

  it("ignores the polyConditionIdPool option (no preset uses cross_venue_arb)", () => {
    const withPool = aggressivePresets({ polyConditionIdPool: ["seed-x", "seed-y"] });
    const without = aggressivePresets();
    expect(withPool).toEqual(without);
    expect(withPool.some((p) => p.genome.kind === "cross_venue_arb")).toBe(false);
  });
});

describe("aggressivePresets — entry sizing invariants", () => {
  it("genomes that declare entry_size_usd carry a positive value within bounds", () => {
    for (const p of PRESETS) {
      const params = p.genome.params as Record<string, unknown>;
      // wallet_copy_filtered sizes via max_size_usd instead of entry_size_usd.
      if (params.entry_size_usd === undefined) continue;
      expect(typeof params.entry_size_usd).toBe("number");
      const size = params.entry_size_usd as number;
      expect(size).toBeGreaterThan(0);
      const bounds = getParamBounds(p.genome.kind);
      const b = bounds.entry_size_usd as [number, number];
      expect(size).toBeGreaterThanOrEqual(b[0]);
      expect(size).toBeLessThanOrEqual(b[1]);
    }
  });

  it("wallet_copy_filtered sizes via max_size_usd, not entry_size_usd", () => {
    const wc = PRESETS.find((p) => p.genome.kind === "wallet_copy_filtered");
    expect(wc).toBeDefined();
    if (!wc || wc.genome.kind !== "wallet_copy_filtered") throw new Error("wallet preset missing");
    expect((wc.genome.params as Record<string, unknown>).entry_size_usd).toBeUndefined();
    expect(typeof wc.genome.params.max_size_usd).toBe("number");
    expect(wc.genome.params.max_size_usd).toBeGreaterThan(0);
  });

  it("presets are sized conservatively (every declared USD size <= $25)", () => {
    for (const p of PRESETS) {
      const params = p.genome.params as Record<string, number>;
      // Check whichever sizing field this genome uses.
      const size = params.entry_size_usd ?? params.max_size_usd;
      expect(typeof size).toBe("number");
      expect(size).toBeLessThanOrEqual(25);
    }
  });
});

describe("aggressivePresets — stop/target risk geometry", () => {
  it("Coinbase momentum/mean-reversion stops are positive percentages within bounds", () => {
    for (const p of PRESETS) {
      const params = p.genome.params as Record<string, number>;
      if (p.genome.kind === "cb_momentum_burst") {
        expect(params.stop_pct).toBeGreaterThan(0);
        expect(params.target_pct).toBeGreaterThan(0);
        // momentum preset is tuned at the LOW end → tiny thresholds.
        expect(params.vel_entry_pct).toBeLessThanOrEqual(0.012);
      }
      if (p.genome.kind === "cb_mean_reversion") {
        expect(params.stop_pct).toBeGreaterThan(0);
        // mild contrarian: z_entry at the low (1.0) bound.
        expect(params.z_entry).toBeGreaterThanOrEqual(1.0);
        expect(params.z_entry).toBeLessThanOrEqual(2.5);
      }
    }
  });

  it("Polymarket point-based presets have stop wider than target (fade geometry)", () => {
    for (const p of PRESETS) {
      const params = p.genome.params as Record<string, number>;
      if (p.genome.kind === "poly_fade_spike" || p.genome.kind === "category_specialist") {
        if (params.stop_pts !== undefined && params.exit_target_pts !== undefined) {
          expect(params.stop_pts).toBeGreaterThan(params.exit_target_pts);
        }
      }
    }
  });
});

describe("aggressivePresets — multi_strategy composite", () => {
  const multi = PRESETS.find((p) => p.genome.kind === "multi_strategy");

  it("contains exactly one multi_strategy preset", () => {
    expect(PRESETS.filter((p) => p.genome.kind === "multi_strategy").length).toBe(1);
  });

  it("its subs are all valid SUB-genomes (no nested composites)", () => {
    expect(multi).toBeDefined();
    if (!multi || multi.genome.kind !== "multi_strategy") throw new Error("multi preset missing");
    const subs = multi.genome.params.subs;
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs.length).toBeLessThanOrEqual(4);
    for (const sub of subs) {
      // SubGenomeSchema excludes multi_strategy — parse enforces that.
      SubGenomeSchema.parse(sub);
      expect(SUB_GENOME_KINDS).toContain(sub.kind);
      expect(sub.kind).not.toBe("multi_strategy");
    }
  });

  it("uses priority selection (the only supported mode)", () => {
    if (!multi || multi.genome.kind !== "multi_strategy") throw new Error("multi preset missing");
    expect(multi.genome.params.selection).toBe("priority");
  });
});

describe("aggressivePresets — wallet + token field formats", () => {
  it("wallet_copy_filtered presets use a valid 0x-prefixed 40-hex address", () => {
    for (const p of PRESETS) {
      if (p.genome.kind === "wallet_copy_filtered") {
        expect(p.genome.params.wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        // win-rate / trade-count filters must be inside their gating bounds.
        expect(p.genome.params.min_source_win_rate).toBeGreaterThanOrEqual(0.4);
        expect(p.genome.params.min_source_win_rate).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it("polymarket_market_maker preset uses a token_id that parses (sentinel 'any' allowed)", () => {
    for (const p of PRESETS) {
      if (p.genome.kind === "polymarket_market_maker") {
        expect(typeof p.genome.params.token_id).toBe("string");
        expect(p.genome.params.token_id.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("poly_short_binary_directional preset assets CSV is non-trivial and splits cleanly", () => {
    for (const p of PRESETS) {
      if (p.genome.kind === "poly_short_binary_directional") {
        const assets = p.genome.params.assets.split(",").filter(Boolean);
        expect(assets.length).toBeGreaterThanOrEqual(2);
        for (const a of assets) expect(a.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("aggressivePresets — coverage + diversity", () => {
  it("covers several distinct strategy kinds (diverse gene pool seed)", () => {
    const kinds = new Set(PRESETS.map((p) => p.genome.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });

  it("includes the random_walk_baseline null hypothesis control", () => {
    expect(PRESETS.some((p) => p.genome.kind === "random_walk_baseline")).toBe(true);
  });

  it("random_walk_baseline preset has a meaningful trade_prob within bounds", () => {
    const rw = PRESETS.find((p) => p.genome.kind === "random_walk_baseline");
    expect(rw).toBeDefined();
    if (!rw || rw.genome.kind !== "random_walk_baseline") throw new Error("rw missing");
    const b = getParamBounds("random_walk_baseline").trade_prob as [number, number];
    expect(rw.genome.params.trade_prob).toBeGreaterThanOrEqual(b[0]);
    expect(rw.genome.params.trade_prob).toBeLessThanOrEqual(b[1]);
    // "with teeth" — aggressive preset should fire reasonably often.
    expect(rw.genome.params.trade_prob).toBeGreaterThanOrEqual(0.05);
  });

  it("a seeded LCG over preset indices always lands on a valid preset (determinism smoke)", () => {
    const rng = seededLcg(7);
    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(rng() * PRESETS.length);
      const p = PRESETS[idx];
      expect(p).toBeDefined();
      GenomeSchema.parse(p.genome);
    }
  });
});
