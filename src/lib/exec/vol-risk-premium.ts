/**
 * vol-risk-premium — the pure core math of the OPTIONS VOL-RISK-PREMIUM (VRP) carry edge
 * (Edge #3). Extracted out of scripts/_carry-deribit-vol-risk-premium.ts so the economics
 * are unit-testable in isolation, with NO network and NO scaling artifacts.
 *
 * THE EDGE: Deribit's DVOL (30-day forward IMPLIED vol on BTC) typically sits ABOVE the vol
 * the market subsequently REALIZES. The spread VRP = implied − realized is the option seller's
 * structural carry yield. It is PAID for bearing a FAT LEFT TAIL (crash gaps) — so the honest
 * risk number must (a) use NON-OVERLAPPING holding blocks (the ladder's overlap autocorrelates
 * consecutive daily returns and INFLATES Sharpe), and (b) report the negative-skew / left-tail.
 *
 * Everything here is PURE + DETERMINISTIC and NO-LOOKAHEAD where it matters:
 *   • the SIGNAL leg (trailingRealizedVol, vrpSignal) reads only data at indices ≤ i.
 *   • the REALIZED leg (realizedVolOverWindow) reads the future (i, i+H] — that is the
 *     realization the contract was priced against, and it NEVER feeds the decision to enter.
 */

const DEFAULT_ANN = Math.sqrt(365); // daily → annual for crypto (365 trading days)

// ───────────────────────── core premium ─────────────────────────

/**
 * Vol-risk premium = implied − realized, in the SAME units as the inputs.
 * Pass fractions (0.65) → premium fraction; pass vol points (65) → premium points.
 * SIGN: positive ⇒ implied richer than realized ⇒ the short-vol seller is PAID (the edge);
 * negative ⇒ realized exceeded implied ⇒ the seller bled (a tail / vol-spike day).
 * Non-finite either side ⇒ NaN (the downstream gate then flattens rather than trading on junk).
 */
export function vrpPremium(implied: number, realized: number): number {
  if (!Number.isFinite(implied) || !Number.isFinite(realized)) return NaN;
  return implied - realized;
}

/** Vectorized vrpPremium over aligned implied/realized series (length = min of the two). */
export function vrpPremiumSeries(implied: number[], realized: number[]): number[] {
  const n = Math.min(implied.length, realized.length);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = vrpPremium(implied[i], realized[i]);
  return out;
}

// ───────────────────────── realized vol ─────────────────────────

/**
 * Realized vol from an array of (log) returns: sample std (n−1 denominator) × annualization.
 * < 2 finite returns ⇒ NaN (variance undefined). Non-finite entries are dropped, so a series
 * with junk still yields the std of its clean members (matches "skip the bad bar" semantics).
 * This is the building block; the windowed/trailing variants below call into it.
 */
export function realizedVolFromReturns(returns: number[], ann: number = DEFAULT_ANN): number {
  const clean = returns.filter((x) => Number.isFinite(x));
  if (clean.length < 2) return NaN;
  const m = clean.reduce((s, x) => s + x, 0) / clean.length;
  const v = clean.reduce((s, x) => s + (x - m) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(v) * ann;
}

/**
 * Annualized realized vol of log-returns over the FORWARD window (i, i+H] — i.e. the H days
 * AFTER day i. This is the REALIZATION leg of a variance swap struck at day i (the future the
 * contract is priced against). Returns NaN when the window would run off the end (truncated),
 * so a short-vol position that can't be fully realized is dropped rather than half-counted.
 *
 * NOTE ON LOOKAHEAD: this DELIBERATELY reads the future. It is the realized P&L, not a signal.
 * The no-lookahead guarantee is that this value is never used to DECIDE entry (see vrpSignal,
 * which reads only trailingRealizedVol ≤ i).
 */
export function realizedVolOverWindow(logret: number[], i: number, H: number, ann: number = DEFAULT_ANN): number {
  if (H < 2) return NaN;
  if (i < 0 || i + H >= logret.length) return NaN; // (i, i+H] needs index i+H to exist
  const win = logret.slice(i + 1, i + 1 + H);
  return realizedVolFromReturns(win, ann);
}

/**
 * TRAILING annualized realized vol for the SIGNAL: sample std of the last n log-returns ENDING
 * at i (so it reads only closes[0..i]) × annualization. NaN until i ≥ n. NO-LOOKAHEAD:
 * trailRV[i] depends only on closes at indices ≤ i.
 * A non-positive close anywhere in the window taints that window → NaN (the gate then flattens),
 * matching the upstream realizedVol() degenerate-input contract.
 */
export function trailingRealizedVol(closes: number[], n: number, ann: number = DEFAULT_ANN): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (n < 2) return out;
  // log-returns; ret[i] requires close[i-1] and close[i] both > 0.
  const ret = closes.map((c, i) => {
    if (i === 0) return NaN;
    const p = closes[i - 1];
    return p > 0 && c > 0 ? Math.log(c / p) : NaN;
  });
  for (let i = n; i < closes.length; i++) {
    let bad = false;
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) {
      if (!Number.isFinite(ret[k])) { bad = true; break; }
      m += ret[k];
    }
    if (bad) continue; // leave NaN
    m /= n;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (ret[k] - m) ** 2;
    out[i] = Math.sqrt(s / (n - 1)) * ann;
  }
  return out;
}

