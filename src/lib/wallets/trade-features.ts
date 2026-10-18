/**
 * Per-trade feature extractor — given a single trade plus context, infer
 * the features that likely drove it.
 *
 * Pure function. Caller supplies the trade + wallet history + optional
 * market price history + optional cross-wallet context. Returns computed
 * feature scores plus a ranked list of human-readable "likely driver" tags.
 *
 * This is the reverse-engineering layer: by inspecting features around
 * each trade we can guess what signals the wallet's model (bot or human)
 * was reacting to. Examples of likelyDrivers we surface:
 *   - "cross-wallet consensus tail"   — N other tracked wallets agreed in last 5min
 *   - "momentum follower"             — traded WITH a recent price move
 *   - "fade big move"                 — traded AGAINST a recent price move
 *   - "news fade (large + extreme)"   — huge size at extreme price
 *   - "activity surge"                — cadence multiplied above baseline
 *   - "scheduled / routine"           — normal size, in wallet's peak hours
 *   - "no dominant driver"            — fallback
 *
 * Stays decoupled from any data source: caller plugs in whatever price
 * history + wallet stats they have. Unused inputs degrade gracefully.
 */

export type TradeForFeatures = {
  marketKey: string;
  /** Outcome label (YES/NO/Up/Down). */
  direction: string;
  /** BUY/SELL. */
  side: "BUY" | "SELL";
  price: number;
  usd: number;
  ts: string;
};

export type WalletHistorySummary = {
  /** Median trade size (USD) for sizeZScore baseline. */
  medianTradeUsd: number;
  /** Average trades-per-hour for the wallet (used as cadence baseline). */
  tradesPerHourMean: number;
  /** Wallet's peak UTC hour (0-23). */
  peakHourUtc: number;
  /** Wallet's recent trades, for cadence-acceleration measurement. */
  recentTrades: TradeForFeatures[];
};

export type MarketPriceContext = {
  /** Map of "minutes-before-trade" → market price at that moment. */
  pricesBeforeMin: Map<number, number>;
};

export type CrossWalletContext = {
  /** Distinct OTHER tracked wallets that traded same (marketKey, direction) in last 5 min. */
  agreementCount5min: number;
  /** Distinct cluster IDs represented in that agreement (lower = stronger signal). */
  clusterCount5min: number;
};

export type TradeFeaturesInput = {
  trade: TradeForFeatures;
  walletHistory: WalletHistorySummary;
  marketContext?: MarketPriceContext;
  crossWallet?: CrossWalletContext;
  /** Override "now" for testability. Default Date.now(). */
  nowMs?: number;
};

export type TradeFeatures = {
  // Market dynamics (null when marketContext was not provided)
  priorPriceMove5minPct: number | null;
  priorPriceMove30minPct: number | null;
  /** +1 = trade direction matches the move; -1 = against; 0 = move below threshold; null = no marketContext. */
  withMoveScore: number | null;

  // Wallet behavior
  /** trades-in-last-hour / baseline rate. >1.5 = surge. */
  cadenceAccelerationFactor: number;
  /** (trade.usd - median) / max(1, median). */
  sizeZScore: number;

  // Cross-wallet
  crossWalletAgreement5min: number;
  crossWalletClusters5min: number;

  // Time-of-day
  inPeakWindow: boolean;
  hourUtc: number;

  // Synthesis
  /** Ranked human-readable driver tags. likelyDrivers[0] is the strongest. */
  likelyDrivers: string[];
  /** 0–1 confidence in the top likelyDriver. */
  driverConfidence: number;
};

const MOVE_THRESHOLD_PCT = 0.02; // 2% move counts as "noticeable"
const BIG_MOVE_THRESHOLD_PCT = 0.05; // 5% move counts as "big"
const LARGE_SIZE_Z = 4; // 4x median trade is "large"
const EXTREME_PRICE_LOW = 0.15;
const EXTREME_PRICE_HIGH = 0.85;
const SURGE_FACTOR = 2.0;

function priorPriceMovePct(ctx: MarketPriceContext | undefined, currentPrice: number, minutesAgo: number): number | null {
  if (!ctx) return null;
  const past = ctx.pricesBeforeMin.get(minutesAgo);
  if (past == null || past <= 0) return null;
  return (currentPrice - past) / past;
}

function tradeIsAlignedWithMove(side: "BUY" | "SELL", direction: string, movePct: number): -1 | 0 | 1 {
  if (Math.abs(movePct) < MOVE_THRESHOLD_PCT) return 0;
  // BUY + YES (or BUY + Up): wallet is long this outcome. Aligned if outcome price moved up.
  // SELL + YES: closing/shorting. Aligned if price moved down.
  const longThisOutcome = side === "BUY";
  const movedUp = movePct > 0;
  return longThisOutcome === movedUp ? 1 : -1;
}

