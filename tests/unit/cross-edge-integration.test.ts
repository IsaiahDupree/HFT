/**
 * cross-edge-integration — the one test the per-edge unit suites can't give: feed REAL edge return-vectors
 * (funding carry + calendar basis + staking-hedged) through the cross-edge allocator and assert PORTFOLIO-level
 * invariants. A regression where one edge's return CONVENTION flips (sign, length, or a lookahead leak) passes
 * every isolated unit suite yet breaks the live allocation — this catches exactly that, at the seam.
 */
import { describe, it, expect } from "vitest";
import { deltaNeutralCarryReturns, calendarBasisReturns } from "@/lib/backtest/candle/funding";
import { stakingHedgedReturns } from "@/lib/exec/staking-hedged";
import { inverseVolWeights, applyAllocation, correlationMatrix } from "@/lib/backtest/edge-allocator";

// deterministic Numerical-Recipes LCG (repo convention — fast-check is not installed)
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; }; }
const std = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

/** Build the 3 real sleeve return-vectors from synthetic-but-realistic inputs, trimmed to a common length. */
function buildSleeves(seed: number) {
  const r = lcg(seed), N = 260;
  const funding: number[] = [], spot: number[] = [], fut: number[] = [], dte: number[] = [], roll: boolean[] = [];
  let px = 60_000;
  for (let i = 0; i < N; i++) {
    funding.push(0.0003 + (r() - 0.5) * 0.0008);             // ~+11%/yr daily funding w/ noise (some negative)
    px *= 1 + (r() - 0.5) * 0.03;                            // random-walk spot
    spot.push(px);
    const daysLeft = 90 - (i % 90);                          // 90d quarterly cycle
    dte.push(daysLeft);
    fut.push(px * (1 + 0.03 * daysLeft / 365));              // contango ~3%/yr annualized basis
    roll.push(daysLeft === 90 && i > 0);                     // roll at the seam
  }
  const sFunding = deltaNeutralCarryReturns(funding, { minFunding: 0, feeBps: 5 });
  const sCalendar = calendarBasisReturns(spot, fut, dte, roll, { feeBps: 5 });
  const sStaking = stakingHedgedReturns(funding, { stakeApy: 0.032, entryBps: 10, periodsPerYear: 365 });
  const L = Math.min(sFunding.length, sCalendar.length, sStaking.length);
  return { sleeves: [sFunding.slice(0, L), sCalendar.slice(0, L), sStaking.slice(0, L)], L, funding };
}

describe("cross-edge integration — real edge returns through the allocator", () => {
  it("produces a finite, length-correct portfolio with weights that sum to 1 each day", () => {
    const { sleeves, L } = buildSleeves(42);
    const w = inverseVolWeights(sleeves, 20);
    const port = applyAllocation(sleeves, w);
    expect(port).toHaveLength(L);
    expect(port.every((x) => Number.isFinite(x))).toBe(true);
    for (let t = 0; t < L; t++) expect(w.reduce((a, col) => a + col[t], 0)).toBeCloseTo(1, 9);
  });

  it("honors the allocation contract: portfolio[t] === Σ weight[e][t]·return[e][t]", () => {
    const { sleeves, L } = buildSleeves(7);
    const w = inverseVolWeights(sleeves, 20);
    const port = applyAllocation(sleeves, w);
    for (const t of [0, 1, 19, 20, 21, L - 1]) {
      const manual = sleeves.reduce((a, s, e) => a + w[e][t] * s[t], 0);
      expect(port[t]).toBeCloseTo(manual, 12);
    }
  });

  it("DIVERSIFICATION never increases risk: blended vol ≤ the worst single-sleeve vol", () => {
    // mathematical guarantee for Σw=1, w≥0: vol(Σ wᵢ rᵢ) ≤ Σ wᵢ vol(rᵢ) ≤ max vol(rᵢ). Verify at the seam.
    const { sleeves } = buildSleeves(99);
    const port = applyAllocation(sleeves, inverseVolWeights(sleeves, 20));
    const maxSleeveVol = Math.max(...sleeves.map(std));
    expect(std(port)).toBeLessThanOrEqual(maxSleeveVol * 1.02); // small tolerance for time-varying weights
  });

  it("correlationMatrix of the real sleeves is well-formed (symmetric, unit diag, bounded)", () => {
    const { sleeves } = buildSleeves(123);
    const c = correlationMatrix(sleeves);
    expect(c).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(c[i][i]).toBeCloseTo(1, 9);
      for (let j = 0; j < 3; j++) {
        expect(c[i][j]).toBeCloseTo(c[j][i], 12);
        expect(c[i][j]).toBeGreaterThanOrEqual(-1.0000001);
        expect(c[i][j]).toBeLessThanOrEqual(1.0000001);
      }
    }
  });

  it("INTEGRATION no-lookahead: perturbing a FUTURE funding print can't move an EARLY portfolio return", () => {
    const base = buildSleeves(2024);
    const wBase = inverseVolWeights(base.sleeves, 20);
    const portBase = applyAllocation(base.sleeves, wBase);

    // rebuild with one LATE funding value flipped hard, recompute the WHOLE pipeline end-to-end
    const r = lcg(2024); const N = 260;
    const funding: number[] = [], spot: number[] = [], fut: number[] = [], dte: number[] = [], roll: boolean[] = [];
    let px = 60_000;
    for (let i = 0; i < N; i++) {
      funding.push(0.0003 + (r() - 0.5) * 0.0008);
      px *= 1 + (r() - 0.5) * 0.03; spot.push(px);
      const d = 90 - (i % 90); dte.push(d); fut.push(px * (1 + 0.03 * d / 365)); roll.push(d === 90 && i > 0);
    }
    const K = 220; funding[K] = -5;                                  // a violent FUTURE perturbation at i=220
    const sFunding = deltaNeutralCarryReturns(funding, { minFunding: 0, feeBps: 5 });
    const sStaking = stakingHedgedReturns(funding, { stakeApy: 0.032, entryBps: 10, periodsPerYear: 365 });
    const L = base.L;
    const sleeves2 = [sFunding.slice(0, L), base.sleeves[1], sStaking.slice(0, L)];
    const port2 = applyAllocation(sleeves2, inverseVolWeights(sleeves2, 20));

    // every portfolio return strictly before the perturbation (minus the vol-window reach) must be identical.
    for (let t = 0; t < K - 20; t++) expect(port2[t]).toBeCloseTo(portBase[t], 12);
  });
});
