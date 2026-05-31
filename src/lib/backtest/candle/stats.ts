/**
 * Overfit-detection statistics for backtests (handbook §11): the Deflated Sharpe
 * Ratio (Bailey & López de Prado 2014 — corrects an observed Sharpe for number of
 * trials + non-normality), the Probability of Backtest Overfit (López de Prado —
 * combinatorial CV: how often the in-sample-best config underperforms median OOS),
 * and a multi-fold walk-forward. Pure + deterministic.
 */
import { type DailyCandle } from "./engine";

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
/** Per-period Sharpe (mean/std), NOT annualized — for ranking + DSR. */
export const sharpe = (rets: number[]) => { const sd = std(rets); return sd > 0 ? mean(rets) / sd : 0; };
export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// erf via Abramowitz-Stegun 7.1.26 → standard-normal CDF.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
export function normalCdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// inverse standard-normal CDF — Acklam's rational approximation.
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function moments(a: number[]): { m2: number; m3: number; m4: number } {
  const n = a.length, m = mean(a);
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of a) { const d = x - m; const d2 = d * d; m2 += d2; m3 += d2 * d; m4 += d2 * d2; }
  return { m2: m2 / n, m3: m3 / n, m4: m4 / n };
}
export function skewness(a: number[]): number { const { m2, m3 } = moments(a); return m2 > 0 ? m3 / m2 ** 1.5 : 0; }
export function excessKurtosis(a: number[]): number { const { m2, m4 } = moments(a); return m2 > 0 ? m4 / (m2 * m2) - 3 : 0; }

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014): P(true Sharpe > 0) after
 * deflating the best per-period Sharpe for multiple testing AND return non-normality.
 *   SR0 = √Var[{SR_n}] · [(1−γ)Φ⁻¹(1−1/N) + γΦ⁻¹(1−1/(Ne))]   ← expected max under null
 *   DSR = Φ[ (SR − SR0) / √((1 − γ3·SR + ((κ−1)/4)·SR²)/(T−1)) ]
 * CRITICAL: the expected-max term is scaled by the CROSS-TRIAL Sharpe std
 * √Var[{SR_n}] — `trialSharpes` is the per-period Sharpe of every config tried.
 * DSR > 0.95 ⇒ strong evidence the edge is real, not a multiple-testing artifact.
 */
export function deflatedSharpe(bestReturns: number[], trialSharpes: number[]): { sr: number; dsr: number; sr0: number } {
  const T = bestReturns.length;
  const N = Math.max(2, trialSharpes.length);
  if (T < 4) return { sr: 0, dsr: 0, sr0: 0 };
  const sr = sharpe(bestReturns);
  const g3 = skewness(bestReturns);
  const kurt = excessKurtosis(bestReturns) + 3; // non-excess kurtosis (normal = 3)
  const euler = 0.5772156649015329;
  const varSR = trialSharpes.length > 1 ? (() => { const m = mean(trialSharpes); return trialSharpes.reduce((s, x) => s + (x - m) ** 2, 0) / (trialSharpes.length - 1); })() : 0;
  const eMaxStd = (1 - euler) * normalInv(1 - 1 / N) + euler * normalInv(1 - 1 / (N * Math.E));
  const sr0 = Math.sqrt(varSR) * eMaxStd;
  const srVar = (1 - g3 * sr + ((kurt - 1) / 4) * sr * sr) / (T - 1);
  if (srVar <= 0) return { sr, dsr: 0, sr0 };
  return { sr, dsr: normalCdf((sr - sr0) / Math.sqrt(srVar)), sr0 };
}

function kCombinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, combo: T[]) => {
    if (combo.length === k) { out.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); rec(i + 1, combo); combo.pop(); }
  };
  rec(0, []);
  return out;
}
const argmax = (a: number[]) => a.reduce((bi, x, i, arr) => (x > arr[bi] ? i : bi), 0);

/**
 * Probability of Backtest Overfit. `M[t][c]` = config c's per-bar return at t.
 * Splits time into `nBlocks` even blocks; over all C(nBlocks, nBlocks/2) train/test
 * partitions, picks the IS-best config and finds its OOS rank. PBO = fraction of
 * partitions where the IS-best lands BELOW the median OOS. PBO < 0.3 ⇒ robust.
 */
export function pbo(M: number[][], nBlocks = 8): number {
  const T = M.length;
  const N = M[0]?.length ?? 0;
  if (T < nBlocks * 2 || N < 2) return 1;
  const bounds: Array<[number, number]> = [];
  for (let b = 0; b < nBlocks; b++) bounds.push([Math.floor((b * T) / nBlocks), Math.floor(((b + 1) * T) / nBlocks)]);
  const combos = kCombinations([...Array(nBlocks).keys()], nBlocks >> 1);
  let under = 0, count = 0;
  for (const train of combos) {
    const trainSet = new Set(train);
    const trainIdx: number[] = [], testIdx: number[] = [];
    for (let b = 0; b < nBlocks; b++) { const [s, e] = bounds[b]; for (let i = s; i < e; i++) (trainSet.has(b) ? trainIdx : testIdx).push(i); }
    const isS: number[] = [], oosS: number[] = [];
    for (let c = 0; c < N; c++) { isS.push(sharpe(trainIdx.map((i) => M[i][c]))); oosS.push(sharpe(testIdx.map((i) => M[i][c]))); }
    const best = argmax(isS);
    const rank = oosS.filter((s) => s < oosS[best]).length; // 0..N-1, higher = better OOS
    if ((rank + 1) / (N + 1) < 0.5) under++; // below median OOS
    count++;
  }
  return count > 0 ? under / count : 1;
}

/** Per-bar net return of a position series over candles (fee on |Δposition|). */
export function variantReturns(candles: DailyCandle[], positions: number[], feeBps = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const pos = positions[i] ?? 0;
    const prev = i > 0 ? (positions[i - 1] ?? 0) : 0;
    out.push(pos * (candles[i + 1].close / candles[i].close - 1) - Math.abs(pos - prev) * (feeBps / 1e4));
  }
  return out;
}

export type Variant = { label: string; positions: number[] };
export type FoldResult = { fold: number; label: string; oosSharpe: number; bars: number };

/** Expanding-window multi-fold walk-forward: first 40% always IS, then `folds`
 *  equal OOS chunks over the back 60%; each fold re-picks the IS-best variant. */
export function multiFoldWalkForward(candles: DailyCandle[], variants: Variant[], opts: { folds?: number; feeBps?: number } = {}): FoldResult[] {
  const folds = opts.folds ?? 4;
  const n = candles.length;
  const start = Math.floor(n * 0.4);
  const chunk = Math.floor((n - start) / folds);
  const out: FoldResult[] = [];
  for (let k = 0; k < folds; k++) {
    const isEnd = start + k * chunk;
    const oosStart = isEnd;
    const oosEnd = k === folds - 1 ? n : isEnd + chunk;
    let best = variants[0], bestSh = -Infinity;
    for (const v of variants) {
      const sh = sharpe(variantReturns(candles.slice(0, isEnd), v.positions.slice(0, isEnd), opts.feeBps));
      if (sh > bestSh) { bestSh = sh; best = v; }
    }
    const oosSh = sharpe(variantReturns(candles.slice(oosStart, oosEnd), best.positions.slice(oosStart, oosEnd), opts.feeBps));
    out.push({ fold: k, label: best.label, oosSharpe: oosSh, bars: oosEnd - oosStart });
  }
  return out;
}
