import { describe, expect, it } from "vitest";
import {
  bayesianUpdate,
  bayesianUpdateFromLikelihoods,
  expectedValue,
  kellyFraction,
} from "@/lib/quant/formulas";
import type { EVInput, KellyInput } from "@/lib/quant/formulas";

// Deterministic seeded LCG — no Math.random, no wall-clock. Any pseudo-random
// probabilities used below are fully reproducible across runs/machines.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000; // in [0, 1)
  };
}
// Pull a probability strictly inside (0,1) so divisions in the formulas are safe.
const probIn = (rng: () => number): number => 0.02 + rng() * 0.96;

describe("expectedValue — invariants and edges (robustness)", () => {
  it("evPerDollar equals the probability edge (pTrue - pMarket) exactly for all interior inputs", () => {
    // Algebraically EV = pT*(1-pM) - (1-pT)*pM = pT - pM. Verify on many seeded pairs.
    const rng = lcg(12345);
    for (let i = 0; i < 200; i++) {
      const pTrue = probIn(rng);
      const pMarket = probIn(rng);
      const r = expectedValue({ pTrue, pMarket });
      expect(r.evPerDollar).toBeCloseTo(pTrue - pMarket, 12);
      expect(r.edgeProb).toBeCloseTo(pTrue - pMarket, 12);
      // The two reported quantities are the same number for this formula.
      expect(r.evPerDollar).toBeCloseTo(r.edgeProb, 12);
    }
  });

  it("is zero at no-edge (pTrue == pMarket) and recommends SKIP", () => {
    const rng = lcg(777);
    for (let i = 0; i < 50; i++) {
      const p = probIn(rng);
      const r = expectedValue({ pTrue: p, pMarket: p });
      expect(r.evPerDollar).toBeCloseTo(0, 12);
      expect(r.edgeProb).toBeCloseTo(0, 12);
      expect(r.recommendation).toBe("SKIP");
    }
  });

  it("evPerDollar is bounded in [-1, 1] for any clamped inputs", () => {
    const rng = lcg(2024);
    for (let i = 0; i < 300; i++) {
      // Deliberately include out-of-range values to exercise clamping.
      const pTrue = rng() * 3 - 1; // [-1, 2)
      const pMarket = rng() * 3 - 1;
      const r = expectedValue({ pTrue, pMarket });
      expect(r.evPerDollar).toBeGreaterThanOrEqual(-1);
      expect(r.evPerDollar).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.evPerDollar)).toBe(true);
    }
  });

  it("is strictly monotonic increasing in pTrue for fixed pMarket", () => {
    const pMarket = 0.5;
    let prev = -Infinity;
    for (let k = 0; k <= 20; k++) {
      const pTrue = k / 20; // 0.0 .. 1.0
      const ev = expectedValue({ pTrue, pMarket }).evPerDollar;
      expect(ev).toBeGreaterThan(prev);
      prev = ev;
    }
  });

  it("is strictly monotonic decreasing in pMarket for fixed pTrue", () => {
    const pTrue = 0.5;
    let prev = Infinity;
    for (let k = 0; k <= 20; k++) {
      const pMarket = k / 20;
      const ev = expectedValue({ pTrue, pMarket }).evPerDollar;
      expect(ev).toBeLessThan(prev);
      prev = ev;
    }
  });

  it("sign mirrors edge direction: positive when pTrue>pMarket, negative when pTrue<pMarket", () => {
    expect(Math.sign(expectedValue({ pTrue: 0.7, pMarket: 0.3 }).evPerDollar)).toBe(1);
    expect(Math.sign(expectedValue({ pTrue: 0.3, pMarket: 0.7 }).evPerDollar)).toBe(-1);
  });

  it("evUsd scales linearly with stake and is null when stake omitted", () => {
    const base = expectedValue({ pTrue: 0.6, pMarket: 0.4 });
    expect(base.evUsd).toBeNull();
    const s1 = expectedValue({ pTrue: 0.6, pMarket: 0.4, stakeUsd: 100 });
    const s2 = expectedValue({ pTrue: 0.6, pMarket: 0.4, stakeUsd: 1000 });
    expect(s1.evUsd).toBeCloseTo(base.evPerDollar * 100, 9);
    expect(s2.evUsd!).toBeCloseTo(s1.evUsd! * 10, 9);
  });

  it("recommendation tiers are correct on either side of the thresholds", () => {
    // Thresholds: STRONG_EDGE >= 0.10, EDGE >= 0.05, FADE <= -0.05, else SKIP.
    // Use values whose float EV is unambiguous (avoid the exact-boundary 0.099999.. trap).
    expect(expectedValue({ pTrue: 0.62, pMarket: 0.5 }).recommendation).toBe("STRONG_EDGE"); // ev 0.12
    expect(expectedValue({ pTrue: 0.56, pMarket: 0.5 }).recommendation).toBe("EDGE"); // ev 0.06
    expect(expectedValue({ pTrue: 0.54, pMarket: 0.5 }).recommendation).toBe("SKIP"); // ev 0.04
    expect(expectedValue({ pTrue: 0.44, pMarket: 0.5 }).recommendation).toBe("FADE"); // ev -0.06
    expect(expectedValue({ pTrue: 0.47, pMarket: 0.5 }).recommendation).toBe("SKIP"); // ev -0.03
  });

  it("guards NaN/Infinity inputs by clamping to 0 (no NaN leaks into the result)", () => {
    const r = expectedValue({ pTrue: NaN, pMarket: Infinity } as unknown as EVInput);
    // both clamp to 0 → EV = 0*1 - 1*0 = 0
    expect(r.evPerDollar).toBe(0);
    expect(r.edgeProb).toBe(0);
    expect(Number.isNaN(r.evPerDollar)).toBe(false);
  });

  it("is deterministic — identical inputs yield identical output objects", () => {
    const input: EVInput = { pTrue: 0.63, pMarket: 0.41, stakeUsd: 250 };
    const a = expectedValue(input);
    const b = expectedValue({ ...input });
    expect(a).toEqual(b);
  });
});

