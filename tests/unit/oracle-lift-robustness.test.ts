/**
 * Robustness / invariant / edge-case tests for oracle signal lift
 * (src/lib/oracle/lift.ts) — complementary to oracle-lift.test.ts.
 *
 * Focus: Wilson-bound bounds & monotonicity, bucket invariants (n>=wins,
 * win in [0,1], winCiLow<=win), agreement-band partitioning, side-agree /
 * zone null handling, agreement=1 on all-correct inputs, staleness isolation,
 * and full determinism. All inputs are pure/synthetic constructed from the
 * exported types; a seeded LCG provides any pseudo-randomness so the file is
 * deterministic — no DB, network, files, wall-clock, or entropy source.
 */
import { describe, expect, it } from "vitest";
import { wilsonLower, oracleLift, type OraclePair, type Bucket, type OracleLift } from "@/lib/oracle/lift";

// --- deterministic helpers -------------------------------------------------

/** Tiny seeded LCG (Numerical Recipes constants) -> floats in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pair(over: Partial<OraclePair> = {}): OraclePair {
  return {
    agreement_score: 0.9,
    side_agree: true,
    chainlink_zone: "fresh",
    favored_up: true,
    resolved_up: true,
    ...over,
  };
}

/** All buckets in a lift result, flattened. */
function allBuckets(lift: OracleLift): Bucket[] {
  return [lift.baseline, ...lift.byAgreement, ...lift.bySideAgree, ...lift.byZone];
}

// --- wilsonLower -----------------------------------------------------------

describe("wilsonLower — bounds & invariants", () => {
  it("returns 0 for non-positive n (including negative)", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(5, 0)).toBe(0);
    expect(wilsonLower(3, -1)).toBe(0);
  });

  it("stays within [0,1] across a swept grid of (wins,n)", () => {
    const rng = lcg(1234567);
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rng() * 500);
      const wins = Math.floor(rng() * (n + 1)); // 0..n inclusive
      const lo = wilsonLower(wins, n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(1);
    }
  });

  it("is strictly below the point estimate p for an interior win rate", () => {
    // p = 0.5 with finite n -> lower bound must sit under p.
    expect(wilsonLower(50, 100)).toBeLessThan(0.5);
    expect(wilsonLower(20, 40)).toBeLessThan(0.5);
  });

  it("is exactly 0 when there are zero wins (p=0)", () => {
    expect(wilsonLower(0, 1)).toBe(0);
    expect(wilsonLower(0, 25)).toBe(0);
    expect(wilsonLower(0, 1000)).toBe(0);
  });

  it("is below 1 even at a perfect win rate (never asserts certainty)", () => {
    expect(wilsonLower(10, 10)).toBeLessThan(1);
    expect(wilsonLower(1000, 1000)).toBeLessThan(1);
    expect(wilsonLower(1000, 1000)).toBeGreaterThan(0.99); // but very close
  });

  it("for a fixed win rate, tightens (rises) monotonically toward p as n grows", () => {
    // p held at 0.8; lower bound should be non-decreasing in n.
    const seq = [5, 10, 25, 50, 100, 250, 500].map((n) => wilsonLower(Math.round(0.8 * n), n));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
    // and it converges below 0.8.
    expect(seq[seq.length - 1]).toBeLessThan(0.8);
    expect(seq[seq.length - 1]).toBeGreaterThan(0.7);
  });

  it("a larger z (wider confidence) lowers the lower bound", () => {
    // 90% (z≈1.645) bound > 95% (z=1.96) bound > 99% (z≈2.576) bound.
    const p90 = wilsonLower(80, 100, 1.645);
    const p95 = wilsonLower(80, 100, 1.96);
    const p99 = wilsonLower(80, 100, 2.576);
    expect(p90).toBeGreaterThan(p95);
    expect(p95).toBeGreaterThan(p99);
  });

  it("z=0 collapses the interval to the point estimate", () => {
    expect(wilsonLower(80, 100, 0)).toBeCloseTo(0.8, 12);
    expect(wilsonLower(1, 4, 0)).toBeCloseTo(0.25, 12);
  });

  it("is symmetric under win<->loss reflection: lower(wins,n)=1-upper(n-wins,n)", () => {
    // The Wilson bound is symmetric; the lower bound of (wins/n) equals
    // 1 minus the *upper* bound of (loss/n). We reconstruct the upper bound
    // from the same closed form to confirm internal consistency.
    const upper = (w: number, n: number, z = 1.96) => {
      const p = w / n;
      const z2 = z * z;
      const denom = 1 + z2 / n;
      const center = p + z2 / (2 * n);
      const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
      return (center + margin) / denom;
    };
    const wins = 30;
    const n = 100;
    expect(wilsonLower(wins, n)).toBeCloseTo(1 - upper(n - wins, n), 12);
  });

  it("is deterministic — identical args give identical output", () => {
    expect(wilsonLower(7, 13)).toBe(wilsonLower(7, 13));
    expect(wilsonLower(123, 456, 2.1)).toBe(wilsonLower(123, 456, 2.1));
  });
});

