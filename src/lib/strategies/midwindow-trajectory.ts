/**
 * Midwindow trajectory extrapolation — for Polymarket 5-min crypto Up/Down
 * binaries, decide in the [T+90s, T+150s] sub-window whether trajectory +
 * variance imply a directional bet against the current market price.
 *
 * Thesis (and its limits): in a 5-min window, the first 2 min carry SOME
 * signal about the final 3 min, but they also carry mostly noise. Naive
 * "trajectory exists → bet" loses to the MM, because the MM watches the same
 * chart. The edge is in cases where:
 *   (a) the 2-min move is large enough to be statistically significant
 *       (|z| ≳ 1.0 relative to the period's variance), AND
 *   (b) the market hasn't priced in the implied probability yet
 *       (|model_prob - market_prob| > edgeThreshold + fee).
 *
 * Decision math (per equations stated in spec):
 *   elapsed_min     = (now - windowOpen) / 60_000
 *   remaining_min   = (windowClose - now) / 60_000
 *   delta           = priceNow - priceAtOpen
 *   projected_final = priceNow + delta × (remaining_min / elapsed_min)
 *   sigma_1min      = stdev(per-minute log returns) × priceNow
 *   sigma_remaining = sigma_1min × sqrt(remaining_min)
 *   z_final         = (projected_final - strike) / sigma_remaining
 *   P_up_model      = Φ(z_final)
 *   edge            = P_up_model - P_up_market    ← market = upPrice (best ask UP)
 *   ENTER if |edge| > edgeThreshold + feeAdj AND sign matches
 *
 * Φ uses Abramowitz-Stegun 7.1.26 (max error ~1.5e-7) — no scipy dependency.
 *
 * Pure function. Returns MidwindowOpportunity or null.
 *
 * Safety properties:
 *   - Returns null if `nowMs` is outside [windowOpen + minElapsedMs, windowClose - 60s].
 *     This enforces the [T+90s, T+150s] sub-window when defaults are used.
 *   - Returns null on insufficient ticks (default ≥ 30 within the elapsed period).
 *   - Returns null if sigma is non-finite or ≤ 0 (degenerate variance).
 *   - Returns null on price/strike sanity violations (NaN, ≤ 0, market prices
 *     outside (0, 1)).
 *   - |edge| must clear edgeThreshold + feeAdjustment combined.
 *   - zMove (|delta| / sigma_elapsed) must exceed minZMove — filters out
 *     pure-noise trajectories.
 *   - efficiency (|delta| / Σ|tick-step|) must exceed minEfficiency. This is
 *     the chop/sideways filter — a market with high path length but small
 *     net delta is oscillating, not trending, and the trajectory model will
 *     misfire. For a pure random walk over N ticks the expected efficiency
 *     is ~sqrt(2/(πN)) ≈ 0.10 at N=60; threshold 0.30 leaves clear daylight
 *     above noise.
 *
 * The caller (a worker or backtester) supplies the snapshot; this module is
 * the decision logic and has zero side effects.
 */

export type MidwindowTick = {
  /** Epoch ms. */
  ts: number;
  /** Spot price of the underlying. */
  price: number;
};

export type MidwindowSnapshot = {
  conditionId: string;
  title?: string;
  /** Underlying asset symbol — informational only ("BTC", "ETH", etc.). */
  asset: string;
  /** Resolution threshold. Market resolves UP if final spot > strike, DOWN if < strike. */
  strike: number;
  /** Epoch ms for T (window start). */
  windowOpenMs: number;
  /** Epoch ms for T+5min (window close). */
  windowCloseMs: number;
  /** Current epoch ms. Must be inside the window. */
  nowMs: number;
  /** Underlying spot price at window open (T). */
  priceAtOpen: number;
  /** Most recent underlying spot price. */
  priceNow: number;
  /** Per-second-ish ticks since windowOpen. Used for variance estimation. */
  ticksSinceOpen: MidwindowTick[];
  /** Best ask on UP outcome — what we'd pay to buy UP. */
  upPrice: number;
  /** Best ask on DOWN outcome — what we'd pay to buy DOWN. */
  downPrice: number;
  /** USD-denominated top-of-book liquidity. */
  liquidityUsd: number;
};

