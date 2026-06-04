/**
 * lead-lag — which of two price feeds moves FIRST. Cross-correlate the two RETURN series across
 * shifts: if venue A's return at t best predicts venue B's return at t+L (L>0), A LEADS B by L
 * samples. Works on any aligned grid — minute candles (detects ≥1-bar leads) or WS ticks
 * (sub-second). Pure + deterministic. (Lead-lag is descriptive, not tradeable on its own: a
 * leader you can't reach faster than your own latency is not an edge — but it tells you which
 * feed to trust for price discovery.)
 */

export type Tick = { ts: number; price: number };

/**
 * Resample irregular ticks onto a uniform grid: out[k] = last price with ts < t0+(k+1)*bucketMs
 * ("price as known by the end of bucket k"), forward-filled; NaN for buckets before the first
 * tick. Two venues resampled with the SAME (bucketMs, t0, t1) are aligned bar-for-bar, so their
 * returns can be cross-correlated. Use EXCHANGE timestamps (not local receive) to avoid network/
 * proxy-latency bias when measuring which venue's price moves first.
 */
export function resampleLastPrice(ticks: readonly Tick[], bucketMs: number, t0: number, t1: number): number[] {
  const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
  const out: number[] = [];
  let j = 0, last = NaN;
  for (let t = t0; t <= t1; t += bucketMs) {
    const end = t + bucketMs;
    while (j < sorted.length && sorted[j].ts < end) { last = sorted[j].price; j++; }
    out.push(last);
  }
  return out;
}

/** Drop the leading buckets where EITHER series is still NaN (before both venues had a tick). */
export function trimToCommon(a: number[], b: number[]): { a: number[]; b: number[] } {
  let start = 0;
  while (start < a.length && (!Number.isFinite(a[start]) || !Number.isFinite(b[start]))) start++;
  return { a: a.slice(start), b: b.slice(start) };
}

/** Pearson correlation of two equal-length series. 0 if either is constant or lengths differ. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  const den = Math.sqrt(saa * sbb);
  return den > 0 ? sab / den : 0;
}

/** Simple per-step returns from a close series: r[i] = close[i]/close[i-1] − 1 (length n−1). */
export function toReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i - 1];
    out.push(p > 0 && Number.isFinite(closes[i]) ? closes[i] / p - 1 : 0);
  }
  return out;
}

export type XCorr = { lag: number; corr: number };

/**
 * Cross-correlation of return series `a` and `b` for lags in [−maxLag, +maxLag].
 * Convention: at lag L > 0 we correlate a[t] with b[t+L] — i.e. a positive-lag peak means
 * **A leads B** (A's move shows up in B `L` samples later). L < 0 means B leads A.
 */
export function crossCorrelation(a: readonly number[], b: readonly number[], maxLag: number): XCorr[] {
  const out: XCorr[] = [];
  const n = Math.min(a.length, b.length);
  for (let L = -maxLag; L <= maxLag; L++) {
    // a[t] vs b[t+L]: take overlapping windows.
    let av: number[], bv: number[];
    if (L >= 0) { av = a.slice(0, n - L) as number[]; bv = b.slice(L, n) as number[]; }
    else { av = a.slice(-L, n) as number[]; bv = b.slice(0, n + L) as number[]; }
    out.push({ lag: L, corr: pearson(av, bv) });
  }
  return out;
}

export type LeadLagResult = {
  bestLag: number;     // lag (in samples) of the peak |corr|; >0 ⇒ A leads, <0 ⇒ B leads
  bestCorr: number;    // correlation at the peak
  zeroCorr: number;    // contemporaneous (lag-0) correlation
  leader: "A" | "B" | "sync";
  samples: number;     // overlap used at lag 0
};

/**
 * Find the lead-lag peak between two return series. `leader` is "A"/"B"/"sync" based on the sign
 * of the peak lag (sync when the peak is at lag 0 or the peak barely beats lag-0 — see `margin`).
 * `margin` (default 0.02) is how much the best off-zero corr must exceed the lag-0 corr to claim
 * a leader rather than calling it synchronous.
 */
export function leadLag(a: readonly number[], b: readonly number[], maxLag = 5, margin = 0.02): LeadLagResult {
  const xc = crossCorrelation(a, b, maxLag);
  const zero = xc.find((x) => x.lag === 0)?.corr ?? 0;
  let best = xc[0];
  for (const x of xc) if (Math.abs(x.corr) > Math.abs(best.corr)) best = x;
  const decisive = Math.abs(best.corr) - Math.abs(zero) >= margin && best.lag !== 0;
  const leader: LeadLagResult["leader"] = !decisive ? "sync" : best.lag > 0 ? "A" : "B";
  return { bestLag: best.lag, bestCorr: best.corr, zeroCorr: zero, leader, samples: Math.min(a.length, b.length) };
}
