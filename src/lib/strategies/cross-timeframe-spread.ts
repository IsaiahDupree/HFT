/**
 * Cross-timeframe spread detector — catch arbitrage between Polymarket
 * markets covering the same underlying crypto direction at different
 * durations (e.g. BTC 5min Up/Down vs BTC 15min Up/Down).
 *
 * The 5m market typically reprices faster than the 15m. When their spread
 * deviates by ≥3 standard deviations from the rolling mean, one side is
 * mispriced relative to the other. Buy the cheap side, exit when the
 * spread reverts.
 *
 * Pure function. Caller supplies:
 *   - shortQuote: current mid-price of the shorter-duration market
 *   - longQuote: current mid-price of the longer-duration market
 *   - rollingSpreads: recent SpreadObservation[] for normalization
 *   - opts: thresholds + staleness limits
 *
 * Returns CrossTimeframeOpportunity when |z-score| ≥ minZScore, else null.
 *
 * The caller maintains the rolling-spread buffer; this module only computes
 * the signal from a snapshot. The scanner script wraps this in periodic
 * polling + buffer maintenance.
 *
 * Math (verbatim from Daniro 2026-05-25 article):
 *   z = (spread_now - rolling_mean) / rolling_stdev
 *
 * Safety properties:
 *   - Requires minSamples (default 30) to compute meaningful stdev
 *   - Staleness check: snapshot timestamps must be within maxStalenessSec
 *   - Clamps |z| to 10 to avoid div-by-near-zero blowups
 */

export type TimeframeQuote = {
  conditionId: string;
  marketTitle?: string;
  /** Market duration in minutes (e.g. 5, 15, 60, 240). */
  durationMinutes: number;
  /** Current mid-price (0..1). */
  midPrice: number;
  /** ISO timestamp of the quote. */
  ts: string;
};

export type SpreadObservation = {
  spread: number;
  ts: string;
};

export type CrossTimeframeOpportunity = {
  shortConditionId: string;
  longConditionId: string;
  shortDurationMin: number;
  longDurationMin: number;
  shortPrice: number;
  longPrice: number;
  spread: number;
  rollingMean: number;
  rollingStdev: number;
  zScore: number;
  /** Whichever market is trading too low relative to the spread mean. */
  cheapSide: "short" | "long";
  /** |spread - rollingMean| in price points — what reversion would pay. */
  edge: number;
  reason: string;
  /** For consumer code that wants a generic "marketKey". */
  marketKey: string;
};

export type CrossTimeframeOptions = {
  /** Minimum |z-score| to fire a signal. Default 3.0. */
  minZScore?: number;
  /** Minimum number of rolling samples before signal can fire. Default 30. */
  minSamples?: number;
  /** Maximum seconds of staleness between short and long quotes. Default 60. */
  maxStalenessSec?: number;
  /** Override "now" for testability. */
  nowMs?: number;
};

function rollingStats(samples: number[]): { mean: number; stdev: number } {
  if (samples.length === 0) return { mean: 0, stdev: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  if (samples.length < 2) return { mean, stdev: 0 };
  const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / (samples.length - 1);
  return { mean, stdev: Math.sqrt(variance) };
}

const Z_CLAMP = 10;

export function detectCrossTimeframeSpread(
  shortQuote: TimeframeQuote,
  longQuote: TimeframeQuote,
  rollingSpreads: SpreadObservation[],
  opts: CrossTimeframeOptions = {},
): CrossTimeframeOpportunity | null {
  const minZ = opts.minZScore ?? 3.0;
  const minSamples = opts.minSamples ?? 30;
  const maxStalenessSec = opts.maxStalenessSec ?? 60;
  const nowMs = opts.nowMs ?? Date.now();

  if (rollingSpreads.length < minSamples) return null;

  // Staleness check — both quotes must be recent AND close to each other.
  const shortAgeSec = (nowMs - Date.parse(shortQuote.ts)) / 1000;
  const longAgeSec = (nowMs - Date.parse(longQuote.ts)) / 1000;
  if (Math.abs(shortAgeSec - longAgeSec) > maxStalenessSec) return null;
  if (shortAgeSec > maxStalenessSec * 2 || longAgeSec > maxStalenessSec * 2) return null;

  // Price sanity
  if (shortQuote.midPrice <= 0 || shortQuote.midPrice >= 1) return null;
  if (longQuote.midPrice <= 0 || longQuote.midPrice >= 1) return null;

  const currentSpread = shortQuote.midPrice - longQuote.midPrice;
  const samples = rollingSpreads.map((s) => s.spread);
  const { mean, stdev } = rollingStats(samples);
  if (stdev <= 1e-9) return null;

  const rawZ = (currentSpread - mean) / stdev;
  const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, rawZ));
  if (Math.abs(z) < minZ) return null;

  // Positive z: short_price > long_price by more than usual → short is expensive,
  // long is cheap → buy long. Negative z: opposite.
  const cheapSide: "short" | "long" = z > 0 ? "long" : "short";
  const edge = Math.abs(currentSpread - mean);

  return {
    shortConditionId: shortQuote.conditionId,
    longConditionId: longQuote.conditionId,
    shortDurationMin: shortQuote.durationMinutes,
    longDurationMin: longQuote.durationMinutes,
    shortPrice: shortQuote.midPrice,
    longPrice: longQuote.midPrice,
    spread: currentSpread,
    rollingMean: mean,
    rollingStdev: stdev,
    zScore: z,
    cheapSide,
    edge,
    reason: `${shortQuote.durationMinutes}m@${shortQuote.midPrice.toFixed(3)} vs ${longQuote.durationMinutes}m@${longQuote.midPrice.toFixed(3)}, spread ${currentSpread.toFixed(4)} (z=${z.toFixed(2)}); cheap side = ${cheapSide}`,
    marketKey: cheapSide === "long" ? longQuote.conditionId : shortQuote.conditionId,
  };
}
