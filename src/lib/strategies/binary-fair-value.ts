/**
 * binary-fair-value — the INDEPENDENT fair price of a crypto binary, computed
 * from a live CEX spot feed instead of read off the (stale) Polymarket mid.
 *
 * This is the piece coinman2's maker edge actually turns on: when Binance has
 * already moved, the true probability that an "above-$K at expiry" market
 * resolves Yes has shifted, but the Polymarket quote hasn't caught up yet. A
 * maker who prices off the CEX feed quotes the correct probability and the
 * stale resting orders trade into it.
 *
 * MODEL. Over a short horizon τ, log-price is a driftless symmetric random walk:
 *   ln S_τ ~ Normal( ln S_0 , σ²τ ),  σ = per-√time vol in the SAME unit as τ.
 * For an ABOVE-strike digital this gives:
 *
 *     P(S_τ > K) = Φ( ( ln(S_0/K) + (μ − ½cσ²)τ ) / (σ√τ) )
 *
 * The ½σ² "vol drag" (c=1) is the Black-Scholes term that makes the *price* a
 * martingale (E[S_τ]=S_0), which pulls the at-the-money digital slightly BELOW
 * 0.5. We DEFAULT it OFF (c=0): a maker claiming no directional view wants the
 * symmetric baseline where the median sits at spot and ATM = exactly 0.5, so the
 * edge comes purely from spot moving vs the strike — not from a systematic short
 * tilt that's really just a modeling artifact (~0.6¢ at hourly crypto vols). Set
 * `volDrag: true` for the GBM price-martingale convention. μ defaults to 0 (no
 * forecast). At τ→0 this collapses to a hard step at K (we already know the
 * outcome) — exactly the "the move already happened" intuition.
 *
 * UP/DOWN markets ("will BTC be higher at the close of this 1h candle than at
 * the open") are the K = S_open special case: P(S_τ > S_open) = Φ((μ−½σ²)τ/(σ√τ)),
 * i.e. ≈ 0.5 with a small vol-drag tilt — so the maker edge there is almost
 * entirely about repricing as S moves relative to the *known, fixed* open, which
 * `priceAboveStrike(S_now, S_open, …)` handles directly.
 *
 * Everything here is pure + deterministic. σ is supplied by the caller (estimate
 * it from recent CEX returns via realizedVol in candle/indicators, scaled to the
 * τ unit) — intentionally NOT hardcoded, same discipline as the AS library.
 */

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation (≤7.5e-8 abs error). */
export function normCdf(x: number): number {
  // Φ(x) = ½(1 + erf(x/√2))
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

export type FairValueInputs = {
  /** Current CEX spot (Binance/Coinbase mid). */
  spot: number;
  /** Strike the binary is measured against. For Up/Down markets, the candle OPEN. */
  strike: number;
  /** Time to expiry, in the SAME unit `sigma` is expressed per-√of. Must be ≥ 0. */
  tau: number;
  /** Volatility per √(τ-unit). E.g. if tau is in hours, sigma is per-√hour. */
  sigma: number;
  /** Optional drift per τ-unit. Default 0 — we do not claim a directional forecast. */
  mu?: number;
  /** Apply the ½σ² Black-Scholes vol drag (GBM price-martingale). Default false
   *  (symmetric log-space walk → ATM = 0.5). */
  volDrag?: boolean;
};

/**
 * P(S_τ > strike) for an above-strike digital. Returns a probability in [0,1].
 *
 * Edge cases (all exercised by tests):
 *   - tau === 0  → the outcome is known: 1 if spot > strike, 0 if below, 0.5 at the knife's edge.
 *   - sigma === 0 → degenerate diffusion: same hard step as tau 0 (drift can still tip it).
 *   - non-finite / negative inputs → NaN (caller must gate; never silently 0.5).
 */
export function priceAboveStrike(inp: FairValueInputs): number {
  const { spot, strike, tau, sigma } = inp;
  const mu = inp.mu ?? 0;
  if (!(spot > 0) || !(strike > 0) || !Number.isFinite(tau) || tau < 0 || !Number.isFinite(sigma) || sigma < 0) {
    return NaN;
  }
  const denom = sigma * Math.sqrt(tau);
  if (denom === 0) {
    // No diffusion left (expiry now, or zero vol). Drift over a zero/var horizon
    // can't create uncertainty, so collapse to the deterministic step at strike.
    const driftAdj = Math.log(spot / strike) + mu * tau;
    if (driftAdj > 0) return 1;
    if (driftAdj < 0) return 0;
    return 0.5;
  }
  const drag = inp.volDrag ? 0.5 * sigma * sigma : 0;
  const d = (Math.log(spot / strike) + (mu - drag) * tau) / denom;
  return normCdf(d);
}

/** Convenience: P(below strike) = 1 − P(above strike). NaN-preserving. */
export function priceBelowStrike(inp: FairValueInputs): number {
  const a = priceAboveStrike(inp);
  return Number.isFinite(a) ? 1 - a : NaN;
}

/**
 * Scale a per-bar realized vol (σ measured on bars of `barSeconds` length, i.e.
 * the sample std of log-returns between consecutive bars) into the per-√unit σ
 * that priceAboveStrike wants for a τ expressed in `tauUnitSeconds`.
 *
 *   σ_per_bar is per √(barSeconds).  σ_per_τunit = σ_per_bar · √(tauUnitSeconds / barSeconds).
 *
 * Example: 1-minute bars (barSeconds=60), τ in hours (tauUnitSeconds=3600):
 *   σ_per_hour = σ_per_minute · √(3600/60) = σ_per_minute · √60.
 */
export function scaleVol(sigmaPerBar: number, barSeconds: number, tauUnitSeconds: number): number {
  if (!(sigmaPerBar >= 0) || !(barSeconds > 0) || !(tauUnitSeconds > 0)) return NaN;
  return sigmaPerBar * Math.sqrt(tauUnitSeconds / barSeconds);
}

/** Log-returns of consecutive positive closes. */
function logReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  return rets;
}