describe("kellyFraction — bounds, direction, monotonicity (robustness)", () => {
  it("recommendedFraction is always within [0, maxFraction] for arbitrary seeded inputs", () => {
    const rng = lcg(99);
    for (let i = 0; i < 300; i++) {
      const pTrue = probIn(rng);
      const pMarket = probIn(rng);
      const maxFraction = 0.05 + rng() * 0.4; // 0.05 .. 0.45
      const r = kellyFraction({ pTrue, pMarket, bankrollUsd: 1000, maxFraction });
      expect(r.recommendedFraction).toBeGreaterThanOrEqual(0);
      expect(r.recommendedFraction).toBeLessThanOrEqual(maxFraction + 1e-12);
      expect(Number.isFinite(r.recommendedFraction)).toBe(true);
    }
  });

  it("betUsd never exceeds bankroll * maxFraction and is never negative", () => {
    const rng = lcg(31337);
    for (let i = 0; i < 300; i++) {
      const pTrue = probIn(rng);
      const pMarket = probIn(rng);
      const bankrollUsd = 100 + rng() * 1_000_000;
      const maxFraction = 0.1 + rng() * 0.3;
      const r = kellyFraction({ pTrue, pMarket, bankrollUsd, maxFraction });
      expect(r.betUsd).toBeGreaterThanOrEqual(0);
      expect(r.betUsd).toBeLessThanOrEqual(bankrollUsd * maxFraction + 1e-6);
    }
  });

  it("has (at most) negligible Kelly size when there is no edge (pTrue == pMarket)", () => {
    // Closed form: full Kelly on no-edge is exactly 0, so any nonzero is pure
    // floating-point residue (< 1 part in 1e9). The bet must therefore be tiny.
    const rng = lcg(5150);
    for (let i = 0; i < 50; i++) {
      const p = probIn(rng);
      const r = kellyFraction({ pTrue: p, pMarket: p, bankrollUsd: 10_000 });
      expect(Math.abs(r.fullKellyFraction)).toBeLessThan(1e-9);
      expect(r.recommendedFraction).toBeLessThan(1e-9);
      expect(r.betUsd).toBeLessThan(1e-4); // 10_000 * <1e-9 quarter-kelly
      expect(["SKIP", "BUY_YES", "BUY_NO"]).toContain(r.side); // direction is ambiguous on exact ties
    }
  });

  it("recommends SKIP with exact-zero size on exactly-representable no-edge prices", () => {
    // These probabilities make pTrue - (1-pTrue)/((1-p)/p) evaluate to a clean 0.
    for (const p of [0.5, 0.25, 0.75, 0.125, 0.4, 0.2, 0.8, 0.1, 0.9]) {
      const r = kellyFraction({ pTrue: p, pMarket: p, bankrollUsd: 10_000 });
      expect(r.side).toBe("SKIP");
      expect(r.fullKellyFraction).toBe(0);
      expect(r.recommendedFraction).toBe(0);
      expect(r.betUsd).toBe(0);
    }
  });

  it("picks the correct side: BUY_YES when pTrue>pMarket, BUY_NO when pTrue<pMarket", () => {
    const rng = lcg(424242);
    for (let i = 0; i < 200; i++) {
      const pTrue = probIn(rng);
      const pMarket = probIn(rng);
      const r = kellyFraction({ pTrue, pMarket, bankrollUsd: 1000 });
      if (pTrue > pMarket) expect(r.side).toBe("BUY_YES");
      else if (pTrue < pMarket) expect(r.side).toBe("BUY_NO");
      else expect(r.side).toBe("SKIP");
    }
  });

  it("full Kelly on the YES side matches the closed form (pTrue - pMarket)/(1 - pMarket)", () => {
    const rng = lcg(8080);
    for (let i = 0; i < 100; i++) {
      const pMarket = probIn(rng);
      // ensure positive YES edge
      const pTrue = Math.min(0.999, pMarket + 0.001 + rng() * (1 - pMarket - 0.001));
      const r = kellyFraction({ pTrue, pMarket, bankrollUsd: 1000, fraction: 1, maxFraction: 1 });
      if (r.side === "BUY_YES") {
        const expected = (pTrue - pMarket) / (1 - pMarket);
        expect(r.fullKellyFraction).toBeCloseTo(expected, 9);
      }
    }
  });

  it("fullKellyFraction is monotonic non-decreasing in pTrue along the YES side", () => {
    const pMarket = 0.4;
    let prev = -Infinity;
    for (let k = 0; k <= 30; k++) {
      const pTrue = pMarket + (k / 30) * (1 - pMarket); // from pMarket up to 1
      const r = kellyFraction({ pTrue, pMarket, bankrollUsd: 1000, fraction: 1, maxFraction: 1 });
      // Once we are on the YES side the full Kelly should grow with confidence.
      if (r.side === "BUY_YES") {
        expect(r.fullKellyFraction).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = r.fullKellyFraction;
      }
    }
  });

  it("scaling: recommendedFraction is fraction-linear when the maxFraction clamp is not binding", () => {
    // pTrue=0.55, pMarket=0.50 → small full Kelly, so quarter vs half stay under any loose cap.
    const quarter = kellyFraction({ pTrue: 0.55, pMarket: 0.5, bankrollUsd: 1000, fraction: 0.25, maxFraction: 1 });
    const half = kellyFraction({ pTrue: 0.55, pMarket: 0.5, bankrollUsd: 1000, fraction: 0.5, maxFraction: 1 });
    const full = kellyFraction({ pTrue: 0.55, pMarket: 0.5, bankrollUsd: 1000, fraction: 1, maxFraction: 1 });
    expect(half.recommendedFraction).toBeCloseTo(quarter.recommendedFraction * 2, 9);
    expect(full.recommendedFraction).toBeCloseTo(quarter.recommendedFraction * 4, 9);
  });

  it("maxFraction clamp binds at near-degenerate market prices (Kelly asymptote)", () => {
    // pMarket=0.01, pTrue=0.5 → b=99, full Kelly ~0.495; even quarter (~0.124) hits a 0.05 cap.
    const r = kellyFraction({ pTrue: 0.5, pMarket: 0.01, bankrollUsd: 1000, fraction: 0.25, maxFraction: 0.05 });
    expect(r.side).toBe("BUY_YES");
    expect(r.recommendedFraction).toBe(0.05);
    expect(r.betUsd).toBeCloseTo(50, 9);
  });

  it("treats degenerate market prices (pMarket 0 or 1) as untradeable → SKIP, zero bet", () => {
    // kellyForSide guards pMarket<=0 || pMarket>=1 → 0. The mirror side maps a
    // boundary to the OTHER boundary (1-1=0, 1-0=1), so it is also guarded to 0.
    // Net: both 0 → SKIP regardless of pTrue.
    for (const pTrue of [0, 0.25, 0.5, 0.75, 1]) {
      const atOne = kellyFraction({ pTrue, pMarket: 1, bankrollUsd: 1000 });
      expect(atOne.side).toBe("SKIP");
      expect(atOne.betUsd).toBe(0);
      const atZero = kellyFraction({ pTrue, pMarket: 0, bankrollUsd: 1000 });
      expect(atZero.side).toBe("SKIP");
      expect(atZero.betUsd).toBe(0);
    }
  });

  it("clamps negative bankroll to 0 → bet is 0 even when an edge exists", () => {
    const r = kellyFraction({ pTrue: 0.7, pMarket: 0.3, bankrollUsd: -5000 });
    expect(r.side).toBe("BUY_YES"); // edge still detected
    expect(r.betUsd).toBe(0); // but nothing to stake
    expect(r.recommendedFraction).toBeGreaterThan(0);
  });

  it("guards NaN inputs without producing NaN sizing", () => {
    const r = kellyFraction({ pTrue: NaN, pMarket: NaN, bankrollUsd: NaN } as unknown as KellyInput);
    expect(r.side).toBe("SKIP");
    expect(Number.isNaN(r.betUsd)).toBe(false);
    expect(r.betUsd).toBe(0);
  });

  it("is deterministic — identical inputs yield identical results", () => {
    const input: KellyInput = { pTrue: 0.62, pMarket: 0.38, bankrollUsd: 12_345, fraction: 0.3, maxFraction: 0.15 };
    expect(kellyFraction(input)).toEqual(kellyFraction({ ...input }));
  });
});

