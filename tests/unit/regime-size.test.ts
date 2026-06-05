import { describe, it, expect } from "vitest";
import { rollingStd, rollingMean, trailingZ, volTargetSize, regimeGateSize, applySizing, shuffleSizes } from "@/lib/backtest/regime-size";
import { lcgRng } from "@/lib/backtest/shuffle-control";

describe("rolling stats — no lookahead", () => {
  it("rollingMean is the trailing average, NaN during warmup", () => {
    const m = rollingMean([1, 2, 3, 4], 2);
    expect(Number.isNaN(m[0])).toBe(true);
    expect(m.slice(1)).toEqual([1.5, 2.5, 3.5]);
  });
  it("rollingStd is the trailing sample std", () => {
    const s = rollingStd([2, 4, 6], 3);
    expect(Number.isNaN(s[0])).toBe(true);
    expect(s[2]).toBeCloseTo(2, 9); // std of [2,4,6] sample = 2
  });
  it("is no-lookahead: a far-future value can't change earlier outputs", () => {
    const base = rollingStd([1, 2, 3, 4, 5], 2);
    const pert = [1, 2, 3, 4, 99];
    expect(rollingStd(pert, 2).slice(0, 4)).toEqual(base.slice(0, 4));
  });
  it("trailingZ is 0-centered at the window mean and NaN on zero variance", () => {
    expect(trailingZ([5, 5, 5], 3)[2]).toBeNaN(); // constant → zero var
    const z = trailingZ([1, 2, 3, 10], 3);
    expect(z[3]).toBeGreaterThan(0); // 10 is high vs trailing [2,3,...]
  });
});

describe("volTargetSize", () => {
  it("size ∝ targetVol/vol, clamped", () => {
    const s = volTargetSize([0.01, 0.02, 0.04], 0.02, { sizeMin: 0, sizeMax: 1.5 });
    expect(s[0]).toBe(1.5);             // 0.02/0.01=2 → clamped to 1.5
    expect(s[1]).toBeCloseTo(1, 9);     // 0.02/0.02=1
    expect(s[2]).toBeCloseTo(0.5, 9);   // 0.02/0.04=0.5
  });
  it("NaN / zero vol → sizeMin (can't judge → small)", () => {
    expect(volTargetSize([NaN, 0], 0.02, { sizeMin: 0.1 })).toEqual([0.1, 0.1]);
  });
});

describe("regimeGateSize — cut into danger", () => {
  it("full size below cutZ, floor well above, linear ramp between", () => {
    const s = regimeGateSize([0, 1, 1.5, 2, 5], { cutZ: 1, band: 1, floor: 0.3, full: 1 });
    expect(s[0]).toBe(1);                 // z=0 ≤ cut
    expect(s[1]).toBe(1);                 // z=1 = cut
    expect(s[2]).toBeCloseTo(0.65, 9);    // halfway through the band
    expect(s[3]).toBeCloseTo(0.3, 9);     // z=2 = cut+band → floor
    expect(s[4]).toBeCloseTo(0.3, 9);     // beyond → clamped to floor
  });
  it("NaN risk → floor", () => {
    expect(regimeGateSize([NaN], { floor: 0.25 })[0]).toBe(0.25);
  });
});

describe("applySizing", () => {
  it("scales returns by the aligned size", () => {
    expect(applySizing([0.1, -0.2, 0.05], [1, 0.5, 0])).toEqual([0.1, -0.1, 0]);
  });
  it("treats a NaN size as 0 exposure", () => {
    expect(applySizing([0.1], [NaN])).toEqual([0]);
  });
});

describe("shuffleSizes — falsification", () => {
  it("is a permutation of the same sizes (preserves the multiset)", () => {
    const s = [1, 0.9, 0.8, 0.3, 0.3, 1.2, 0.5, 0.5];
    const sh = shuffleSizes(s, 2, lcgRng(7));
    expect([...sh].sort()).toEqual([...s].sort());
    expect(sh.length).toBe(s.length);
  });
  it("is deterministic for a fixed seed", () => {
    const s = [1, 2, 3, 4, 5, 6];
    expect(shuffleSizes(s, 2, lcgRng(3))).toEqual(shuffleSizes(s, 2, lcgRng(3)));
  });
});
