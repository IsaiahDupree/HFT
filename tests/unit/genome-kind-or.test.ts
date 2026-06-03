import { describe, it, expect } from "vitest";
import { genomeKindOr } from "@/lib/arena/genome";

const VALID = JSON.stringify({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 25 } });

describe("genomeKindOr — safe genome.kind resolution (live-capsule strategyKind)", () => {
  it("returns the kind for a valid genome_json", () => {
    expect(genomeKindOr(VALID, "sim-coinbase")).toBe("random_walk_baseline");
  });

  it("falls back when the json is missing/empty", () => {
    expect(genomeKindOr(null, "sim-poly")).toBe("sim-poly");
    expect(genomeKindOr(undefined, "sim-poly")).toBe("sim-poly");
    expect(genomeKindOr("", "sim-poly")).toBe("sim-poly");
  });

  it("falls back on malformed JSON (never throws)", () => {
    expect(genomeKindOr("{not json", "sim-coinbase")).toBe("sim-coinbase");
  });

  it("falls back on a schema-invalid genome (wrong kind / bad params)", () => {
    expect(genomeKindOr(JSON.stringify({ kind: "not_a_real_kind", params: {} }), "venue-x")).toBe("venue-x");
    expect(genomeKindOr(JSON.stringify({ kind: "random_walk_baseline", params: { trade_prob: "bad" } }), "venue-x")).toBe("venue-x");
  });

  it("returns a genome kind (a SubGenomeKind), not the venue, when valid — so the regime-fit table keys correctly", () => {
    const kind = genomeKindOr(VALID, "sim-coinbase");
    expect(kind).not.toBe("sim-coinbase");          // it's the genome kind, not the venue fallback
    expect(kind).toBe("random_walk_baseline");
  });

  it("is deterministic", () => {
    expect(genomeKindOr(VALID, "v")).toBe(genomeKindOr(VALID, "v"));
  });
});
