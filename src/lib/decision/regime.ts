/**
 * Regime classifier — the only NEW gate logic in the gated-decision-system
 * Phase 2. Looks at the recent price ticks supplied via DecisionContext.snapshot
 * and labels the market as trending / chop / breakout / news_shock / low_vol /
 * unknown.
 *
 * Pure / deterministic. The pipeline calls this once per proposal; the regime
 * gate then scores the result against the strategy's declared `regimes`
 * preference list.
 *
 * Approach (v1 — kept simple intentionally):
 *
 *   efficiency = |priceNow − priceOpen| / Σ|tick-to-tick step|    (Mandelbrot ratio)
 *   sigma_pct  = stdev(per-tick log returns) × sqrt(ticks)         (rough vol proxy)
 *
 *   if ticks < minTicks                                → unknown
 *   else if sigma_pct >= newsShockSigma                → news_shock
 *   else if efficiency >= trendingEff AND sigma_pct >= breakoutSigma
 *                                                      → breakout
 *   else if efficiency >= trendingEff                  → trending
 *   else if efficiency <= chopEff                      → chop
 *   else if sigma_pct <= lowVolSigma                   → low_vol
 *   else                                               → unknown
 *
 * The "unknown" bucket exists because we don't want to force a regime label
 * on a market with ambiguous signal — the gate treats unknown as "any" by
 * default (operator can override).
 *
 * v2 work item: percentile-rank sigma_pct against a trailing 24h reference
 * so news_shock / low_vol are calibrated to the asset's recent baseline
 * rather than absolute thresholds. v1 uses fixed thresholds chosen to be
 * sensible for typical 5m crypto.
 *
 * See PRD: docs/prd/gated-decision-system-2026-05-27.md §5.3
 */

export type Regime =
  | "trending"
  | "chop"
  | "breakout"
  | "news_shock"
  | "low_vol"
  | "unknown";

export type RegimeResult = {
  regime: Regime;
  /** 0..1 — how strongly the input matches the chosen regime. */
  confidence: number;
  /** Directional efficiency over the input window. 0..1. */
  efficiency: number;
  /** Estimated standard deviation per tick (log-return units). */
  sigma_per_tick: number;
  /** Convenience: total log-vol over the window. */
  sigma_total: number;
  /** Reason string for the GateResult.details payload + UI tooltips. */
  reason: string;
};

export type RegimeOptions = {
  /** Minimum ticks for a confident classification. Default 20. */
  minTicks?: number;
  /** efficiency ≥ this → trending. Default 0.40. */
  trendingEff?: number;
  /** efficiency ≤ this → chop. Default 0.15. */
  chopEff?: number;
  /** sigma_total ≥ this → news_shock (when efficiency low) or breakout (when high). Default 0.01 (1%). */
  newsShockSigma?: number;
  /** sigma_total ≥ this with high efficiency → breakout. Default 0.005 (0.5%). */
  breakoutSigma?: number;
  /** sigma_total ≤ this → low_vol. Default 0.0005 (0.05%). */
  lowVolSigma?: number;
};

const D = {
  minTicks: 20,
  trendingEff: 0.40,
  chopEff: 0.15,
  newsShockSigma: 0.01,
  breakoutSigma: 0.005,
  lowVolSigma: 0.0005,
} as const;

export type Tick = { ts: number; price: number };

