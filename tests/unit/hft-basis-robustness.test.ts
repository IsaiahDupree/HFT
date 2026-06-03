import { describe, expect, it } from "vitest";
import { computeBasis, type BasisInputs, type BasisResult } from "@/lib/hft/basis";

// Deterministic seeded LCG (Numerical Recipes constants) so any pseudo-random
// inputs are fully reproducible — no wall-clock, no Math.random.
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000; // [0, 1)
  };
}

// Construct a synthetic input from a uniform [0,1) draw mapped into a realistic
// spread of values. Pure — no IO, no clock.
function syntheticInput(rng: () => number): BasisInputs {
  const spot = 100 + rng() * 9900; // [100, 10000)
  const basisFrac = (rng() - 0.5) * 0.04; // ±2% basis
  const perp = spot * (1 + basisFrac);
  const nextFundingRate = (rng() - 0.5) * 0.002; // ±0.1% per horizon
  const fundingHorizonHours = [1, 4, 8][Math.floor(rng() * 3)];
  return { spot, perp, nextFundingRate, fundingHorizonHours };
}

describe("computeBasis — robustness & invariants", () => {
  it("is deterministic: identical inputs yield byte-identical results", () => {
    const input: BasisInputs = { spot: 3145.27, perp: 3151.9, nextFundingRate: 0.00037, fundingHorizonHours: 8 };
    const a = computeBasis({ ...input });
    const b = computeBasis({ ...input });
    expect(a).toEqual(b);
    // Re-run a third time to rule out any hidden mutable state.
    const c = computeBasis({ ...input });
    expect(c).toEqual(a);
  });

  it("does not mutate its input object", () => {
    const input: BasisInputs = { spot: 2000, perp: 2010, nextFundingRate: 0.0005, fundingHorizonHours: 8 };
    const snapshot = { ...input };
    computeBasis(input);
    expect(input).toEqual(snapshot);
  });

  it("basis === perp - spot exactly for arbitrary magnitudes", () => {
    const cases: Array<[number, number]> = [
      [50000, 50123.5],
      [0.5, 0.49],
      [1e6, 1e6 + 17],
      [42, 42],
    ];
    for (const [spot, perp] of cases) {
      const r = computeBasis({ spot, perp, nextFundingRate: 0, fundingHorizonHours: 1 });
      expect(r.basis).toBe(perp - spot);
    }
  });

  it("sign of basis matches sign of (perp - spot) and basisBps", () => {
    const rng = makeLcg(0xABCDEF);
    for (let n = 0; n < 60; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      expect(Math.sign(r.basis)).toBe(Math.sign(i.perp - i.spot));
      // spot is always > 0 in synthetic inputs, so basisBps shares basis sign.
      expect(Math.sign(r.basisBps)).toBe(Math.sign(r.basis));
    }
  });

  it("basisBps = (basis / spot) * 10000 when spot > 0", () => {
    const rng = makeLcg(7);
    for (let n = 0; n < 40; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      expect(r.basisBps).toBeCloseTo((r.basis / i.spot) * 10000, 6);
    }
  });

  it("guards basisBps to 0 for spot <= 0 (zero and negative)", () => {
    expect(computeBasis({ spot: 0, perp: 100, nextFundingRate: 0, fundingHorizonHours: 1 }).basisBps).toBe(0);
    // Negative spot is non-physical but the guard is `spot > 0`, so it also yields 0.
    expect(computeBasis({ spot: -10, perp: 100, nextFundingRate: 0, fundingHorizonHours: 1 }).basisBps).toBe(0);
    // basis itself is still computed even when bps is guarded.
    expect(computeBasis({ spot: 0, perp: 100, nextFundingRate: 0, fundingHorizonHours: 1 }).basis).toBe(100);
  });

  it("fundingHorizonHours below 1 is clamped to 1 (max(1, h))", () => {
    const base: BasisInputs = { spot: 2000, perp: 2000, nextFundingRate: 0.0001, fundingHorizonHours: 1 };
    const ref = computeBasis(base).fundingBpsHourly;
    // horizon = 0, 0.5, negative all clamp to 1 → same hourly rate as horizon 1.
    for (const h of [0, 0.5, -3]) {
      const r = computeBasis({ ...base, fundingHorizonHours: h });
      expect(r.fundingBpsHourly).toBeCloseTo(ref, 9);
    }
  });

  it("fundingBpsHourly scales linearly with nextFundingRate", () => {
    const single = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0001, fundingHorizonHours: 1 }).fundingBpsHourly;
    const triple = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0003, fundingHorizonHours: 1 }).fundingBpsHourly;
    expect(triple).toBeCloseTo(single * 3, 9);
  });

  it("fundingBpsHourly scales inversely with horizon for horizon >= 1", () => {
    const r1 = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0008, fundingHorizonHours: 1 }).fundingBpsHourly;
    const r8 = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0008, fundingHorizonHours: 8 }).fundingBpsHourly;
    expect(r8).toBeCloseTo(r1 / 8, 9);
  });

  it("negative funding rate produces negative hourly/apr/carry (sign symmetry)", () => {
    const pos = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: 0.0002, fundingHorizonHours: 1 });
    const neg = computeBasis({ spot: 2000, perp: 2000, nextFundingRate: -0.0002, fundingHorizonHours: 1 });
    expect(neg.fundingBpsHourly).toBeCloseTo(-pos.fundingBpsHourly, 9);
    expect(neg.fundingApr).toBeCloseTo(-pos.fundingApr, 9);
    expect(neg.carry24hBps).toBeCloseTo(-pos.carry24hBps, 9);
  });

  it("fundingApr = fundingBpsHourly * 24 * 365 / 10000 (annualization identity)", () => {
    const rng = makeLcg(1234567);
    for (let n = 0; n < 40; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      expect(r.fundingApr).toBeCloseTo((r.fundingBpsHourly * 24 * 365) / 10000, 9);
    }
  });

  it("carry24hBps = fundingBpsHourly * 24 (identity across random inputs)", () => {
    const rng = makeLcg(55);
    for (let n = 0; n < 40; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      expect(r.carry24hBps).toBeCloseTo(r.fundingBpsHourly * 24, 9);
    }
  });

  it("fundingApr equals carry24hBps annualized by 365/10000", () => {
    const rng = makeLcg(98765);
    for (let n = 0; n < 30; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      expect(r.fundingApr).toBeCloseTo((r.carry24hBps * 365) / 10000, 9);
    }
  });

  it("zero funding rate zeroes all funding-derived fields but not basis", () => {
    const r = computeBasis({ spot: 2000, perp: 2050, nextFundingRate: 0, fundingHorizonHours: 8 });
    expect(r.fundingBpsHourly).toBe(0);
    expect(r.fundingApr).toBe(0);
    expect(r.carry24hBps).toBe(0);
    expect(r.basis).toBe(50);
    expect(r.basisBps).toBeCloseTo(250, 6);
  });

  it("preferredLeg uses strict thresholds: exactly ±2 bps is flat", () => {
    // basisBps = (basis/spot)*10000 → choose perp so basisBps is exactly 2.
    const spot = 10000;
    const exactPlus2 = computeBasis({ spot, perp: spot + 2, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(exactPlus2.basisBps).toBeCloseTo(2, 9);
    expect(exactPlus2.preferredLeg).toBe("flat"); // > 2 is required, not >= 2

    const exactMinus2 = computeBasis({ spot, perp: spot - 2, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(exactMinus2.basisBps).toBeCloseTo(-2, 9);
    expect(exactMinus2.preferredLeg).toBe("flat");
  });

  it("preferredLeg crosses to long-basis just above +2 bps and short-basis just below -2 bps", () => {
    const spot = 10000;
    expect(computeBasis({ spot, perp: spot + 2.01, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("long-basis");
    expect(computeBasis({ spot, perp: spot - 2.01, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("short-basis");
  });

  it("preferredLeg is one of exactly three allowed values for arbitrary inputs", () => {
    const allowed = new Set<BasisResult["preferredLeg"]>(["long-basis", "short-basis", "flat"]);
    const rng = makeLcg(424242);
    for (let n = 0; n < 80; n++) {
      const i = syntheticInput(rng);
      expect(allowed.has(computeBasis(i).preferredLeg)).toBe(true);
    }
  });

  it("preferredLeg depends only on basisBps, independent of funding rate", () => {
    const spot = 2000;
    const perp = 2010; // basisBps = 50 → long-basis
    const legs = [-0.01, 0, 0.01, 0.5].map(
      (fr) => computeBasis({ spot, perp, nextFundingRate: fr, fundingHorizonHours: 8 }).preferredLeg,
    );
    expect(new Set(legs).size).toBe(1);
    expect(legs[0]).toBe("long-basis");
  });

  it("flat zone: |basisBps| < 2 (but nonzero) still returns flat", () => {
    const spot = 10000;
    // perp + 1 → basisBps = 1
    expect(computeBasis({ spot, perp: spot + 1, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("flat");
    expect(computeBasis({ spot, perp: spot - 1, nextFundingRate: 0, fundingHorizonHours: 1 }).preferredLeg).toBe("flat");
  });

  it("antisymmetric basis: swapping spot/perp negates basis and basisBps magnitude relation holds", () => {
    const a = computeBasis({ spot: 2000, perp: 2040, nextFundingRate: 0, fundingHorizonHours: 1 });
    const b = computeBasis({ spot: 2040, perp: 2000, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(b.basis).toBe(-a.basis);
    // basisBps uses each side's own spot as denominator, so it is NOT a clean
    // negation — verify the actual relation instead of assuming symmetry.
    expect(a.basisBps).toBeCloseTo((40 / 2000) * 10000, 9);
    expect(b.basisBps).toBeCloseTo((-40 / 2040) * 10000, 9);
  });

  it("all output fields are finite for well-formed inputs", () => {
    const rng = makeLcg(31415926);
    for (let n = 0; n < 100; n++) {
      const i = syntheticInput(rng);
      const r = computeBasis(i);
      for (const v of [r.basis, r.basisBps, r.fundingBpsHourly, r.fundingApr, r.carry24hBps]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("large but finite inputs do not overflow to Infinity", () => {
    const r = computeBasis({ spot: 1e9, perp: 1e9 + 1e6, nextFundingRate: 0.01, fundingHorizonHours: 1 });
    expect(Number.isFinite(r.basis)).toBe(true);
    expect(Number.isFinite(r.basisBps)).toBe(true);
    expect(Number.isFinite(r.fundingApr)).toBe(true);
    expect(r.basis).toBe(1e6);
  });

  it("dYdX 1h convention: 1 bp/h funding → ~87.6% APR (documented behavior)", () => {
    const r = computeBasis({ spot: 3000, perp: 3000, nextFundingRate: 0.0001, fundingHorizonHours: 1 });
    expect(r.fundingBpsHourly).toBeCloseTo(1, 9);
    expect(r.fundingApr).toBeCloseTo(0.876, 6);
    expect(r.carry24hBps).toBeCloseTo(24, 9);
  });

  it("equal spot and perp yields exactly flat with zero basis regardless of price level", () => {
    for (const p of [1, 1000, 50000, 0.001]) {
      const r = computeBasis({ spot: p, perp: p, nextFundingRate: 0.0003, fundingHorizonHours: 8 });
      expect(r.basis).toBe(0);
      expect(r.basisBps).toBe(0);
      expect(r.preferredLeg).toBe("flat");
    }
  });

  it("doubling spot+perp proportionally halves basisBps for the same absolute basis", () => {
    // Same absolute basis (+4) but spot doubles → basisBps halves.
    const small = computeBasis({ spot: 2000, perp: 2004, nextFundingRate: 0, fundingHorizonHours: 1 });
    const big = computeBasis({ spot: 4000, perp: 4004, nextFundingRate: 0, fundingHorizonHours: 1 });
    expect(small.basis).toBe(4);
    expect(big.basis).toBe(4);
    expect(big.basisBps).toBeCloseTo(small.basisBps / 2, 9);
  });

  it("seeded LCG itself is deterministic (guards test reproducibility)", () => {
    const a = makeLcg(999);
    const b = makeLcg(999);
    for (let n = 0; n < 20; n++) {
      expect(a()).toBe(b());
    }
  });
});
