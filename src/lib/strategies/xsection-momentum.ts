/**
 * Cross-sectional momentum — the one edge that survived the overfit gauntlet
 * (backtest-xsection: long-lookback, market-neutral, OOS-robust ann.Sharpe ~0.68).
 * Crypto INVERTS Simons' equity reversal: it's a cross-sectional MOMENTUM market.
 *
 * Pure + deterministic, no DB/IO — so it's unit-testable and reusable by both the
 * backtest and a live paper/arena deployment. Market-neutral by construction
 * (Σweights ≈ 0, gross Σ|weight| = 1). Trend-gated: only deploy when the market
 * (BTC efficiency ratio) is trending; flat in chop.
 */

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Chronological daily closes for one coin (oldest → newest). */
export type CoinCloses = { coin: string; closes: number[] };

/**
 * Market regime gate: the Mandelbrot efficiency ratio of the last `window` BTC
 * closes (|net move| / Σ|step|, scale-invariant). Trending ⇒ deploy momentum.
 */
export function isMarketTrending(btcCloses: number[], window = 20, threshold = 0.30): boolean {
  if (btcCloses.length < window + 1) return false;
  const a = btcCloses[btcCloses.length - 1], b = btcCloses[btcCloses.length - 1 - window];
  let path = 0;
  for (let k = btcCloses.length - window; k < btcCloses.length; k++) path += Math.abs(btcCloses[k] - btcCloses[k - 1]);
  return path > 0 && Math.abs(a - b) / path >= threshold;
}

/**
 * Market-neutral cross-sectional momentum weights. Ranks the eligible coins by
 * their `lookback`-day return, z-scores the cross-section, and weights ∝ z (long
 * recent winners, short recent losers — momentum). Dollar-neutral (demeaned) and
 * gross-normalized to Σ|w| = 1. Returns {} if fewer than `minCoins` are eligible.
 *
 * Uses ONLY closes already observed (the last `lookback+1` per coin) — no lookahead.
 */
export function crossSectionalMomentumWeights(
  bars: CoinCloses[],
  opts: { lookback?: number; minCoins?: number; reversal?: boolean } = {},
): Record<string, number> {
  const L = opts.lookback ?? 20;
  const minCoins = opts.minCoins ?? 4;
  const sign = opts.reversal ? -1 : 1; // momentum by default; reversal flips it (loses in crypto)
  const elig = bars.filter((b) => b.closes.length >= L + 1 && b.closes[b.closes.length - 1] > 0 && b.closes[b.closes.length - 1 - L] > 0);
  if (elig.length < minCoins) return {};
  const rets = elig.map((b) => b.closes[b.closes.length - 1] / b.closes[b.closes.length - 1 - L] - 1);
  const m = mean(rets), sd = std(rets);
  if (sd <= 0) return {};
  let w = rets.map((r) => sign * (r - m) / sd);  // momentum: long high-return
  const wMean = mean(w); w = w.map((x) => x - wMean);            // dollar-neutral
  const gross = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const out: Record<string, number> = {};
  elig.forEach((b, i) => { out[b.coin] = w[i] / gross; });        // gross Σ|w| = 1
  return out;
}

/**
 * The deployable signal: the OOS-robust config (lookback 20, trend-gated). Returns
 * the market-neutral target basket, or {} (go flat) when the market isn't trending.
 */
export function momentumSignal(
  bars: CoinCloses[],
  btcCloses: number[],
  opts: { lookback?: number; trendWindow?: number; trendThreshold?: number; minCoins?: number } = {},
): { trending: boolean; weights: Record<string, number> } {
  const trending = isMarketTrending(btcCloses, opts.trendWindow ?? 20, opts.trendThreshold ?? 0.30);
  if (!trending) return { trending, weights: {} };
  return { trending, weights: crossSectionalMomentumWeights(bars, { lookback: opts.lookback ?? 20, minCoins: opts.minCoins }) };
}
