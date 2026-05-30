/**
 * Wallet typology classifier — the "is this wallet copyable" decision layer.
 *
 * Pure function. Consumes:
 *   - fingerprint  (strategy family + cadence + sizing + concentration)
 *   - copyability  (realized PnL, win rate, sample, consistency)
 *   - portfolioValueUsd (current mark-to-market book)
 *
 * Emits a single `primaryBucket` + a `copyabilityClass` + the candidate
 * list with weights + a `resolutionPlan` listing exactly what additional
 * data point would settle each remaining ambiguity.
 *
 * The buckets and their motivation:
 *   hft_bot              → un_copyable        : speed edge, can't follow
 *   conviction_trader    → potentially_copyable: slow markets, real follow-time
 *   market_mover_whale   → un_copyable        : own size moves the price; copy
 *                                              eats their slippage
 *   mid_run_gambler      → needs_verification : MTM book >> realized PnL —
 *                                              small N of unresolved big bets
 *   insider_pattern      → flagged_high_risk  : small N + extreme win rate +
 *                                              large size — overlaps with
 *                                              real edge, may be insider info
 *   retail               → uninteresting      : tiny size, infrequent
 *   unclear              → needs_more_data    : sample too small to classify
 *
 * NOT a substitute for human judgement. The insider_pattern bucket
 * intentionally overlaps with conviction_trader because we can't
 * distinguish them without per-trade analysis of market category +
 * information availability. The resolutionPlan tells you exactly what
 * additional analysis would resolve it.
 */
import type { WalletFingerprint } from "./fingerprint";
import type { CopyabilityReport } from "./copyability";

export type WalletTypologyBucket =
  | "hft_bot"
  | "conviction_trader"
  | "market_mover_whale"
  | "mid_run_gambler"
  | "insider_pattern"
  | "retail"
  | "unclear";

export type CopyabilityClass =
  | "un_copyable"
  | "potentially_copyable"
  | "needs_verification"
  | "flagged_high_risk"
  | "uninteresting"
  | "needs_more_data";

export type WalletTypologyFeatures = {
  tradesPerDay: number;
  /** Distinct markets (conditionIds) touched per day. Real HFT touches MANY
   *  markets; a position trader scraping orderbook touches few. */
  distinctMarketsPerDay: number;
  /** Avg fills per distinct market — high (>20) = orderbook-scraping a few
   *  large positions, NOT HFT. */
  fillsPerMarket: number;
  medianTradeUsd: number;
  avgTradeUsd: number;
  portfolioValueUsd: number | null;
  sampleSize: number;
  /** Total closed + open positions — closer to UI "predictions" count than raw fills. */
  positionsCount: number;
  windowDays: number | null;
  winRate: number | null;
  realizedPnlUsd: number;
  /** Mark-to-market book over abs(realized PnL). High = mid-run gambler signature. */
  mtmToRealizedRatio: number | null;
  /** % of trades sized > $1k. Proxy for "trade moves market". */
  largeTradeShare: number;
  /** Top single category share — high concentration = focused / single thesis. */
  concentrationPct: number;
  /** Crypto-market share — when high + fast cadence = HFT-bot signature. */
  cryptoPct: number;
};

export type WalletTypology = {
  wallet: string;
  primaryBucket: WalletTypologyBucket;
  copyabilityClass: CopyabilityClass;
  confidence: number;
  candidates: Array<{ bucket: WalletTypologyBucket; weight: number; reason: string }>;
  features: WalletTypologyFeatures;
  caveats: string[];
  resolutionPlan: string[];
};

export type WalletTypologyInput = {
  wallet: string;
  fingerprint: WalletFingerprint;
  copyability: CopyabilityReport;
  portfolioValueUsd?: number | null;
};

const COPYABILITY_BY_BUCKET: Record<WalletTypologyBucket, CopyabilityClass> = {
  hft_bot: "un_copyable",
  conviction_trader: "potentially_copyable",
  market_mover_whale: "un_copyable",
  mid_run_gambler: "needs_verification",
  insider_pattern: "flagged_high_risk",
  retail: "uninteresting",
  unclear: "needs_more_data",
};