export function classifyRegime(
  ticks: readonly Tick[] | undefined | null,
  opts: RegimeOptions = {},
): RegimeResult {
  const minTicks = opts.minTicks ?? D.minTicks;
  const trendingEff = opts.trendingEff ?? D.trendingEff;
  const chopEff = opts.chopEff ?? D.chopEff;
  const newsShockSigma = opts.newsShockSigma ?? D.newsShockSigma;
  const breakoutSigma = opts.breakoutSigma ?? D.breakoutSigma;
  const lowVolSigma = opts.lowVolSigma ?? D.lowVolSigma;

  if (!ticks || ticks.length < minTicks) {
    return {
      regime: "unknown",
      confidence: 0,
      efficiency: 0,
      sigma_per_tick: 0,
      sigma_total: 0,
      reason: `insufficient ticks (${ticks?.length ?? 0} < ${minTicks})`,
    };
  }

  // Sanity-filter ticks: positive finite prices only, monotonic in ts.
  const valid: Tick[] = [];
  for (const t of ticks) {
    if (!Number.isFinite(t.ts) || !Number.isFinite(t.price) || t.price <= 0) continue;
    if (valid.length > 0 && t.ts < valid[valid.length - 1]!.ts) continue;
    valid.push(t);
  }
  if (valid.length < minTicks) {
    return {
      regime: "unknown",
      confidence: 0,
      efficiency: 0,
      sigma_per_tick: 0,
      sigma_total: 0,
      reason: `insufficient valid ticks after filter (${valid.length} < ${minTicks})`,
    };
  }

  const open = valid[0]!.price;
  const close = valid[valid.length - 1]!.price;
  const delta = close - open;

  // Path length
  let pathLength = 0;
  const logReturns: number[] = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1]!.price;
    const curr = valid[i]!.price;
    pathLength += Math.abs(curr - prev);
    logReturns.push(Math.log(curr / prev));
  }
  const efficiency = pathLength <= 0 ? 0 : Math.min(1, Math.abs(delta) / pathLength);

  // Per-tick log-return stdev → sigma_total = sigma_per_tick × sqrt(n-1)
  const meanRet = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, x) => s + (x - meanRet) ** 2, 0) / Math.max(1, logReturns.length - 1);
  const sigma_per_tick = Math.sqrt(variance);
  const sigma_total = sigma_per_tick * Math.sqrt(logReturns.length);

  // Classification — most-severe-first.
  if (sigma_total >= newsShockSigma && efficiency < trendingEff) {
    // High vol with no clear direction → news shock / event-driven panic
    return {
      regime: "news_shock",
      confidence: Math.min(1, sigma_total / (newsShockSigma * 2)),
      efficiency,
      sigma_per_tick,
      sigma_total,
      reason: `news_shock: sigma ${sigma_total.toFixed(4)} ≥ ${newsShockSigma}, low efficiency ${efficiency.toFixed(2)}`,
    };
  }
  if (efficiency >= trendingEff && sigma_total >= breakoutSigma) {
    return {
      regime: "breakout",
      confidence: efficiency,
      efficiency,
      sigma_per_tick,
      sigma_total,
      reason: `breakout: efficiency ${efficiency.toFixed(2)} ≥ ${trendingEff}, sigma ${sigma_total.toFixed(4)} ≥ ${breakoutSigma}`,
    };
  }
  if (efficiency >= trendingEff) {
    return {
      regime: "trending",
      confidence: efficiency,
      efficiency,
      sigma_per_tick,
      sigma_total,
      reason: `trending: efficiency ${efficiency.toFixed(2)} ≥ ${trendingEff}`,
    };
  }
  if (efficiency <= chopEff) {
    return {
      regime: "chop",
      confidence: 1 - efficiency / Math.max(0.001, chopEff),
      efficiency,
      sigma_per_tick,
      sigma_total,
      reason: `chop: efficiency ${efficiency.toFixed(2)} ≤ ${chopEff}`,
    };
  }
  if (sigma_total <= lowVolSigma) {
    return {
      regime: "low_vol",
      confidence: 1 - sigma_total / Math.max(1e-9, lowVolSigma),
      efficiency,
      sigma_per_tick,
      sigma_total,
      reason: `low_vol: sigma ${sigma_total.toFixed(5)} ≤ ${lowVolSigma}`,
    };
  }
  return {
    regime: "unknown",
    confidence: 0,
    efficiency,
    sigma_per_tick,
    sigma_total,
    reason: `ambiguous: efficiency ${efficiency.toFixed(2)} ∈ (${chopEff}, ${trendingEff}) and sigma ${sigma_total.toFixed(4)} mid-range`,
  };
}

/**
 * Match a classified regime against a strategy's declared preferred regimes.
 *   - Strategy declares regimes = ["any"]                → score 1.0 (no preference)
 *   - Strategy includes the actual regime               → score 1.0
 *   - Strategy doesn't include it                        → score 0.4 (partial penalty)
 *   - Regime = "news_shock" + strategy doesn't allow it → score 0.0 (hard avoid)
 *   - Regime = "unknown"                                 → score 0.7 (mild penalty;
 *                                                          can't say either way)
 */
export function regimeFitScore(
  regime: Regime,
  strategyRegimes: readonly string[],
): { score: number; matched: boolean } {
  const norm = (strategyRegimes ?? []).map((r) => r.toLowerCase());
  const includesAny = norm.includes("any") || norm.length === 0;
  const matched = includesAny || norm.includes(regime);

  if (regime === "news_shock" && !norm.includes("news_shock")) {
    return { score: 0, matched: false };
  }
  if (regime === "unknown") {
    return { score: 0.7, matched: false };
  }
  if (matched) return { score: 1.0, matched: true };
  return { score: 0.4, matched: false };
}
