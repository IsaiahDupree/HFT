/**
 * copy-backtest — does following the verified smart-money cohort actually PAY, and is their flow PREDICTIVE
 * or REACTIVE? Reconstructs each wallet's signed position over time from its fills, sums to a cohort net
 * position on a time grid, then asks two honest questions against price:
 *   1. copy-strategy return — go the cohort's net direction, NO-LOOKAHEAD (signal known at t → forward return).
 *   2. lead-lag — does a CHANGE in cohort position lead price (k>0, predictive/copyable) or lag it (k<0, they
 *      chase, so copying is too late)? This is what separates a real edge from reactive noise.
 * Pure + deterministic. The survivorship caveat (the cohort is selected on TODAY's profitability) lives in the
 * script's verdict — this lib just computes the mechanics honestly.
 */

export type Fill = { coin: string; dir: string; sz: number; px: number; time: number };
export type PosPoint = { time: number; pos: number };

/** Signed position delta of one fill: Open Long +, Close Long −, Open Short −, Close Short +  (sign = long===open). */
export function fillSignedDelta(dir: string, sz: number): number {
  const long = /Long/i.test(dir), open = /Open/i.test(dir);
  return (long === open ? 1 : -1) * Math.abs(sz);
}

/** Cumulative signed position over time for one coin, from a wallet's fills (ascending time). */
export function reconstructPositionSeries(fills: readonly Fill[], coin: string): PosPoint[] {
  const fs = fills.filter((f) => f.coin === coin && Number.isFinite(f.sz) && Number.isFinite(f.time)).sort((a, b) => a.time - b.time);
  const out: PosPoint[] = []; let pos = 0;
  for (const f of fs) { pos += fillSignedDelta(f.dir, f.sz); out.push({ time: f.time, pos }); }
  return out;
}

/** Position as of time t = the last point with time ≤ t (0 before the first fill). Series must be ascending. */
export function positionAt(series: readonly PosPoint[], t: number): number {
  let lo = 0, hi = series.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].time <= t) { ans = series[m].pos; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Net cohort position at time t = sum of each wallet's position as of t (coin units; the SIGN is the signal). */
export function cohortNetAt(perWallet: ReadonlyArray<readonly PosPoint[]>, t: number): number {
  return perWallet.reduce((a, s) => a + positionAt(s, t), 0);
}

export const buildGrid = (startMs: number, endMs: number, stepMs: number): number[] => {
  const g: number[] = []; for (let t = startMs; t <= endMs; t += stepMs) g.push(t); return g;
};

/**
 * Copy-strategy returns, NO-LOOKAHEAD: cohortNet[i] is the position as of grid time i (known at i); it is
 * applied to the FORWARD price return priceReturns[i] (close[i]→close[i+1]). length = priceReturns.length.
 */
export function copyStrategyReturns(cohortNet: readonly number[], priceReturns: readonly number[]): number[] {
  return priceReturns.map((r, i) => Math.sign(cohortNet[i] ?? 0) * r);
}

export const pctReturns = (closes: readonly number[]): number[] => closes.slice(1).map((c, i) => (closes[i] > 0 ? c / closes[i] - 1 : 0));

export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length); if (n < 2) return 0;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Lead-lag: corr between cohort-position CHANGE (flow) and price returns at each lag k ∈ [−maxLag, maxLag].
 * k>0 ⇒ flow LEADS price (predictive — copyable); k<0 ⇒ flow LAGS (they chase — too late to copy).
 */
export function leadLag(cohortNet: readonly number[], priceReturns: readonly number[], maxLag = 3): Array<{ lag: number; corr: number }> {
  const flow = cohortNet.slice(1).map((p, i) => p - cohortNet[i]); // Δposition aligned to priceReturns index
  const out: Array<{ lag: number; corr: number }> = [];
  for (let k = -maxLag; k <= maxLag; k++) {
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < flow.length; i++) { const j = i + k; if (j >= 0 && j < priceReturns.length) { a.push(flow[i]); b.push(priceReturns[j]); } }
    out.push({ lag: k, corr: pearson(a, b) });
  }
  return out;
}

export const sharpe = (r: readonly number[]): number => {
  const n = r.length; if (n < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return sd > 0 ? (m / sd) * Math.sqrt(n) : 0; // per-window Sharpe over the sample
};
export const hitRate = (r: readonly number[]): number => { const nz = r.filter((x) => x !== 0); return nz.length ? nz.filter((x) => x > 0).length / nz.length : 0; };
export const totalReturn = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0);