// ───────────────────────── the carry gate ─────────────────────────

export type VrpGateOpts = {
  /** minimum observed premium (implied − trailing-realized) to SELL vol, SAME units as iv/rv. */
  minVRP?: number;
};

/**
 * VRP short-vol signal: side[i] = −1 (SHORT vol) when the OBSERVED premium iv[i] − trailRV[i]
 * is ≥ minVRP, else 0 (flat). Reads ONLY data at index i (iv[i], trailRV[i]); trailRV is itself
 * no-lookahead, so the whole signal is causal. Non-finite / non-positive iv ⇒ flat.
 * BOUNDARY: the gate is INCLUSIVE — premium exactly == minVRP enters short.
 */
export function vrpSignal(iv: number[], trailRV: number[], opts: VrpGateOpts = {}): number[] {
  const minVRP = opts.minVRP ?? 0;
  const n = Math.min(iv.length, trailRV.length);
  const out: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const K = iv[i], rv = trailRV[i];
    // require a FINITE positive implied: an Infinity/NaN K is junk data, never a tradable short
    // (a bare `K > 0` lets Infinity through and would short on garbage).
    if (!Number.isFinite(K) || !(K > 0) || !Number.isFinite(rv)) continue;
    if (K - rv >= minVRP) out[i] = -1; // SHORT vol
  }
  return out;
}

// ───────────────────────── position P&L ─────────────────────────

/**
 * Per-position short-vol carry P&L, net of round-trip slippage, in the units of K/rvReal.
 *   pnl = side · (K − rvReal) − feeVol
 * with side = −1 for the short. We fold the −1 in: a SHORT (the only thing this edge does)
 * earns (K − rvReal) − fee. So when implied K exceeds realized rvReal you keep the spread,
 * minus the fixed slippage drag. feeVol is a NON-NEGATIVE drag (clamped): it can only REDUCE
 * P&L. NaN K or rvReal ⇒ NaN (the dropped-position contract).
 */
export function shortVolPnl(K: number, rvReal: number, feeVol = 0): number {
  if (!Number.isFinite(K) || !Number.isFinite(rvReal)) return NaN;
  const fee = Number.isFinite(feeVol) ? Math.max(0, feeVol) : 0;
  return (K - rvReal) - fee;
}

// ───────────────────────── non-overlapping vs overlapping P&L ─────────────────────────

export type LadderOpts = {
  rvWindow: number; // trailing-RV lookback for the signal
  horizon: number;  // H, the holding window over which the position realizes
  minVRP?: number;  // gate threshold (fraction)
  feeVol?: number;  // round-trip slippage per position (fraction)
  ann?: number;     // daily→annual factor for the vols
};

/**
 * NON-OVERLAPPING block P&Ls (the HONEST series). Enter once every H days, hold to expiry, so
 * each block is an INDEPENDENT short-vol position with no shared days. Returns one P&L per block
 * that (a) clears the gate AND (b) has a fully-realized window. This is the un-inflated truth
 * about the carry's risk — far fewer, statistically independent observations than the ladder.
 */
export function nonOverlappingPnl(iv: number[], closes: number[], logret: number[], opts: LadderOpts): number[] {
  const ann = opts.ann ?? DEFAULT_ANN;
  const minVRP = opts.minVRP ?? 0;
  const feeVol = opts.feeVol ?? 0;
  const H = opts.horizon;
  const trailRV = trailingRealizedVol(closes, opts.rvWindow, ann);
  const out: number[] = [];
  for (let i = opts.rvWindow; i < closes.length - H - 1; i += H) {
    const K = iv[i], rvT = trailRV[i];
    if (!(K > 0) || !Number.isFinite(rvT) || K - rvT < minVRP) continue;
    const rvReal = realizedVolOverWindow(logret, i, H, ann);
    if (!Number.isFinite(rvReal)) continue;
    out.push(shortVolPnl(K, rvReal, feeVol));
  }
  return out;
}

/**
 * OVERLAPPING ladder daily P&L (the SMOOTH, overlap-inflated series). Open one fresh H-day
 * position per eligible day, spread each position's P&L evenly across its H holding days, and
 * normalize by the daily count of concurrent positions (per-unit-vega). Consecutive days share
 * ~ (H−1)/H of the same positions ⇒ heavy positive autocorrelation ⇒ an INFLATED daily Sharpe.
 * Returns the dense per-day series (only days with a live position).
 */