// --- oracleLift: baseline & structure --------------------------------------

describe("oracleLift — baseline & structure", () => {
  it("empty input zeroes every bucket and produces the full label set", () => {
    const lift = oracleLift([]);
    for (const b of allBuckets(lift)) {
      expect(b.n).toBe(0);
      expect(b.wins).toBe(0);
      expect(b.win).toBe(0);
      expect(b.winCiLow).toBe(0);
      expect(b.winLift).toBe(0);
    }
    expect(lift.byAgreement.map((b) => b.label)).toEqual(["agree <0.50", "agree 0.50–0.75", "agree ≥0.75"]);
    expect(lift.bySideAgree.map((b) => b.label)).toEqual(["side agree", "side STRADDLE"]);
    expect(lift.byZone.map((b) => b.label)).toEqual(["chainlink fresh", "chainlink aging", "chainlink stale"]);
  });

  it("baseline n equals the full input length and baseline winLift is exactly 0", () => {
    const pairs = [
      pair({ favored_up: true, resolved_up: true }),
      pair({ favored_up: true, resolved_up: false }),
      pair({ favored_up: false, resolved_up: false }),
    ];
    const lift = oracleLift(pairs);
    expect(lift.baseline.n).toBe(pairs.length);
    // baseline is measured against itself, so lift is always 0.
    expect(lift.baseline.winLift).toBe(0);
  });

  it("baseline win counts a 'win' as favored_up === resolved_up (both directions)", () => {
    const pairs = [
      pair({ favored_up: true, resolved_up: true }), // win
      pair({ favored_up: false, resolved_up: false }), // win (down predicted, down happened)
      pair({ favored_up: true, resolved_up: false }), // loss
      pair({ favored_up: false, resolved_up: true }), // loss
    ];
    const lift = oracleLift(pairs);
    expect(lift.baseline.wins).toBe(2);
    expect(lift.baseline.win).toBe(0.5);
  });

  it("a perfectly-favored deck gives baseline win=1 and a wilson-bounded ci below 1", () => {
    const pairs = Array.from({ length: 12 }, () => pair({ favored_up: true, resolved_up: true }));
    const lift = oracleLift(pairs);
    expect(lift.baseline.win).toBe(1);
    expect(lift.baseline.winCiLow).toBeLessThan(1);
    expect(lift.baseline.winCiLow).toBeGreaterThan(0);
  });
});

// --- oracleLift: per-bucket invariants over random decks -------------------

describe("oracleLift — per-bucket invariants", () => {
  /** Build a random deck deterministically from a seed. */
  function deck(seed: number, len: number): OraclePair[] {
    const rng = lcg(seed);
    const zones = ["fresh", "aging", "stale", "other", null] as Array<string | null>;
    return Array.from({ length: len }, () => {
      const r = rng();
      return {
        agreement_score: r < 0.1 ? null : Number(rng().toFixed(4)),
        side_agree: rng() < 0.2 ? null : rng() < 0.5,
        chainlink_zone: zones[Math.floor(rng() * zones.length)],
        favored_up: rng() < 0.5,
        resolved_up: rng() < 0.5,
      };
    });
  }

  it("every bucket obeys 0<=wins<=n and win in [0,1] and winCiLow<=win", () => {
    for (const seed of [1, 42, 777, 2024, 99999]) {
      const lift = oracleLift(deck(seed, 80));
      for (const b of allBuckets(lift)) {
        expect(b.wins).toBeGreaterThanOrEqual(0);
        expect(b.wins).toBeLessThanOrEqual(b.n);
        expect(b.win).toBeGreaterThanOrEqual(0);
        expect(b.win).toBeLessThanOrEqual(1);
        expect(b.winCiLow).toBeGreaterThanOrEqual(0);
        expect(b.winCiLow).toBeLessThanOrEqual(1);
        // the conservative lower bound never exceeds the point estimate
        // (allowing tiny rounding slack since both are rounded to 4dp).
        expect(b.winCiLow).toBeLessThanOrEqual(b.win + 1e-9);
      }
    }
  });

  it("winLift equals (bucket win - baseline raw win) within rounding", () => {
    const lift = oracleLift(deck(31337, 60));
    const rawBase = lift.baseline.n ? lift.baseline.wins / lift.baseline.n : 0;
    for (const b of allBuckets(lift)) {
      // winLift is rounded to 4dp; reconstruct from the rounded win field.
      expect(b.winLift).toBeCloseTo(Number((b.win - rawBase).toFixed(4)), 4);
    }
  });

  it("all numeric bucket fields are rounded to at most 4 decimal places", () => {
    const lift = oracleLift(deck(8675309, 70));
    for (const b of allBuckets(lift)) {
      for (const v of [b.win, b.winCiLow, b.winLift]) {
        expect(Number(v.toFixed(4))).toBe(v);
      }
    }
  });
});