export type MidwindowOpportunity = {
  conditionId: string;
  title?: string;
  asset: string;
  side: "UP" | "DOWN";
  /** What we'd pay per share (best ask on the chosen side). */
  entryPrice: number;
  /** Trajectory-extrapolated underlying spot at T+5min. */
  projectedFinal: number;
  /** Φ(z_final) — model's probability the market resolves UP. */
  modelProbUp: number;
  /** Market-implied probability UP — equals upPrice (best ask). */
  marketProbUp: number;
  /** modelProbUp - marketProbUp (signed). Positive ⇒ buy UP, negative ⇒ buy DOWN. */
  signedEdge: number;
  /** |signedEdge| - feeAdjustment. The dollars-per-share you keep if your model is right and the market converges. */
  edge: number;
  /** |delta| / sigma_elapsed. How many σ the 2-min move was. Higher = more signal. */
  zMove: number;
  /** Final-position z-score: (projected - strike) / sigma_remaining. */
  zFinal: number;
  /**
   * Directional efficiency: |delta| / Σ|tick-step|. Bounded [0, 1].
   * 1.0 = monotonic move; near 0 = pure chop. The trajectory model is only
   * informative when efficiency clears the random-walk noise floor (~0.10
   * for N=60 ticks). Surfaced on the result so callers / dashboards can see
   * "how trendy was this 2-min window."
   */
  efficiency: number;
  /** Sigma of the underlying over the remaining window, in price units. */
  sigmaRemaining: number;
  elapsedMin: number;
  remainingMin: number;
  liquidityUsd: number;
  reason: string;
};

export type MidwindowOptions = {
  /** Min ms past windowOpen to fire signal. Default 90_000 (T+90s). */
  minElapsedMs?: number;
  /** Max ms past windowOpen to fire signal. Default 150_000 (T+150s). */
  maxElapsedMs?: number;
  /** Min ticks required since windowOpen. Default 30. */
  minTicks?: number;
  /** Min |zMove| of the elapsed move (to ensure trajectory is significant). Default 1.0. */
  minZMove?: number;
  /** Min |edge| (after fee adjustment) to fire. Default 0.05 (5pp). */
  edgeThreshold?: number;
  /** Round-trip fee in basis points (applied as price-units penalty). Default 20. */
  feeBps?: number;
  /** Floor on sigma (in price units) — guards against degenerate near-zero variance. Default 1e-6. */
  minSigma?: number;
  /**
   * Minimum directional efficiency (|delta| / Σ|tick-step|) for the elapsed
   * window. Filters out sideways/chop conditions where the trajectory model
   * would fire on noise. Default 0.30. Set to 0 to disable.
   */
  minEfficiency?: number;
};

const DEFAULT_FEE_BPS = 20;
const DEFAULT_MIN_ELAPSED_MS = 90_000;
const DEFAULT_MAX_ELAPSED_MS = 150_000;
const DEFAULT_MIN_TICKS = 30;
const DEFAULT_MIN_Z_MOVE = 1.0;
const DEFAULT_EDGE_THRESHOLD = 0.05;
const DEFAULT_MIN_SIGMA = 1e-6;
const DEFAULT_MIN_EFFICIENCY = 0.30;