export function overlappingLadderReturns(iv: number[], closes: number[], logret: number[], opts: LadderOpts): number[] {
  const ann = opts.ann ?? DEFAULT_ANN;
  const minVRP = opts.minVRP ?? 0;
  const feeVol = opts.feeVol ?? 0;
  const H = opts.horizon;
  const N = closes.length;
  const trailRV = trailingRealizedVol(closes, opts.rvWindow, ann);
  const accrual = new Array(N).fill(0);
  const concurrency = new Array(N).fill(0);
  for (let i = opts.rvWindow; i < N - H - 1; i++) {
    const K = iv[i], rvT = trailRV[i];
    if (!(K > 0) || !Number.isFinite(rvT) || K - rvT < minVRP) continue;
    const rvReal = realizedVolOverWindow(logret, i, H, ann);
    if (!Number.isFinite(rvReal)) continue;
    const posPnl = shortVolPnl(K, rvReal, feeVol);
    for (let d = 1; d <= H; d++) { accrual[i + d] += posPnl / H; concurrency[i + d] += 1; }
  }
  const out: number[] = [];
  for (let i = 0; i < N; i++) if (concurrency[i] > 0) out.push(accrual[i] / concurrency[i]);
  return out;
}

// ───────────────────────── Sharpe (honest, annualized) ─────────────────────────

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sampleStd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const ss = a.reduce((s, x) => s + (x - m) ** 2, 0);
  // Float residual: a CONSTANT series should give variance 0, but Σ(x−μ)² accumulates a tiny
  // (~1e-33·scale²) non-zero from rounding. Treat a sum-of-squares that is negligible relative to
  // the data's magnitude as exactly 0 — otherwise Sharpe/skew divide by ~0 and explode to garbage.
  const scale = a.reduce((s, x) => s + x * x, 0);
  if (ss <= 1e-24 * Math.max(scale, 1)) return 0;
  return Math.sqrt(ss / (a.length - 1));
};

/** Per-period Sharpe (mean / sample-std). 0 when std is 0 or < 2 points (undefined risk). */
export function perPeriodSharpe(rets: number[]): number {
  const sd = sampleStd(rets);
  return sd > 0 ? mean(rets) / sd : 0;
}

/**
 * HONEST annualized Sharpe of the NON-OVERLAPPING block series: per-block Sharpe scaled by
 * √(blocks per year) = √(365 / horizon). Because the blocks are independent, this √-scaling is
 * legitimate (unlike scaling the overlapping daily Sharpe by √365, which double-counts the
 * autocorrelated overlap and is what produced the discarded, dishonest 9.26).
 */
export function nonOverlapAnnualizedSharpe(blockPnl: number[], horizon: number): number {
  const perBlock = perPeriodSharpe(blockPnl);
  const blocksPerYear = 365 / horizon;
  return perBlock * Math.sqrt(blocksPerYear);
}

// ───────────────────────── left-tail / negative-skew risk ─────────────────────────

export type TailStats = {
  worst: number;       // minimum return (the single worst day/block)
  p1: number;          // ~1st-percentile return (left-tail VaR proxy)
  skew: number;        // sample skewness; NEGATIVE ⇒ fat left tail (short-vol's real risk)
  downsideDev: number; // std of the negative-return subset (semi-deviation around 0)
  win: number;         // count of strictly-positive returns
  loss: number;        // count of strictly-negative returns
  leftTail: boolean;   // skew < 0 (the honest red flag): losses are larger & rarer than wins
};

/**
 * Left-tail / negative-skew panel. Short vol's average yield is paid for bearing crash gaps,
 * so the honest report surfaces: the worst observation, a 1%-ile VaR proxy, the SKEW (negative
 * ⇒ fat left tail), the downside deviation, and the leftTail flag. Empty / <2 ⇒ zeros, not throw.
 */
export function tailStats(rets: number[]): TailStats {
  const clean = rets.filter((x) => Number.isFinite(x));
  if (clean.length === 0) {
    return { worst: NaN, p1: NaN, skew: 0, downsideDev: 0, win: 0, loss: 0, leftTail: false };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const worst = sorted[0];
  const p1 = sorted[Math.floor(sorted.length * 0.01)];
  const m = mean(clean);
  const sd = sampleStd(clean);
  // sample skewness using the same population-style 3rd moment as the script (Σ((x−μ)/σ)³ / n).
  const skew = sd > 0 ? clean.reduce((s, x) => s + ((x - m) / sd) ** 3, 0) / clean.length : 0;
  const neg = clean.filter((x) => x < 0);
  const downsideDev = neg.length ? Math.sqrt(neg.reduce((s, x) => s + x * x, 0) / neg.length) : 0;
  const win = clean.filter((x) => x > 0).length;
  const loss = clean.filter((x) => x < 0).length;
  return { worst, p1, skew, downsideDev, win, loss, leftTail: skew < 0 };
}

export const VRP_DEFAULT_ANN = DEFAULT_ANN;