export type DriftEstimate = {
  /** Raw EWMA mean log-return per bar. */
  muPerBar: number;
  /** t-statistic of the EWMA mean against the per-bar vol (signal-to-noise). */
  tStat: number;
  /** Shrinkage applied: t²/(1+t²) ∈ [0,1). 0 = pure noise, →1 = strong trend. */
  shrink: number;
  /** The number to USE: muPerBar · shrink. */
  muShrunkPerBar: number;
  /** Effective sample size of the EWMA (Kish). */
  nEff: number;
};

/**
 * Momentum/drift estimate from recent closes: EWMA mean of log-returns with a
 * t-stat (signal-to-noise) shrinkage so a maker only tilts when the trend is
 * statistically distinguishable from noise.
 *
 * WHY (audit §7): the zero-drift fair value sat ~3¢ BELOW the live market mid
 * while BTC trended up — the market was pricing momentum we refused to model. A
 * raw recent-mean drift would over-chase noise, so we shrink it Bayes-style:
 *   μ_use = μ̂ · t²/(1+t²),  t = μ̂ / (σ_bar / √n_eff)
 * (the posterior-mean weight when signal and noise variance are equal). Flat or
 * choppy tape → t≈0 → μ_use≈0 and we recover the symmetric baseline; a sustained
 * trend → t grows → we tilt toward what the tape (and the market mid) already say.
 * Pure, deterministic, no lookahead — uses only the closes the caller supplies.
 */
