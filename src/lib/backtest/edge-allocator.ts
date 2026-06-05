/**
 * edge-allocator — combine several confirmed edges (the carries) into ONE book. Uncorrelated carries
 * stacked at risk-parity raise the portfolio Sharpe above any single sleeve (diversification is the
 * only free lunch). All NO-LOOKAHEAD: the weight applied to sleeve e on day i uses each sleeve's
 * trailing vol known BEFORE day i. Pure + deterministic. (A regime overlay is just a per-sleeve size
 * series multiplied in before normalizing — see scripts/backtest-cross-edge.ts.)
 */
import { rollingStd } from "./regime-size";

/** Equal weight: each of `nSleeves` gets 1/n every day, length `T`. */
export function equalWeights(nSleeves: number, T: number): number[][] {
  return Array.from({ length: nSleeves }, () => new Array(T).fill(nSleeves > 0 ? 1 / nSleeves : 0));
}

/**
 * Inverse-vol (risk-parity) weights: each day, w[e] ∝ 1/trailingVol[e], normalized to sum 1. The
 * trailing vol of sleeve e is `rollingStd(returns[e], volWin)` LAGGED one bar (vol known before the
 * day's return). During warmup (no finite vol yet) falls back to equal weight. `returns` is an array
 * of E aligned sleeve-return series (each length T).
 */
export function inverseVolWeights(returns: readonly number[][], volWin: number): number[][] {
  const E = returns.length;
  const T = E ? returns[0].length : 0;
  // lagged trailing vol per sleeve
  const vol = returns.map((r) => { const rv = rollingStd(r, volWin); return [NaN, ...rv.slice(0, -1)]; });
  const w: number[][] = Array.from({ length: E }, () => new Array(T).fill(0));
  for (let t = 0; t < T; t++) {
    const inv = vol.map((v) => (Number.isFinite(v[t]) && v[t] > 0 ? 1 / v[t] : NaN));
    const finite = inv.filter((x) => Number.isFinite(x)) as number[];
    const sum = finite.reduce((a, x) => a + x, 0);
    for (let e = 0; e < E; e++) {
      if (sum > 0 && finite.length === E) w[e][t] = inv[e] / sum;          // full risk-parity
      else w[e][t] = 1 / E;                                                // warmup → equal weight
    }
  }
  return w;
}

/** Portfolio return per day = Σ_e weights[e][i]·returns[e][i]. */
export function applyAllocation(returns: readonly number[][], weights: readonly number[][]): number[] {
  const E = returns.length, T = E ? returns[0].length : 0;
  const out: number[] = [];
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let e = 0; e < E; e++) s += (weights[e]?.[t] ?? 0) * (returns[e]?.[t] ?? 0);
    out.push(s);
  }
  return out;
}

/** Renormalize per-day weight columns to sum to 1 (after a regime/size overlay has scaled them). */
export function normalizeWeights(weights: readonly number[][]): number[][] {
  const E = weights.length, T = E ? weights[0].length : 0;
  const out: number[][] = Array.from({ length: E }, () => new Array(T).fill(0));
  for (let t = 0; t < T; t++) {
    let sum = 0; for (let e = 0; e < E; e++) sum += Math.max(0, weights[e][t] || 0);
    for (let e = 0; e < E; e++) out[e][t] = sum > 0 ? Math.max(0, weights[e][t] || 0) / sum : (E ? 1 / E : 0);
  }
  return out;
}

const pearson = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};

/** Full E×E correlation matrix of the sleeve returns (diagnostic — diversification is low correlation). */
export function correlationMatrix(returns: readonly number[][]): number[][] {
  return returns.map((a) => returns.map((b) => pearson(a as number[], b as number[])));
}