describe("bayesianUpdate — probability invariants (robustness)", () => {
  it("posterior always stays in [0,1] across seeded interior inputs", () => {
    const rng = lcg(1009);
    for (let i = 0; i < 300; i++) {
      const prior = probIn(rng);
      const likelihoodIfH = probIn(rng);
      const likelihoodOverall = probIn(rng);
      const r = bayesianUpdate({ prior, likelihoodIfH, likelihoodOverall });
      expect(r.posterior).toBeGreaterThanOrEqual(0);
      expect(r.posterior).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.posterior)).toBe(true);
    }
  });

  it("bayesFactor sign matches whether evidence supports H (>1) or not (<1)", () => {
    const support = bayesianUpdate({ prior: 0.5, likelihoodIfH: 0.9, likelihoodOverall: 0.5 });
    expect(support.bayesFactor).toBeGreaterThan(1);
    expect(support.posterior).toBeGreaterThan(0.5);
    const against = bayesianUpdate({ prior: 0.5, likelihoodIfH: 0.2, likelihoodOverall: 0.5 });
    expect(against.bayesFactor).toBeLessThan(1);
    expect(against.posterior).toBeLessThan(0.5);
  });

  it("posterior equals prior when the evidence is neutral (likelihoodIfH == likelihoodOverall)", () => {
    const rng = lcg(606);
    for (let i = 0; i < 50; i++) {
      const prior = probIn(rng);
      const lE = probIn(rng);
      const r = bayesianUpdate({ prior, likelihoodIfH: lE, likelihoodOverall: lE });
      expect(r.posterior).toBeCloseTo(prior, 12);
      expect(r.bayesFactor).toBeCloseTo(1, 12);
    }
  });

  it("zero-evidence sentinel: likelihoodOverall == 0 → posterior 0, bayesFactor Infinity", () => {
    const r = bayesianUpdate({ prior: 0.5, likelihoodIfH: 0.8, likelihoodOverall: 0 });
    expect(r.posterior).toBe(0);
    expect(r.bayesFactor).toBe(Infinity);
  });

  it("clamps out-of-range and non-finite inputs (no NaN propagation)", () => {
    const r = bayesianUpdate({ prior: 2, likelihoodIfH: -1, likelihoodOverall: NaN } as unknown as {
      prior: number;
      likelihoodIfH: number;
      likelihoodOverall: number;
    });
    // likelihoodOverall NaN → clamps to 0 → sentinel branch.
    expect(r.posterior).toBe(0);
    expect(r.bayesFactor).toBe(Infinity);
  });

  it("is deterministic for repeated identical calls", () => {
    const a = bayesianUpdate({ prior: 0.33, likelihoodIfH: 0.71, likelihoodOverall: 0.55 });
    const b = bayesianUpdate({ prior: 0.33, likelihoodIfH: 0.71, likelihoodOverall: 0.55 });
    expect(a).toEqual(b);
  });
});