// --- oracleLift: agreement-band partitioning -------------------------------

describe("oracleLift — agreement band partitioning", () => {
  it("non-null-score rows partition exactly across the three agreement bands", () => {
    const rng = lcg(5150);
    const pairs = Array.from({ length: 90 }, (_, i) => {
      // ~1 in 9 rows has a null score (excluded from all bands).
      const score = i % 9 === 0 ? null : Number(rng().toFixed(4));
      return pair({ agreement_score: score });
    });
    const nonNull = pairs.filter((p) => p.agreement_score != null).length;
    const lift = oracleLift(pairs);
    const banded = lift.byAgreement.reduce((s, b) => s + b.n, 0);
    expect(banded).toBe(nonNull); // bands cover every non-null score, no double count
  });

  it("band boundaries are correct: 0.49<0.50, 0.50 in mid, 0.7499 in mid, 0.75 in hi", () => {
    const pairs = [
      pair({ agreement_score: 0.49 }), // band 1: <0.50
      pair({ agreement_score: 0.5 }), // band 2: 0.50–0.75
      pair({ agreement_score: 0.7499 }), // band 2
      pair({ agreement_score: 0.75 }), // band 3: ≥0.75
      pair({ agreement_score: 1.0 }), // band 3
      pair({ agreement_score: 0 }), // band 1
    ];
    const lift = oracleLift(pairs);
    const [lo, mid, hi] = lift.byAgreement;
    expect(lo.n).toBe(2); // 0.49, 0
    expect(mid.n).toBe(2); // 0.5, 0.7499
    expect(hi.n).toBe(2); // 0.75, 1.0
  });

  it("a null agreement_score is excluded from all three agreement bands", () => {
    const pairs = [pair({ agreement_score: null }), pair({ agreement_score: null })];
    const lift = oracleLift(pairs);
    const banded = lift.byAgreement.reduce((s, b) => s + b.n, 0);
    expect(banded).toBe(0);
    expect(lift.baseline.n).toBe(2); // but baseline still counts them
  });
});

// --- oracleLift: side-agree & zone selection -------------------------------

describe("oracleLift — side-agree & zone selection", () => {
  it("side_agree splits strictly on true/false; null lands in neither bucket", () => {
    const pairs = [
      pair({ side_agree: true }),
      pair({ side_agree: true }),
      pair({ side_agree: false }),
      pair({ side_agree: null }),
    ];
    const lift = oracleLift(pairs);
    const agree = lift.bySideAgree.find((b) => b.label === "side agree")!;
    const straddle = lift.bySideAgree.find((b) => b.label === "side STRADDLE")!;
    expect(agree.n).toBe(2);
    expect(straddle.n).toBe(1);
    expect(agree.n + straddle.n).toBe(3); // the null row is excluded
  });

  it("zone buckets match exact strings only; unknown/null zones are excluded", () => {
    const pairs = [
      pair({ chainlink_zone: "fresh" }),
      pair({ chainlink_zone: "aging" }),
      pair({ chainlink_zone: "stale" }),
      pair({ chainlink_zone: "FRESH" }), // wrong case -> excluded
      pair({ chainlink_zone: "unknown" }),
      pair({ chainlink_zone: null }),
    ];
    const lift = oracleLift(pairs);
    expect(lift.byZone.find((b) => b.label === "chainlink fresh")!.n).toBe(1);
    expect(lift.byZone.find((b) => b.label === "chainlink aging")!.n).toBe(1);
    expect(lift.byZone.find((b) => b.label === "chainlink stale")!.n).toBe(1);
    const zoned = lift.byZone.reduce((s, b) => s + b.n, 0);
    expect(zoned).toBe(3); // FRESH / unknown / null all excluded
  });

  it("a clean all-agreeing deck yields agreement=1 (win=1) in every populated bucket", () => {
    // Construct rows where the favored side ALWAYS wins -> point win rate 1.0
    // ("agreement=1 on equal inputs": predicted direction == resolved direction).
    const pairs = [
      ...Array.from({ length: 4 }, () => pair({ agreement_score: 0.9, side_agree: true, chainlink_zone: "fresh", favored_up: true, resolved_up: true })),
      ...Array.from({ length: 4 }, () => pair({ agreement_score: 0.6, side_agree: true, chainlink_zone: "aging", favored_up: false, resolved_up: false })),
      ...Array.from({ length: 4 }, () => pair({ agreement_score: 0.2, side_agree: true, chainlink_zone: "stale", favored_up: true, resolved_up: true })),
    ];
    const lift = oracleLift(pairs);
    for (const b of allBuckets(lift)) {
      if (b.n > 0) expect(b.win).toBe(1);
    }
    // no STRADDLE rows exist, so that bucket is empty.
    expect(lift.bySideAgree.find((b) => b.label === "side STRADDLE")!.n).toBe(0);
  });
});

