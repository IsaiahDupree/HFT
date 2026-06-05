import { describe, it, expect } from "vitest";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "@/lib/backtest/shuffle-control";

describe("lcgRng", () => {
  it("is deterministic for a given seed and in [0,1)", () => {
    const a = lcgRng(7), b = lcgRng(7);
    for (let i = 0; i < 50; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it("different seeds diverge", () => {
    expect(lcgRng(1)()).not.toBe(lcgRng(2)());
  });
});

describe("blockShufflePermutation", () => {
  it("is a valid permutation of [0..n) (every index exactly once)", () => {
    const perm = blockShufflePermutation(20, 4, lcgRng(3));
    expect(perm.length).toBe(20);
    expect([...perm].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it("keeps elements WITHIN a block contiguous and in order (only block ORDER changes)", () => {
    const perm = blockShufflePermutation(12, 3, lcgRng(5));
    // each consecutive run of 3 in the output must be an original block [k, k+1, k+2]
    for (let i = 0; i < perm.length; i += 3) {
      expect(perm[i + 1]).toBe(perm[i] + 1);
      expect(perm[i + 2]).toBe(perm[i] + 2);
      expect(perm[i] % 3).toBe(0);
    }
  });
  it("blockSize ≥ n is the identity", () => {
    expect(blockShufflePermutation(6, 99, lcgRng(1))).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("handles n=0", () => {
    expect(blockShufflePermutation(0, 4, lcgRng(1))).toEqual([]);
  });
  it("is deterministic for a fixed seed", () => {
    expect(blockShufflePermutation(30, 5, lcgRng(9))).toEqual(blockShufflePermutation(30, 5, lcgRng(9)));
  });
});

describe("applyPermutation", () => {
  it("reads out[i] = arr[perm[i]]", () => {
    expect(applyPermutation(["a", "b", "c"], [2, 0, 1])).toEqual(["c", "a", "b"]);
  });
});

describe("permutationTest", () => {
  it("a clearly-better observed gets a small p-value", () => {
    const nulls = Array.from({ length: 99 }, (_, i) => (i - 50) / 100); // ~[-0.5, 0.49]
    const r = permutationTest(2.0, nulls, "greater");
    expect(r.exceed).toBe(0);
    expect(r.pValue).toBeCloseTo(1 / 100, 9);
  });
  it("an observed in the middle of the null gets p≈0.5", () => {
    const nulls = Array.from({ length: 99 }, (_, i) => i); // 0..98
    expect(permutationTest(49, nulls, "greater").pValue).toBeCloseTo((1 + 50) / 100, 2);
  });
  it("never returns p=0 (the (1+exceed)/(1+N) estimator)", () => {
    expect(permutationTest(999, [1, 2, 3], "greater").pValue).toBeCloseTo(1 / 4, 9);
  });
  it("'less' tail tests the other side", () => {
    expect(permutationTest(-5, [0, 1, 2, 3], "less").exceed).toBe(0);
  });
});