function extractFeatures(input: WalletTypologyInput): WalletTypologyFeatures {
  const { fingerprint: fp, copyability: cp, portfolioValueUsd } = input;
  const windowDays = fp.windowDays;
  const tradesPerDay = windowDays && windowDays > 0 ? fp.sampledTrades / windowDays : 0;
  const distinctMarketsPerDay =
    windowDays && windowDays > 0 ? fp.distinctConditionIds / windowDays : 0;
  const fillsPerMarket =
    fp.distinctConditionIds > 0 ? fp.sampledTrades / fp.distinctConditionIds : 0;
  const realizedPnl = cp.totalPnlUsd ?? 0;
  const mtmToRealizedRatio =
    portfolioValueUsd != null && Math.abs(realizedPnl) > 0
      ? portfolioValueUsd / Math.abs(realizedPnl)
      : portfolioValueUsd != null && portfolioValueUsd > 0
      ? Infinity
      : null;
  const buckets = fp.sizeBuckets;
  const totalSized = buckets.lt10 + buckets.lt100 + buckets.lt1000 + buckets.gt1000;
  const largeTradeShare = totalSized > 0 ? buckets.gt1000 / totalSized : 0;
  const positionsCount = fp.sampledClosedPositions + fp.sampledOpenPositions;

  return {
    tradesPerDay,
    distinctMarketsPerDay,
    fillsPerMarket,
    medianTradeUsd: fp.medianTradeUsd,
    avgTradeUsd: fp.avgTradeUsd,
    portfolioValueUsd: portfolioValueUsd ?? null,
    sampleSize: fp.sampledTrades,
    positionsCount,
    windowDays,
    winRate: cp.winRate,
    realizedPnlUsd: realizedPnl,
    mtmToRealizedRatio,
    largeTradeShare,
    concentrationPct: fp.concentrationPct,
    cryptoPct: fp.cryptoPct,
  };
}

type Candidate = { bucket: WalletTypologyBucket; weight: number; reason: string };

