/**
 * Quant formulas for prediction-market sizing + edge calculation.
 *
 * Pure functions. No DB, no HTTP, no side effects. Used by:
 *   - oracle-llm and any future LLM evaluator (compute EV from the model's pTrue)
 *   - the backtester for sizing
 *   - a future /tools/calculator page so the operator can sanity-check by hand
 *
 * Math correctness over branding: these are the standard EV, Kelly, Bayes
 * formulations from any decent probability textbook — same math behind every
 * legitimate prediction-market strategy. The article we ingested presents them
 * with marketing flair; the formulas themselves are textbook.
 */

// ────────────────────────────────────────────────────────── Expected Value

export type EVInput = {
  /** Our estimate of the true probability the YES outcome occurs (0..1). */
  pTrue: number;
  /** The current market price of the YES outcome (0..1) = market's implied probability. */
  pMarket: number;
  /** Optional bet size in USD — when present, returns absolute USD EV instead of per-dollar. */
  stakeUsd?: number;
};

export type EVResult = {
  /** Expected value per $1 staked. Positive = edge with us. */
  evPerDollar: number;
  /** Absolute USD EV when stakeUsd was provided; otherwise null. */
  evUsd: number | null;
  /** Our edge over the market in probability terms (pTrue - pMarket). */
  edgeProb: number;
  /** Recommendation per the article's heuristic. */
  recommendation: "STRONG_EDGE" | "EDGE" | "SKIP" | "FADE";
};

/**
 * EV for a single binary bet. The buyer of YES wins (1 - pMarket) per $1
 * when YES occurs, loses pMarket per $1 when YES doesn't occur. Expected
 * value over the buyer's true belief pTrue:
 *
 *   EV = pTrue × (1 - pMarket) − (1 - pTrue) × pMarket
 *
 * Positive → buy YES has positive expected return at this market price.
 * Negative → buy NO has positive expected return (its EV is the mirror).
 *
 * The article's "SKIP unless EV >= 5%" heuristic is what we surface in
 * `recommendation`, with a tighter "STRONG_EDGE" tier at 10%+.
 */
export function expectedValue(input: EVInput): EVResult {
  const pT = clamp01(input.pTrue);
  const pM = clamp01(input.pMarket);
  const evPerDollar = pT * (1 - pM) - (1 - pT) * pM;
  const evUsd = input.stakeUsd != null ? evPerDollar * input.stakeUsd : null;
  const edgeProb = pT - pM;
  let recommendation: EVResult["recommendation"] = "SKIP";
  if (evPerDollar >= 0.10) recommendation = "STRONG_EDGE";
  else if (evPerDollar >= 0.05) recommendation = "EDGE";
  else if (evPerDollar <= -0.05) recommendation = "FADE"; // mirror: buy NO instead
  return { evPerDollar, evUsd, edgeProb, recommendation };
}

// ────────────────────────────────────────────────────────── Kelly Criterion

export type KellyInput = {
  /** Our estimate of true probability (0..1). */
  pTrue: number;
  /** Current market price of the YES outcome (0..1). */
  pMarket: number;
  /** Bankroll in USD. */
  bankrollUsd: number;
  /** Kelly fraction multiplier. Default 0.25 (Quarter Kelly — the article's
   *  recommendation, also industry standard for emotional + variance reasons). */
  fraction?: number;
  /** Hard cap as a fraction of bankroll (default 0.20). Kelly can recommend
   *  insane sizes when pMarket is near 0 or 1; this prevents the math from
   *  blowing up. */
  maxFraction?: number;
};

export type KellyResult = {
  /** Full Kelly fraction (uncapped, unscaled). */
  fullKellyFraction: number;
  /** Scaled fraction = fullKellyFraction × fraction, clamped to [0, maxFraction]. */
  recommendedFraction: number;
  /** Bet size in USD. Zero when we have no edge (Kelly recommends skipping). */
  betUsd: number;
  /** "BUY_YES" | "BUY_NO" | "SKIP" — direction at the market price. */
  side: "BUY_YES" | "BUY_NO" | "SKIP";
};

/**
 * Kelly sizing for a binary bet.
 *
 *   payoff_odds b = (1 - pMarket) / pMarket    // received per $1 at the market price
 *   full Kelly f*  = (b × pTrue − (1 − pTrue)) / b
 *                  = pTrue − (1 − pTrue) / b
 *
 * When pTrue < pMarket the formula goes negative → bet the other side. We
 * detect that and recommend BUY_NO, swapping p and b. When the math says
 * "0" or negative on both sides, we recommend SKIP.
 *
 * Quarter Kelly is the default fraction. Full Kelly is mathematically optimal
 * but emotionally + variance-wise destructive — 50 years of trading experience
 * confirms it. The maxFraction clamp prevents Kelly's near-vertical asymptote
 * at extreme pMarket from sizing absurd bets.
 */
