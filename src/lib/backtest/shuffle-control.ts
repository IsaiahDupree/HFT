/**
 * shuffle-control — a permutation null for time-series strategies. A timing edge (momentum,
 * mean-reversion) should beat a version of itself run on TIME-SHUFFLED data: if shuffling the bar
 * order (which destroys autocorrelation but preserves the return distribution) doesn't hurt the
 * Sharpe, the "edge" was a static artifact, not real temporal structure. Block-shuffling keeps
 * short-run autocorrelation intact so only the longer-horizon structure the strategy claims to
 * exploit is broken. Pure + deterministic (seeded). (Note: doesn't apply to income strategies like
 * funding carry, whose return is order-independent.)
 */

/** Seeded LCG in [0,1) — deterministic RNG so a shuffle control is reproducible. */
export function lcgRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
}

/**
 * A block permutation of indices [0..n): partition into contiguous blocks of `blockSize`, shuffle
 * the BLOCK order (Fisher-Yates with `rng`), then concatenate each block's original indices. The
 * result is a length-n array `perm` where `perm[i]` is the SOURCE index to read for output slot i.
 * blockSize 1 = full shuffle; blockSize ≥ n = identity.
 */
export function blockShufflePermutation(n: number, blockSize: number, rng: () => number): number[] {
  if (n <= 0) return [];
  const bs = Math.max(1, Math.floor(blockSize));
  const blocks: number[][] = [];
  for (let start = 0; start < n; start += bs) {
    const blk: number[] = [];
    for (let i = start; i < Math.min(n, start + bs); i++) blk.push(i);
    blocks.push(blk);
  }
  for (let i = blocks.length - 1; i > 0; i--) { // Fisher-Yates on block order
    const j = Math.floor(rng() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  return blocks.flat();
}

/** Apply a permutation: out[i] = arr[perm[i]]. */
export function applyPermutation<T>(arr: readonly T[], perm: readonly number[]): T[] {
  return perm.map((src) => arr[src]);
}

export type PermResult = { pValue: number; nNull: number; exceed: number; observed: number };

/**
 * One-sided permutation p-value: how often a null statistic is at least as extreme as `observed`.
 * `tail` "greater" (default) tests observed > null (an edge); "less" tests the other side.
 * Uses the (1 + exceed)/(1 + N) estimator so p is never 0 (you can't prove p=0 from finite draws).
 */
export function permutationTest(observed: number, nullStats: readonly number[], tail: "greater" | "less" = "greater"): PermResult {
  const exceed = nullStats.filter((x) => (tail === "greater" ? x >= observed : x <= observed)).length;
  return { pValue: (1 + exceed) / (1 + nullStats.length), nNull: nullStats.length, exceed, observed };
}