export function extractTradeFeatures(input: TradeFeaturesInput): TradeFeatures {
  const { trade, walletHistory } = input;
  const nowMs = input.nowMs ?? Date.now();
  const tradeMs = Date.parse(trade.ts);
  const hourUtc = Number.isFinite(tradeMs) ? new Date(tradeMs).getUTCHours() : 0;
  const inPeakWindow =
    Math.min(
      Math.abs(hourUtc - walletHistory.peakHourUtc),
      24 - Math.abs(hourUtc - walletHistory.peakHourUtc),
    ) <= 2;

  // Cadence acceleration: trades in last hour vs. baseline rate
  const oneHourAgoMs = (Number.isFinite(tradeMs) ? tradeMs : nowMs) - 60 * 60_000;
  const recentInLastHour = walletHistory.recentTrades.filter((t) => {
    const ms = Date.parse(t.ts);
    return Number.isFinite(ms) && ms >= oneHourAgoMs && ms <= (tradeMs || nowMs);
  }).length;
  const cadenceAccelerationFactor =
    walletHistory.tradesPerHourMean > 0
      ? recentInLastHour / walletHistory.tradesPerHourMean
      : recentInLastHour > 0
      ? Infinity
      : 0;

  // Size z-score (cheap, not stdev-based — we use median anchor for robustness)
  const sizeZScore =
    walletHistory.medianTradeUsd > 0
      ? (trade.usd - walletHistory.medianTradeUsd) / Math.max(1, walletHistory.medianTradeUsd)
      : 0;

  // Market dynamics
  const priorPriceMove5minPct = priorPriceMovePct(input.marketContext, trade.price, 5);
  const priorPriceMove30minPct = priorPriceMovePct(input.marketContext, trade.price, 30);
  let withMoveScore: number | null = null;
  if (priorPriceMove5minPct != null) {
    withMoveScore = tradeIsAlignedWithMove(trade.side, trade.direction, priorPriceMove5minPct);
  }

  // Cross-wallet
  const crossWalletAgreement5min = input.crossWallet?.agreementCount5min ?? 0;
  const crossWalletClusters5min = input.crossWallet?.clusterCount5min ?? 0;

  // Synthesis: rank drivers
  type Candidate = { tag: string; weight: number };
  const candidates: Candidate[] = [];

  if (crossWalletAgreement5min >= 3 && crossWalletClusters5min >= 2) {
    candidates.push({
      tag: `cross-wallet consensus tail (${crossWalletAgreement5min} wallets / ${crossWalletClusters5min} clusters in 5min)`,
      weight: 0.9,
    });
  }
  if (priorPriceMove5minPct != null && Math.abs(priorPriceMove5minPct) >= BIG_MOVE_THRESHOLD_PCT) {
    if (withMoveScore === 1) {
      candidates.push({
        tag: `momentum follower (${(priorPriceMove5minPct * 100).toFixed(1)}% 5-min move in same direction)`,
        weight: 0.7,
      });
    } else if (withMoveScore === -1) {
      candidates.push({
        tag: `fade big move (${(priorPriceMove5minPct * 100).toFixed(1)}% 5-min move; trade against)`,
        weight: 0.75,
      });
    }
  } else if (priorPriceMove5minPct != null && Math.abs(priorPriceMove5minPct) >= MOVE_THRESHOLD_PCT) {
    if (withMoveScore === 1) {
      candidates.push({
        tag: `momentum-tail (${(priorPriceMove5minPct * 100).toFixed(1)}% small move in same direction)`,
        weight: 0.5,
      });
    } else if (withMoveScore === -1) {
      candidates.push({
        tag: `early fade (${(priorPriceMove5minPct * 100).toFixed(1)}% small move; trade against)`,
        weight: 0.55,
      });
    }
  }
  if (sizeZScore >= LARGE_SIZE_Z && (trade.price <= EXTREME_PRICE_LOW || trade.price >= EXTREME_PRICE_HIGH)) {
    candidates.push({
      tag: `news fade (size ${sizeZScore.toFixed(1)}× median at extreme price ${trade.price.toFixed(2)})`,
      weight: 0.85,
    });
  }
  if (cadenceAccelerationFactor >= SURGE_FACTOR && Number.isFinite(cadenceAccelerationFactor)) {
    candidates.push({
      tag: `activity surge (${cadenceAccelerationFactor.toFixed(1)}× baseline cadence in last hour)`,
      weight: 0.6,
    });
  }
  if (
    candidates.length === 0 &&
    inPeakWindow &&
    Math.abs(sizeZScore) < 1
  ) {
    candidates.push({
      tag: `scheduled / routine (in peak window @ ${walletHistory.peakHourUtc}:00 UTC ±2h, normal size)`,
      weight: 0.4,
    });
  }
  if (candidates.length === 0) {
    candidates.push({ tag: "no dominant driver", weight: 0.2 });
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const likelyDrivers = candidates.map((c) => c.tag);
  const driverConfidence = candidates[0]?.weight ?? 0.2;

  return {
    priorPriceMove5minPct,
    priorPriceMove30minPct,
    withMoveScore,
    cadenceAccelerationFactor,
    sizeZScore,
    crossWalletAgreement5min,
    crossWalletClusters5min,
    inPeakWindow,
    hourUtc,
    likelyDrivers,
    driverConfidence,
  };
}