export function kellyFraction(input: KellyInput): KellyResult {
  const pT = clamp01(input.pTrue);
  const pM = clamp01(input.pMarket);
  const fraction = input.fraction ?? 0.25;
  const maxFraction = input.maxFraction ?? 0.20;
  const bankroll = Math.max(0, input.bankrollUsd);

  // Try BUY_YES side first
  const yesFull = kellyForSide(pT, pM);
  if (yesFull > 0) {
    const recommendedFraction = clamp(yesFull * fraction, 0, maxFraction);
    return {
      fullKellyFraction: yesFull,
      recommendedFraction,
      betUsd: bankroll * recommendedFraction,
      side: "BUY_YES",
    };
  }

  // BUY_NO is the mirror — our pTrue on NO = (1 - pTrue), market price of NO = (1 - pMarket)
  const noFull = kellyForSide(1 - pT, 1 - pM);
  if (noFull > 0) {
    const recommendedFraction = clamp(noFull * fraction, 0, maxFraction);
    return {
      fullKellyFraction: noFull,
      recommendedFraction,
      betUsd: bankroll * recommendedFraction,
      side: "BUY_NO",
    };
  }

  return { fullKellyFraction: 0, recommendedFraction: 0, betUsd: 0, side: "SKIP" };
}

function kellyForSide(pTrue: number, pMarket: number): number {
  if (pMarket <= 0 || pMarket >= 1) return 0;
  const b = (1 - pMarket) / pMarket;
  if (b <= 0) return 0;
  // f* = (b*p - q) / b = p - q/b
  const q = 1 - pTrue;
  const f = pTrue - q / b;
  return Number.isFinite(f) ? f : 0;
}

// ────────────────────────────────────────────────────────── Bayesian update

export type BayesInput = {
  /** Prior probability of the hypothesis (0..1). */
  prior: number;
  /** P(E | H) — likelihood of the evidence assuming the hypothesis is true (0..1). */
  likelihoodIfH: number;
  /** P(E) — total probability of the evidence (0..1). MUST NOT be 0. */
  likelihoodOverall: number;
};

export type BayesResult = {
  posterior: number;
  /** Bayes factor = P(E|H) / P(E). >1 strengthens H; <1 weakens it. */
  bayesFactor: number;
};

/**
 * Bayes' rule. Standard form:
 *
 *   P(H | E) = P(E | H) × P(H) / P(E)
 *
 * Example from the article: prior on Fed rate cut = 55%. Inflation data
 * comes in — P(data | rate-cut) = 80%, overall P(data) = 50%. Posterior:
 * (0.80 × 0.55) / 0.50 = 0.88. Belief moved from 55% to 88% — driven by the
 * math, not panic.
 *
 * When `likelihoodOverall` is 0, returns posterior=0 + bayesFactor=Infinity
 * to make the input error obvious (rather than NaN propagating).
 */
export function bayesianUpdate(input: BayesInput): BayesResult {
  const prior = clamp01(input.prior);
  const lH = clamp01(input.likelihoodIfH);
  const lE = clamp01(input.likelihoodOverall);
  if (lE === 0) return { posterior: 0, bayesFactor: Infinity };
  const posterior = clamp01((lH * prior) / lE);
  const bayesFactor = lH / lE;
  return { posterior, bayesFactor };
}

/**
 * Convenience: when you have likelihood-if-H and likelihood-if-not-H instead
 * of marginal P(E), this is the more numerically-stable form:
 *
 *   P(H|E) = P(E|H) × P(H) / [P(E|H) × P(H) + P(E|¬H) × P(¬H)]
 */
export function bayesianUpdateFromLikelihoods(args: {
  prior: number;
  likelihoodIfH: number;
  likelihoodIfNotH: number;
}): BayesResult {
  const prior = clamp01(args.prior);
  const lH = clamp01(args.likelihoodIfH);
  const lN = clamp01(args.likelihoodIfNotH);
  const denom = lH * prior + lN * (1 - prior);
  if (denom === 0) return { posterior: 0, bayesFactor: Infinity };
  const posterior = clamp01((lH * prior) / denom);
  const bayesFactor = denom === 0 ? Infinity : lH / denom;
  return { posterior, bayesFactor };
}

// ────────────────────────────────────────────────────────── helpers

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