// --- oracleLift: hypothesis sign & staleness isolation ----------------------

describe("oracleLift — hypothesis sign & staleness", () => {
  it("a stale-feed losing streak makes the stale bucket lift negative", () => {
    const pairs = [
      ...Array.from({ length: 8 }, () => pair({ chainlink_zone: "fresh", favored_up: true, resolved_up: true })),
      ...Array.from({ length: 8 }, () => pair({ chainlink_zone: "stale", favored_up: true, resolved_up: false })),
    ];
    const lift = oracleLift(pairs);
    const fresh = lift.byZone.find((b) => b.label === "chainlink fresh")!;
    const stale = lift.byZone.find((b) => b.label === "chainlink stale")!;
    expect(fresh.win).toBe(1);
    expect(fresh.winLift).toBeGreaterThan(0); // beats the 50% blended baseline
    expect(stale.win).toBe(0);
    expect(stale.winLift).toBeLessThan(0); // the risk filter fires
    // the two lifts are mirror images around the blended baseline.
    expect(fresh.winLift).toBeCloseTo(-stale.winLift, 4);
  });

  it("low-agreement windows underperform high-agreement windows (the core hypothesis)", () => {
    const pairs = [
      ...Array.from({ length: 10 }, () => pair({ agreement_score: 0.9, favored_up: true, resolved_up: true })),
      ...Array.from({ length: 10 }, (_, i) => pair({ agreement_score: 0.2, favored_up: true, resolved_up: i % 5 === 0 })),
    ];
    const lift = oracleLift(pairs);
    const hi = lift.byAgreement.find((b) => b.label === "agree ≥0.75")!;
    const lo = lift.byAgreement.find((b) => b.label === "agree <0.50")!;
    expect(hi.win).toBeGreaterThan(lo.win);
    expect(hi.winLift).toBeGreaterThan(lo.winLift);
  });
});

// --- oracleLift: determinism & order-independence ---------------------------

describe("oracleLift — determinism", () => {
  function deck(seed: number, len: number): OraclePair[] {
    const rng = lcg(seed);
    const zones = ["fresh", "aging", "stale", null] as Array<string | null>;
    return Array.from({ length: len }, () => ({
      agreement_score: rng() < 0.1 ? null : Number(rng().toFixed(4)),
      side_agree: rng() < 0.2 ? null : rng() < 0.5,
      chainlink_zone: zones[Math.floor(rng() * zones.length)],
      favored_up: rng() < 0.5,
      resolved_up: rng() < 0.5,
    }));
  }

  it("identical input yields byte-identical output (no hidden state)", () => {
    const a = oracleLift(deck(424242, 50));
    const b = oracleLift(deck(424242, 50));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("aggregate stats are invariant under input row reordering", () => {
    const base = deck(13, 64);
    // deterministic shuffle via a second LCG (no entropy / wall-clock).
    const rng = lcg(98765);
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = oracleLift(base);
    const b = oracleLift(shuffled);
    // labels and counts/wins/win/ci/lift are all order-independent.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the input array or its rows", () => {
    const pairs = [pair({ agreement_score: 0.3 }), pair({ side_agree: null })];
    const snapshot = JSON.stringify(pairs);
    const len = pairs.length;
    oracleLift(pairs);
    expect(pairs.length).toBe(len);
    expect(JSON.stringify(pairs)).toBe(snapshot);
  });
});