export function classifyWalletTypology(input: WalletTypologyInput): WalletTypology {
  const features = extractFeatures(input);
  const candidates: Candidate[] = [];
  const caveats: string[] = [];
  const resolutionPlan: string[] = [];

  // --- Position-size signal -------------------------------------------
  // Average open book per position — distinguishes position-trader (carries
  // large open exposures) from HFT bot (flat at end of day, book ≈ 0).
  const avgPositionBookUsd =
    features.positionsCount > 0 && (features.portfolioValueUsd ?? 0) > 0
      ? (features.portfolioValueUsd ?? 0) / features.positionsCount
      : 0;
  const looksLikePositionBuilder =
    (features.portfolioValueUsd ?? 0) >= 50_000 &&
    features.realizedPnlUsd >= 10_000 &&
    avgPositionBookUsd >= 1_000;

  // --- HFT bot --------------------------------------------------------
  // High cadence requires BOTH many fills AND many distinct markets.
  // Guards:
  //  - looksLikeScraper: 1000 fills on 5 markets = orderbook scraping
  //  - looksLikePositionBuilder: wallet carries >$50k book AND realized >$10k
  //    AND avg position book >$1k → high cadence is position-building, not HFT
  const looksLikeScraper = features.fillsPerMarket >= 15 && features.distinctMarketsPerDay < 10;
  if (
    features.tradesPerDay >= 20 &&
    features.distinctMarketsPerDay >= 10 &&
    features.medianTradeUsd < 200 &&
    !looksLikeScraper &&
    !looksLikePositionBuilder
  ) {
    candidates.push({
      bucket: "hft_bot",
      weight: 0.95,
      reason: `${features.tradesPerDay.toFixed(0)} trades/day across ${features.distinctMarketsPerDay.toFixed(0)} markets/day at median $${features.medianTradeUsd.toFixed(0)} — speed-driven`,
    });
  } else if (
    features.tradesPerDay >= 50 &&
    features.distinctMarketsPerDay >= 20 &&
    !looksLikeScraper &&
    !looksLikePositionBuilder
  ) {
    candidates.push({
      bucket: "hft_bot",
      weight: 0.85,
      reason: `${features.tradesPerDay.toFixed(0)} trades/day across ${features.distinctMarketsPerDay.toFixed(0)} markets/day — too fast for human, likely bot`,
    });
  }
  if (looksLikeScraper) {
    caveats.push(
      `${features.fillsPerMarket.toFixed(0)} fills per market — orderbook scraping on ${features.distinctMarketsPerDay.toFixed(1)} markets/day; raw "trades/day" is misleading`,
    );
  }
  if (looksLikePositionBuilder) {
    caveats.push(
      `large open book $${(features.portfolioValueUsd ?? 0).toFixed(0)} + realized $${features.realizedPnlUsd.toFixed(0)} on ${features.positionsCount} positions (avg book $${avgPositionBookUsd.toFixed(0)}/position) — high fill rate is position-building, not HFT`,
    );
  }

  // --- Conviction trader (book-driven path) ---------------------------
  // Fires when the wallet carries a large open book AND has realized
  // significant PnL — regardless of fill cadence. This path catches the
  // 0x6e1d5040 pattern (1200 fills/day but $2M realized + $1M book = position
  // builder, not HFT).
  if (looksLikePositionBuilder) {
    candidates.push({
      bucket: avgPositionBookUsd >= 5_000 ? "market_mover_whale" : "conviction_trader",
      weight: 0.9,
      reason: `book $${(features.portfolioValueUsd ?? 0).toFixed(0)} + realized $${features.realizedPnlUsd.toFixed(0)} on ${features.positionsCount} positions (avg $${avgPositionBookUsd.toFixed(0)}/position) — proven banker`,
    });
    if (avgPositionBookUsd >= 5_000) {
      resolutionPlan.push(
        "Avg position book ≥$5k — likely market-moving on entry. Compute slippage signature on each entry price vs prior orderbook mid to confirm.",
      );
    }
  }

  // --- Retail ---------------------------------------------------------
  // Low cadence + small trades + no positive PnL signal. Uninteresting.
  if (
    features.tradesPerDay < 1 &&
    features.avgTradeUsd < 100 &&
    (features.portfolioValueUsd ?? 0) < 1_000
  ) {
    candidates.push({
      bucket: "retail",
      weight: 0.7,
      reason: `low cadence (${features.tradesPerDay.toFixed(2)}/day) and small size ($${features.avgTradeUsd.toFixed(0)} avg)`,
    });
  }

  // --- Market-mover whale --------------------------------------------
  // Huge avg trade + most trades are large. Their own size moves price.
  if (features.avgTradeUsd >= 5_000 && features.largeTradeShare >= 0.5) {
    candidates.push({
      bucket: "market_mover_whale",
      weight: 0.8,
      reason: `avg trade $${features.avgTradeUsd.toFixed(0)} with ${(features.largeTradeShare * 100).toFixed(0)}% of trades ≥$1k — likely moves market on own fill`,
    });
    resolutionPlan.push(
      "Compare each entry price to prior 1-min reference price to compute slippage signature — large adverse moves on own fill confirms market-mover.",
    );
  }

  // --- Mid-run gambler ------------------------------------------------
  // MTM book dwarfs realized PnL → big unresolved bets, small N.
  if (
    features.mtmToRealizedRatio != null &&
    features.mtmToRealizedRatio >= 5 &&
    features.sampleSize <= 500
  ) {
    candidates.push({
      bucket: "mid_run_gambler",
      weight: 0.75,
      reason: `MTM book $${(features.portfolioValueUsd ?? 0).toFixed(0)} is ${features.mtmToRealizedRatio.toFixed(1)}× abs realized PnL $${Math.abs(features.realizedPnlUsd).toFixed(0)} — large unresolved bets`,
    });
    resolutionPlan.push(
      "Wait for current open positions to resolve, then re-run typology against settled PnL only.",
    );
  }
  if (
    features.mtmToRealizedRatio === Infinity &&
    (features.portfolioValueUsd ?? 0) > 50_000
  ) {
    candidates.push({
      bucket: "mid_run_gambler",
      weight: 0.7,
      reason: `MTM book $${(features.portfolioValueUsd ?? 0).toFixed(0)} with zero realized PnL observed — entirely unresolved bets`,
    });
  }

  // --- Insider pattern -----------------------------------------------
  // Small N + extreme win rate + large size. Overlaps with conviction
  // trader; flagged separately because (a) insider trading on prediction
  // markets has precedent and (b) even if not, the edge isn't replicable.
  if (
    features.winRate != null &&
    features.winRate >= 0.75 &&
    features.sampleSize <= 200 &&
    features.realizedPnlUsd >= 10_000 &&
    features.avgTradeUsd >= 1_000
  ) {
    candidates.push({
      bucket: "insider_pattern",
      weight: 0.65,
      reason: `${(features.winRate * 100).toFixed(0)}% win rate on small N=${features.sampleSize} with avg $${features.avgTradeUsd.toFixed(0)} — overlaps with insider signature`,
    });
    resolutionPlan.push(
      "Inspect market categories — concentration on court-case / undisclosed-event markets is a stronger insider signal than diversified slow-resolving markets.",
    );
    caveats.push(
      "insider_pattern is not an accusation — it's a signature class that overlaps with genuine edge. Don't copy either way without resolution.",
    );
  }

  // --- Conviction trader ---------------------------------------------
  // Low cadence + large size + observed positive PnL on enough closes.
  if (
    features.tradesPerDay <= 10 &&
    features.tradesPerDay >= 0.3 &&
    features.avgTradeUsd >= 500 &&
    features.winRate != null &&
    features.winRate >= 0.55 &&
    features.realizedPnlUsd > 0 &&
    features.sampleSize >= 50
  ) {
    candidates.push({
      bucket: "conviction_trader",
      weight: 0.85,
      reason: `${features.tradesPerDay.toFixed(1)} trades/day, avg $${features.avgTradeUsd.toFixed(0)}, win ${(features.winRate * 100).toFixed(0)}%, realized $${features.realizedPnlUsd.toFixed(0)} on N=${features.sampleSize}`,
    });
  } else if (
    features.tradesPerDay <= 10 &&
    features.tradesPerDay >= 0.3 &&
    features.avgTradeUsd >= 500 &&
    features.sampleSize < 50
  ) {
    candidates.push({
      bucket: "conviction_trader",
      weight: 0.4,
      reason: `low cadence + large size but only N=${features.sampleSize} closed positions — under threshold for confident classification`,
    });
    resolutionPlan.push(
      "Need ≥50 closed positions for confident conviction_trader bucket — re-classify after more bets resolve.",
    );
  }

  // --- Fallback -------------------------------------------------------
  if (candidates.length === 0) {
    candidates.push({
      bucket: "unclear",
      weight: 0.3,
      reason: `mixed signals — cadence ${features.tradesPerDay.toFixed(2)}/day, avg $${features.avgTradeUsd.toFixed(0)}, sample N=${features.sampleSize}`,
    });
    resolutionPlan.push(
      "Insufficient signal to classify; gather more trade history or wait for closed positions.",
    );
  }

  // --- Sample-size + window caveats ----------------------------------
  if (features.sampleSize < 30) {
    caveats.push(`small sample N=${features.sampleSize} — typology is low confidence`);
  }
  if (features.windowDays != null && features.windowDays < 14) {
    caveats.push(`short observation window ${features.windowDays.toFixed(1)}d — recency bias possible`);
  }
  if (features.portfolioValueUsd == null) {
    caveats.push("portfolio value unknown — mtmToRealizedRatio not computable; mid_run_gambler check is partial");
    resolutionPlan.push("Pull poly.userValue(wallet) to enable the mid-run gambler check.");
  }
  if (input.copyability.observedClosed < 5) {
    caveats.push("fewer than 5 closed positions observed — winRate + PnL signals are unreliable");
    resolutionPlan.push(
      "Re-run after ≥5 closed positions are observed; copyability score remains 0 until then.",
    );
  }

  // --- Pick winner ----------------------------------------------------
  candidates.sort((a, b) => b.weight - a.weight);
  const primary = candidates[0];
  return {
    wallet: input.wallet,
    primaryBucket: primary.bucket,
    copyabilityClass: COPYABILITY_BY_BUCKET[primary.bucket],
    confidence: primary.weight,
    candidates,
    features,
    caveats,
    resolutionPlan,
  };
}