export function estimateDriftPerBar(
  closes: number[],
  opts?: { halfLifeBars?: number },
): DriftEstimate | null {
  const halfLife = opts?.halfLifeBars ?? 60;
  if (!(halfLife > 0)) return null;
  const rets = logReturns(closes.filter((c) => c > 0));
  if (rets.length < 10) return null;

  const lambda = Math.exp(Math.log(0.5) / halfLife); // per-bar decay
  let wSum = 0, wxSum = 0, w2Sum = 0;
  // most-recent return gets weight 1, older bars decay
  for (let i = 0; i < rets.length; i++) {
    const w = Math.pow(lambda, rets.length - 1 - i);
    wSum += w; wxSum += w * rets[i]!; w2Sum += w * w;
  }
  const muPerBar = wxSum / wSum;
  const nEff = (wSum * wSum) / w2Sum; // Kish effective sample size

  // per-bar vol around the EWMA mean (equal-weight is fine for the noise scale)
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varr = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return { muPerBar, tStat: 0, shrink: 0, muShrunkPerBar: 0, nEff };

  const tStat = muPerBar / (sd / Math.sqrt(nEff));
  const shrink = (tStat * tStat) / (1 + tStat * tStat);
  return { muPerBar, tStat, shrink, muShrunkPerBar: muPerBar * shrink, nEff };
}

export type HorizonSigmaEstimate = {
  /** Per-bar sample vol (the naive input to √t scaling). */
  sigmaPerBar: number;
  /** Variance ratio Var(k-bar)/(k·Var(1-bar)): >1 persistent, <1 mean-reverting. */
  varianceRatio: number;
  /** Hurst-style scaling exponent, clamped: σ(n bars) = σ_bar · n^H. */
  hurst: number;
  /** Aggregation window used for the variance ratio. */
  aggBars: number;
};

/**
 * Horizon-aware vol scaling via a variance ratio. Naive √t scaling assumes iid
 * returns; real crypto minute returns are autocorrelated, so 1-min vol scaled by
 * √t systematically mis-states multi-hour vol (audit §7: "the 1-min→hourly
 * scaling understates the 14h vol"). We measure the k-bar variance ratio
 *   VR = Var(r_k) / (k · Var(r_1))   (overlapping k-bar returns)
 * and turn it into a scaling exponent H = ½ + ln(VR)/(2·ln k), so total vol over
 * n bars is σ_bar · n^H instead of σ_bar · n^½. H is clamped to [minH, maxH]
 * (default [0.35, 0.7]) because the VR on a few hundred bars is noisy and an
 * unclamped exponent extrapolated to 14h can be silly. VR needs ≥ 4·k returns;
 * with fewer we return H = 0.5 (honest fallback to iid, never a guess).
 */
export function estimateHorizonSigma(
  closes: number[],
  opts?: { aggBars?: number; minH?: number; maxH?: number },
): HorizonSigmaEstimate | null {
  const k = opts?.aggBars ?? 15;
  const minH = opts?.minH ?? 0.35;
  const maxH = opts?.maxH ?? 0.7;
  if (!(k >= 2) || !(minH <= maxH)) return null;
  const rets = logReturns(closes.filter((c) => c > 0));
  if (rets.length < 10) return null;

  const m1 = rets.reduce((s, x) => s + x, 0) / rets.length;
  const var1 = rets.reduce((s, x) => s + (x - m1) ** 2, 0) / (rets.length - 1);
  const sigmaPerBar = Math.sqrt(var1);
  if (!(var1 > 0)) return { sigmaPerBar: 0, varianceRatio: 1, hurst: 0.5, aggBars: k };

  if (rets.length < 4 * k) return { sigmaPerBar, varianceRatio: 1, hurst: 0.5, aggBars: k };

  // overlapping k-bar returns (rolling sums of log-returns)
  const kRets: number[] = [];
  let roll = 0;
  for (let i = 0; i < rets.length; i++) {
    roll += rets[i]!;
    if (i >= k) roll -= rets[i - k]!;
    if (i >= k - 1) kRets.push(roll);
  }
  const mk = kRets.reduce((s, x) => s + x, 0) / kRets.length;
  const vark = kRets.reduce((s, x) => s + (x - mk) ** 2, 0) / (kRets.length - 1);
  const vr = vark / (k * var1);
  const hRaw = 0.5 + Math.log(vr) / (2 * Math.log(k));
  const hurst = Math.min(maxH, Math.max(minH, hRaw));
  return { sigmaPerBar, varianceRatio: vr, hurst, aggBars: k };
}