/** Abramowitz-Stegun 7.1.26 erf approximation. Max error ~1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Sample standard deviation. Returns 0 for arrays shorter than 2. */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function detectMidwindowTrajectory(
  snap: MidwindowSnapshot,
  opts: MidwindowOptions = {},
): MidwindowOpportunity | null {
  const minElapsedMs = opts.minElapsedMs ?? DEFAULT_MIN_ELAPSED_MS;
  const maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const minTicks = opts.minTicks ?? DEFAULT_MIN_TICKS;
  const minZMove = opts.minZMove ?? DEFAULT_MIN_Z_MOVE;
  const edgeThreshold = opts.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;
  const feeBps = opts.feeBps ?? DEFAULT_FEE_BPS;
  const minSigma = opts.minSigma ?? DEFAULT_MIN_SIGMA;
  const minEfficiency = opts.minEfficiency ?? DEFAULT_MIN_EFFICIENCY;

  // --- Window sanity ---
  const windowSpan = snap.windowCloseMs - snap.windowOpenMs;
  if (!Number.isFinite(windowSpan) || windowSpan <= 0) return null;
  const elapsedMs = snap.nowMs - snap.windowOpenMs;
  const remainingMs = snap.windowCloseMs - snap.nowMs;
  if (elapsedMs < minElapsedMs || elapsedMs > maxElapsedMs) return null;
  if (remainingMs <= 60_000) return null; // need at least 1 min remaining to project
  const elapsedMin = elapsedMs / 60_000;
  const remainingMin = remainingMs / 60_000;

  // --- Price sanity ---
  if (!Number.isFinite(snap.priceAtOpen) || snap.priceAtOpen <= 0) return null;
  if (!Number.isFinite(snap.priceNow) || snap.priceNow <= 0) return null;
  if (!Number.isFinite(snap.strike) || snap.strike <= 0) return null;
  if (!Number.isFinite(snap.upPrice) || snap.upPrice <= 0 || snap.upPrice >= 1) return null;
  if (!Number.isFinite(snap.downPrice) || snap.downPrice <= 0 || snap.downPrice >= 1) return null;

  // --- Tick sanity ---
  if (snap.ticksSinceOpen.length < minTicks) return null;

  // --- Variance: per-second-equivalent stdev from log returns ---
  // Use log-return per tick; scale to per-minute equivalent via tick-interval.
  const ticks = snap.ticksSinceOpen;
  const logReturns: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1]!.price;
    const curr = ticks[i]!.price;
    if (prev <= 0 || curr <= 0) continue;
    logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < minTicks - 1) return null;
  const sigmaLogPerTick = stdev(logReturns);

  // Mean tick interval (ms). If ticks aren't evenly spaced, this is the best
  // we can do without per-tick weighting. Falls back to elapsedMs/N if needed.
  const tickIntervals: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const dt = ticks[i]!.ts - ticks[i - 1]!.ts;
    if (dt > 0 && dt < 60_000) tickIntervals.push(dt);
  }
  const meanTickIntervalMs =
    tickIntervals.length > 0
      ? tickIntervals.reduce((a, b) => a + b, 0) / tickIntervals.length
      : elapsedMs / Math.max(1, ticks.length - 1);
  if (!Number.isFinite(meanTickIntervalMs) || meanTickIntervalMs <= 0) return null;

  // sigma per minute (log-scale) = sigmaLogPerTick × sqrt(ticks-per-minute)
  const ticksPerMin = 60_000 / meanTickIntervalMs;
  const sigmaLogPerMin = sigmaLogPerTick * Math.sqrt(ticksPerMin);

  // sigma over remaining window, converted to price units via log-normal first-order approx.
  const sigmaRemainingLog = sigmaLogPerMin * Math.sqrt(remainingMin);
  const sigmaRemaining = snap.priceNow * sigmaRemainingLog;
  if (!Number.isFinite(sigmaRemaining) || sigmaRemaining < minSigma) return null;

  // --- Trajectory significance: zMove of elapsed delta against elapsed sigma ---
  const sigmaElapsedLog = sigmaLogPerMin * Math.sqrt(elapsedMin);
  const sigmaElapsedPrice = snap.priceNow * sigmaElapsedLog;
  if (sigmaElapsedPrice < minSigma) return null;
  const delta = snap.priceNow - snap.priceAtOpen;
  const zMove = Math.abs(delta) / sigmaElapsedPrice;
  if (zMove < minZMove) return null;

  // --- Chop/sideways filter: directional efficiency ---
  // efficiency = |net delta| / Σ|tick-to-tick step|. Bounded [0, 1].
  // 1.0 = monotonic trend, 0 = pure oscillation. For random walk over N
  // ticks, expected efficiency ≈ sqrt(2/(πN)) ≈ 0.10 at N=60. Default
  // threshold 0.30 sits cleanly above the random-walk noise floor.
  let pathLength = 0;
  for (let i = 1; i < ticks.length; i++) {
    pathLength += Math.abs(ticks[i]!.price - ticks[i - 1]!.price);
  }
  const efficiency = pathLength <= 0 ? 0 : Math.min(1, Math.abs(delta) / pathLength);
  if (efficiency < minEfficiency) return null;

  // --- Extrapolation + model probability ---
  const projectedFinal = snap.priceNow + delta * (remainingMin / elapsedMin);
  const zFinal = (projectedFinal - snap.strike) / sigmaRemaining;
  const modelProbUp = normCdf(zFinal);

  // Market-implied: best-ask UP is what we pay to win $1 if UP, so it's the
  // upper bound on the market's true belief that UP wins. Approximate market
  // P(UP) = upPrice for the comparison (consistent with NRS handling).
  const marketProbUp = snap.upPrice;
  const signedEdge = modelProbUp - marketProbUp;

  // Fee adjustment in probability units = fee bps converted to a price-points penalty.
  const feeAdjustment = feeBps / 10_000;
  const edgeNet = Math.abs(signedEdge) - feeAdjustment;
  if (edgeNet <= edgeThreshold) return null;

  const side: "UP" | "DOWN" = signedEdge > 0 ? "UP" : "DOWN";
  const entryPrice = side === "UP" ? snap.upPrice : snap.downPrice;
  // Defensive: re-check the chosen side's price sanity.
  if (entryPrice <= 0 || entryPrice >= 1) return null;

  return {
    conditionId: snap.conditionId,
    title: snap.title,
    asset: snap.asset,
    side,
    entryPrice,
    projectedFinal,
    modelProbUp,
    marketProbUp,
    signedEdge,
    edge: edgeNet,
    zMove,
    zFinal,
    efficiency,
    sigmaRemaining,
    elapsedMin,
    remainingMin,
    liquidityUsd: snap.liquidityUsd,
    reason:
      `${snap.asset} ${side} @ ${entryPrice.toFixed(3)}` +
      ` · Δ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} over ${elapsedMin.toFixed(1)}m (z=${zMove.toFixed(2)}, eff=${efficiency.toFixed(2)})` +
      ` · proj T+5 = ${projectedFinal.toFixed(2)} vs strike ${snap.strike.toFixed(2)} (z=${zFinal.toFixed(2)})` +
      ` · model ${(modelProbUp * 100).toFixed(0)}% vs market ${(marketProbUp * 100).toFixed(0)}% → edge ${(edgeNet * 100).toFixed(1)}pp`,
  };
}
