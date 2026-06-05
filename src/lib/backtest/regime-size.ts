/**
 * regime-size — "Two Brains" Loop B: a regime/judgment layer that SIZES a deterministic edge
 * (Loop A) up or down by detected risk, instead of trading it flat. A carry has a known failure
 * mode (basis blowout / squeeze / vol spike); sizing DOWN into rising risk and UP into calm should
 * improve the risk-adjusted return — IF the risk signal is real. The §7.6 discipline: this only
 * counts if regime-sizing beats BOTH a fixed size AND a SHUFFLED regime (so the size↔risk *timing*
 * is what helps, not just lower average gross). All NO-LOOKAHEAD: size[i] uses features ≤ i and
 * scales the return realized over i→i+1. Pure + deterministic; the LLM judgment layer in production
 * is the same shape with richer features — this is its backtestable proxy.
 */

/** Rolling sample std over the trailing `n` values ending at i (NaN until i ≥ n−1). No lookahead. */
export function rollingStd(x: readonly number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  if (n < 2) return out;
  for (let i = n - 1; i < x.length; i++) {
    let m = 0; for (let k = i - n + 1; k <= i; k++) m += x[k]; m /= n;
    let s = 0; for (let k = i - n + 1; k <= i; k++) s += (x[k] - m) ** 2;
    out[i] = Math.sqrt(s / (n - 1));
  }
  return out;
}

/** Rolling mean over the trailing `n` ending at i (NaN until i ≥ n−1). */
export function rollingMean(x: readonly number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < x.length; i++) { sum += x[i]; if (i >= n) sum -= x[i - n]; if (i >= n - 1) out[i] = sum / n; }
  return out;
}

/** Trailing z-score of x[i] vs its own window ending at i (NaN during warmup or zero-variance). */
export function trailingZ(x: readonly number[], n: number): number[] {
  const mean = rollingMean(x, n), std = rollingStd(x, n);
  return x.map((v, i) => (Number.isFinite(mean[i]) && std[i] > 0 ? (v - mean[i]) / std[i] : NaN));
}

/**
 * VOL-TARGET sizer: size ∝ targetVol / trailingVol, clamped to [sizeMin, sizeMax]. Bigger when the
 * edge is calm, smaller when it's whippy. `trailingVol[i]` must be NO-LOOKAHEAD (e.g. rollingStd of
 * the edge's own returns or its risk feature). NaN/zero vol → sizeMin (can't judge → small).
 */
export function volTargetSize(trailingVol: readonly number[], targetVol: number, opts: { sizeMin?: number; sizeMax?: number } = {}): number[] {
  const lo = opts.sizeMin ?? 0, hi = opts.sizeMax ?? 1.5;
  return trailingVol.map((v) => (Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, targetVol / v)) : lo));
}

/**
 * GATE sizer: full size while a risk z-score is below `cutZ`, ramping linearly down to `floor` as
 * it rises to `cutZ + band`. The "cut into danger" judgment a flat strategy can't make. NaN risk →
 * `floor` (conservative).
 */
export function regimeGateSize(riskZ: readonly number[], opts: { cutZ?: number; band?: number; floor?: number; full?: number } = {}): number[] {
  const cutZ = opts.cutZ ?? 1, band = opts.band ?? 1, floor = opts.floor ?? 0.3, full = opts.full ?? 1;
  return riskZ.map((z) => {
    if (!Number.isFinite(z)) return floor;
    if (z <= cutZ) return full;
    const t = Math.min(1, (z - cutZ) / band);
    return full + t * (floor - full);
  });
}

/** Apply a size series to a return series: out[i] = size[i] · returns[i] (size from features ≤ i). */
export function applySizing(returns: readonly number[], sizes: readonly number[]): number[] {
  const n = Math.min(returns.length, sizes.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((Number.isFinite(sizes[i]) ? sizes[i] : 0) * returns[i]);
  return out;
}

/**
 * Falsification helper: block-shuffle a size series (breaking its alignment to the return timing)
 * with a seeded RNG, so a permutation test can ask "does the regime's TIMING help, or would any
 * reordering of the same sizes do as well?". Reuses block shuffling to preserve size autocorrelation.
 */
export function shuffleSizes(sizes: readonly number[], blockSize: number, rng: () => number): number[] {
  const bs = Math.max(1, Math.floor(blockSize));
  const blocks: number[][] = [];
  for (let s = 0; s < sizes.length; s += bs) blocks.push(sizes.slice(s, Math.min(sizes.length, s + bs)) as number[]);
  for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
  return blocks.flat();
}