/**
 * Full helper for the common case: you have recent 1-minute CEX closes and a
 * market expiring `expiryMs` from `nowMs`. Estimates σ from the last `volBars`
 * log-returns, scales it to the time-to-expiry horizon, and prices the digital.
 * Returns { pFair, tauHours, sigmaPerHour, … } or null if inputs are unusable.
 *
 * Two OPT-IN upgrades (both default OFF → bit-identical to the original model):
 *   momentum   — shrunken EWMA drift (estimateDriftPerBar). The drift's total
 *                contribution is capped at `capSigmaMult`·σ_total (default 1) so
 *                a trend can tilt the fair value but never dominate diffusion.
 *   horizonVol — variance-ratio scaling (estimateHorizonSigma): total vol over
 *                the n minutes to expiry is σ_min·n^H instead of σ_min·√n. The
 *                returned sigmaPerHour is the EFFECTIVE per-√hour vol at this
 *                horizon (σ_total/√τ), so callers see exactly what was priced.
 *
 * NOTE: σ is estimated here with a tiny inline sample-std rather than importing
 * realizedVol so this stays dependency-free for the paper loop; the math is the
 * same (sample std of consecutive log-returns). The backtest path should prefer
 * candle/indicators.realizedVol on warehouse bars.
 */
export function fairValueFromMinuteCloses(args: {
  spot: number;
  strike: number;
  nowMs: number;
  expiryMs: number;
  minuteCloses: number[]; // most-recent last
  volBars?: number; // default 30
  mu?: number; // explicit drift per hour; ignored when momentum is enabled
  momentum?: boolean | { halfLifeBars?: number; capSigmaMult?: number };
  horizonVol?: boolean | { aggBars?: number; minH?: number; maxH?: number };
}): { pFair: number; tauHours: number; sigmaPerHour: number; muPerHour: number; hurst: number } | null {
  const volBars = args.volBars ?? 30;
  const remMs = args.expiryMs - args.nowMs;
  if (!(args.spot > 0) || !(args.strike > 0) || !Number.isFinite(remMs) || remMs <= 0) return null;
  const closes = args.minuteCloses.filter((c) => c > 0);
  if (closes.length < volBars + 1) return null;

  const window = closes.slice(-(volBars + 1));
  const rets = logReturns(window);
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varr = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  const sigmaPerMinute = Math.sqrt(varr);

  const tauHours = remMs / 3_600_000;
  const nBars = remMs / 60_000; // minutes to expiry

  // ── σ: naive √t, or variance-ratio horizon scaling ──
  let hurst = 0.5;
  let sigmaTotal = sigmaPerMinute * Math.sqrt(nBars); // total vol over the horizon
  if (args.horizonVol) {
    const hOpts = args.horizonVol === true ? undefined : args.horizonVol;
    const hs = estimateHorizonSigma(closes, hOpts); // full buffer, not just volBars — VR needs length
    if (hs && hs.sigmaPerBar > 0) {
      hurst = hs.hurst;
      sigmaTotal = sigmaPerMinute * Math.pow(nBars, hurst);
    }
  }
  const sigmaPerHour = tauHours > 0 ? sigmaTotal / Math.sqrt(tauHours) : NaN;

  // ── μ: explicit, or shrunken-EWMA momentum (capped vs σ_total) ──
  let muPerHour = args.mu ?? 0;
  if (args.momentum) {
    const mOpts = args.momentum === true ? {} : args.momentum;
    const capMult = mOpts.capSigmaMult ?? 1;
    const de = estimateDriftPerBar(closes, { halfLifeBars: mOpts.halfLifeBars });
    if (de) {
      let driftTotal = de.muShrunkPerBar * nBars; // total log-drift to expiry
      const cap = capMult * sigmaTotal;
      if (Number.isFinite(cap)) driftTotal = Math.min(cap, Math.max(-cap, driftTotal));
      muPerHour = tauHours > 0 ? driftTotal / tauHours : 0;
    }
  }

  const pFair = priceAboveStrike({ spot: args.spot, strike: args.strike, tau: tauHours, sigma: sigmaPerHour, mu: muPerHour });
  if (!Number.isFinite(pFair)) return null;
  return { pFair, tauHours, sigmaPerHour, muPerHour, hurst };
}