describe("bayesianUpdateFromLikelihoods — stable-form invariants (robustness)", () => {
  it("agrees with bayesianUpdate when marginal P(E) is reconstructed consistently", () => {
    const rng = lcg(4242);
    for (let i = 0; i < 100; i++) {
      const prior = probIn(rng);
      const lH = probIn(rng);
      const lN = probIn(rng);
      const marginal = lH * prior + lN * (1 - prior); // P(E) by total probability
      const fromLik = bayesianUpdateFromLikelihoods({ prior, likelihoodIfH: lH, likelihoodIfNotH: lN });
      if (marginal > 0) {
        const fromMarginal = bayesianUpdate({ prior, likelihoodIfH: lH, likelihoodOverall: marginal });
        expect(fromLik.posterior).toBeCloseTo(fromMarginal.posterior, 9);
      }
    }
  });

  it("posterior stays within [0,1] for all seeded inputs", () => {
    const rng = lcg(2718);
    for (let i = 0; i < 300; i++) {
      const r = bayesianUpdateFromLikelihoods({
        prior: probIn(rng),
        likelihoodIfH: probIn(rng),
        likelihoodIfNotH: probIn(rng),
      });
      expect(r.posterior).toBeGreaterThanOrEqual(0);
      expect(r.posterior).toBeLessThanOrEqual(1);
    }
  });

  it("returns prior when likelihoods are equal (uninformative evidence), bayesFactor 1", () => {
    const rng = lcg(1234567);
    for (let i = 0; i < 50; i++) {
      const prior = probIn(rng);
      const l = probIn(rng);
      const r = bayesianUpdateFromLikelihoods({ prior, likelihoodIfH: l, likelihoodIfNotH: l });
      expect(r.posterior).toBeCloseTo(prior, 12);
      expect(r.bayesFactor).toBeCloseTo(1, 12);
    }
  });

  it("degenerate all-zero likelihoods → posterior 0, bayesFactor Infinity (no NaN)", () => {
    const r = bayesianUpdateFromLikelihoods({ prior: 0.5, likelihoodIfH: 0, likelihoodIfNotH: 0 });
    expect(r.posterior).toBe(0);
    expect(r.bayesFactor).toBe(Infinity);
  });

  it("strong confirming evidence (lH high, lN≈0) drives posterior toward 1", () => {
    const r = bayesianUpdateFromLikelihoods({ prior: 0.4, likelihoodIfH: 0.99, likelihoodIfNotH: 0.01 });
    expect(r.posterior).toBeGreaterThan(0.95);
    expect(r.bayesFactor).toBeGreaterThan(1);
  });

  it("is deterministic for repeated identical calls", () => {
    const a = bayesianUpdateFromLikelihoods({ prior: 0.45, likelihoodIfH: 0.6, likelihoodIfNotH: 0.2 });
    const b = bayesianUpdateFromLikelihoods({ prior: 0.45, likelihoodIfH: 0.6, likelihoodIfNotH: 0.2 });
    expect(a).toEqual(b);
  });
});
