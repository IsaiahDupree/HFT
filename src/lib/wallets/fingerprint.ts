/**
 * Wallet fingerprinting — reverse-engineer a wallet's behavior from its
 * publicly-observable trade history.
 *
 * Pure function: takes the raw trades + positions arrays from the Data API
 * and returns a structured fingerprint. No DB, no HTTP, no LLM — designed
 * so the analytics test suite can drive it without spinning up the world.
 *
 * What the fingerprint captures:
 *   - Cadence (trades-per-hour, inter-trade variance) → bot probability
 *   - Size distribution → whale vs. retail
 *   - Category concentration → focused bot vs. generalist
 *   - Entry-price distribution → near 0/1 = directional / longshot;
 *     near 0.5 = market-making or latency arb
 *   - Correlated-basket signature → same direction across BTC/ETH/SOL/XRP
 *     in the same time window (the @0xb55fa... pattern)
 *   - Time-of-day clustering → microstructure timing
 *   - Strategy-family classification → best-guess label
 *
 * Caveats stamped in the result:
 *   - "snapshot only" — historical PnL behind the snapshot is NOT visible
 *     unless caller also passes closedPositions
 *   - "small sample" when n < 50
 *
 * Not the source of truth: this is what we can infer. To act on it, run
 * the scanner across many wallets and look for *patterns*, not individual
 * fingerprints.
 */

export type RawTrade = {
  asset?: string;
  conditionId?: string;
  eventSlug?: string;
  title?: string;
  outcome?: string;
  outcomeIndex?: number;
  price?: number | string;
  side?: string;
  size?: number | string;
  usdcSize?: number | string;
  timestamp?: number | string;
  transactionHash?: string;
  slug?: string;
  [k: string]: unknown;
};

export type RawPosition = {
  conditionId?: string;
  size?: number | string;
  curPrice?: number | string;
  cashPnl?: number | string;
  outcome?: string;
  title?: string;
  [k: string]: unknown;
};

export type RawClosedPosition = {
  conditionId?: string;
  cashPnl?: number | string;
  size?: number | string;
  [k: string]: unknown;
};

export type StrategyFamily =
  | "latency_arb"
  | "market_making"
  | "correlated_basket"
  | "directional_crypto_intraday"
  | "longshot_hunter"
  | "generalist"
  | "low_signal";

export type WalletFingerprint = {
  // Source
  proxyWallet: string | null;
  sampledTrades: number;
  sampledOpenPositions: number;
  sampledClosedPositions: number;
  /** Count of unique conditionIds touched across the sampled trades.
   *  Differentiates "1000 fills on 5 markets" (position trader scraping
   *  orderbook) from "1000 fills on 800 markets" (real HFT). */
  distinctConditionIds: number;
  windowDays: number | null;

  // Cadence
  tradesPerHourMean: number;
  interTradeMedianSec: number;
  interTradeStdevSec: number;
  /** 0–1: how bot-like the cadence looks. >0.7 = high confidence bot. */
  cadenceBotScore: number;

  // Sizing
  avgTradeUsd: number;
  medianTradeUsd: number;
  maxTradeUsd: number;
  sizeBuckets: { lt10: number; lt100: number; lt1000: number; gt1000: number };

  // Category mix
  topEventSlugs: Array<{ slug: string; count: number; pct: number }>;
  topTitles: Array<{ title: string; count: number; pct: number }>;
  /** % of trades whose slug includes a crypto symbol (btc/eth/sol/xrp/doge). */
  cryptoPct: number;
  /** Top single category share — high = focused, low = diversified. */
  concentrationPct: number;

  // Entry-price distribution
  avgEntryPrice: number;
  /** % of trades entered with price > 0.45 AND < 0.55 — market-making signature. */
  midpointEntryPct: number;
  /** % entered with price <= 0.10 OR >= 0.90 — longshot/tail signature. */
  tailEntryPct: number;

  // Correlated-basket detection
  /** Time-window cohorts where ≥3 different crypto assets were traded in the same direction within a small window. */
  correlatedBasketCohorts: number;
  /** Sample of the largest correlated cohorts (for the UI). */
  correlatedBasketExamples: Array<{ windowStart: string; assets: string[]; side: string; tradeCount: number }>;

  // Time-of-day clustering
  /** UTC hour 0–23 buckets, count of trades. */
  hourlyHistogram: number[];
  /** Index of the peak UTC hour (0–23). */
  peakHourUtc: number;
  /** Fraction of trades inside the peak ±2h window. */
  peakHourConcentrationPct: number;

  // PnL signals (only when closedPositions provided)
  realizedPnlUsd: number | null;
  winRate: number | null;

  // Classification
  strategyFamily: StrategyFamily;
  classificationReasons: string[];
  caveats: string[];
};

export type FingerprintInput = {
  proxyWallet?: string | null;
  trades: RawTrade[];
  openPositions?: RawPosition[];
  closedPositions?: RawClosedPosition[];
};

const CRYPTO_KEYS = ["btc", "bitcoin", "eth", "ethereum", "sol", "solana", "xrp", "ripple", "doge", "dogecoin"];

function num(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Given a slug or title, return a normalized crypto-asset key (btc/eth/sol/xrp/doge)
 * or null if it doesn't look like a crypto market.
 */
function cryptoAssetFromText(s: string | undefined): string | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.includes("btc") || lower.includes("bitcoin")) return "btc";
  if (lower.includes("eth") || lower.includes("ethereum")) return "eth";
  if (lower.includes("sol") || lower.includes("solana")) return "sol";
  if (lower.includes("xrp") || lower.includes("ripple")) return "xrp";
  if (lower.includes("doge")) return "doge";
  return null;
}

function looksCrypto(t: RawTrade): boolean {
  const blob = `${t.eventSlug ?? ""} ${t.slug ?? ""} ${t.title ?? ""}`.toLowerCase();
  return CRYPTO_KEYS.some((k) => blob.includes(k));
}

/**
 * Detect correlated-basket cohorts: time windows in which the wallet placed
 * trades on ≥3 different crypto assets in the same direction (e.g. all "Down")
 * within the same window. This is the @0xb55fa... pattern — multiple
 * simultaneous "independent" bets that are actually one macro call.
 *
 * Bucket trades into ½-hour windows by UTC timestamp.
 */
function findCorrelatedBaskets(trades: RawTrade[]): {
  cohorts: number;
  examples: Array<{ windowStart: string; assets: string[]; side: string; tradeCount: number }>;
} {
  const buckets = new Map<string, Map<string, Map<string, number>>>(); // windowKey → side → asset → count
  for (const t of trades) {
    const asset = cryptoAssetFromText(t.slug ?? t.title ?? t.eventSlug);
    if (!asset) continue;
    const tsRaw = num(t.timestamp);
    if (!tsRaw) continue;
    const tsMs = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
    const halfHourMs = 30 * 60 * 1000;
    const bucketMs = Math.floor(tsMs / halfHourMs) * halfHourMs;
    const windowKey = new Date(bucketMs).toISOString();
    // Use outcome (Up/Down) when present; else side (BUY/SELL)
    const direction = (t.outcome ?? t.side ?? "").toString().toUpperCase();
    if (!direction) continue;
    if (!buckets.has(windowKey)) buckets.set(windowKey, new Map());
    const byDir = buckets.get(windowKey)!;
    if (!byDir.has(direction)) byDir.set(direction, new Map());
    const byAsset = byDir.get(direction)!;
    byAsset.set(asset, (byAsset.get(asset) ?? 0) + 1);
  }
  const examples: Array<{ windowStart: string; assets: string[]; side: string; tradeCount: number }> = [];
  for (const [windowKey, byDir] of buckets) {
    for (const [direction, byAsset] of byDir) {
      if (byAsset.size >= 3) {
        const assets = [...byAsset.keys()].sort();
        const tradeCount = [...byAsset.values()].reduce((a, b) => a + b, 0);
        examples.push({ windowStart: windowKey, assets, side: direction, tradeCount });
      }
    }
  }
  examples.sort((a, b) => b.tradeCount - a.tradeCount);
  return { cohorts: examples.length, examples: examples.slice(0, 5) };
}

export function fingerprintWallet(input: FingerprintInput): WalletFingerprint {
  const trades = (input.trades ?? []).filter((t) => t && typeof t === "object");
  const open = input.openPositions ?? [];
  const closed = input.closedPositions ?? [];

  const caveats: string[] = [];
  if (trades.length < 50) caveats.push(`small sample (n=${trades.length} trades) — fingerprint is low-confidence`);
  if (!input.closedPositions) caveats.push("realized PnL not provided — only snapshot-level info");

  // --- Time + cadence
  const timestamps = trades
    .map((t) => num(t.timestamp))
    .filter((n) => n > 0)
    .map((n) => (n > 1e12 ? n : n * 1000))
    .sort((a, b) => a - b);
  const windowDays = timestamps.length >= 2 ? (timestamps[timestamps.length - 1] - timestamps[0]) / 86_400_000 : null;
  const intervalsMs = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  const intervalsSec = intervalsMs.map((ms) => ms / 1000);
  const interTradeMedianSec = median(intervalsSec);
  const interTradeStdevSec = stdev(intervalsSec);
  const tradesPerHourMean = windowDays && windowDays > 0 ? trades.length / (windowDays * 24) : 0;
  // Bot cadence score: tight median AND low coefficient-of-variation = bot.
  // Coefficient of variation < 1 with median < 60s is a strong bot signal.
  const cv = interTradeMedianSec > 0 ? interTradeStdevSec / interTradeMedianSec : Infinity;
  let cadenceBotScore = 0;
  if (tradesPerHourMean > 50) cadenceBotScore += 0.5;
  else if (tradesPerHourMean > 10) cadenceBotScore += 0.3;
  if (interTradeMedianSec > 0 && interTradeMedianSec < 60) cadenceBotScore += 0.3;
  if (cv < 2 && intervalsSec.length > 20) cadenceBotScore += 0.2;
  cadenceBotScore = Math.min(1, cadenceBotScore);

  // --- Sizing
  const sizesUsd = trades.map((t) => Math.abs(num(t.usdcSize ?? num(t.size) * num(t.price))));
  const avgTradeUsd = sizesUsd.length ? sizesUsd.reduce((a, b) => a + b, 0) / sizesUsd.length : 0;
  const medianTradeUsd = median(sizesUsd);
  const maxTradeUsd = sizesUsd.length ? Math.max(...sizesUsd) : 0;
  const sizeBuckets = { lt10: 0, lt100: 0, lt1000: 0, gt1000: 0 };
  for (const s of sizesUsd) {
    if (s < 10) sizeBuckets.lt10++;
    else if (s < 100) sizeBuckets.lt100++;
    else if (s < 1000) sizeBuckets.lt1000++;
    else sizeBuckets.gt1000++;
  }

  // --- Category mix
  const slugTally = new Map<string, number>();
  const titleTally = new Map<string, number>();
  let cryptoCount = 0;
  for (const t of trades) {
    if (t.eventSlug) slugTally.set(t.eventSlug, (slugTally.get(t.eventSlug) ?? 0) + 1);
    if (t.title) titleTally.set(t.title, (titleTally.get(t.title) ?? 0) + 1);
    if (looksCrypto(t)) cryptoCount++;
  }
  const topEventSlugs = [...slugTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([slug, count]) => ({ slug, count, pct: pct(count, trades.length) }));
  const topTitles = [...titleTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([title, count]) => ({ title, count, pct: pct(count, trades.length) }));
  const concentrationPct = topEventSlugs[0]?.pct ?? 0;
  const cryptoPctV = pct(cryptoCount, trades.length);

  // --- Entry price distribution
  const prices = trades.map((t) => num(t.price)).filter((p) => p > 0 && p < 1);
  const avgEntryPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const midpointEntryPct = pct(prices.filter((p) => p >= 0.45 && p <= 0.55).length, prices.length);
  const tailEntryPct = pct(prices.filter((p) => p <= 0.10 || p >= 0.90).length, prices.length);

  // --- Correlated basket
  const basket = findCorrelatedBaskets(trades);

  // --- Time-of-day
  const hourlyHistogram = new Array(24).fill(0);
  for (const ts of timestamps) {
    const h = new Date(ts).getUTCHours();
    hourlyHistogram[h]++;
  }
  const peakHourUtc = hourlyHistogram.indexOf(Math.max(...hourlyHistogram));
  // ±2h around peak
  const peakWindow = [-2, -1, 0, 1, 2]
    .map((d) => (peakHourUtc + d + 24) % 24)
    .reduce((sum, h) => sum + hourlyHistogram[h], 0);
  const peakHourConcentrationPct = pct(peakWindow, timestamps.length);

  // --- PnL (closed only)
  let realizedPnlUsd: number | null = null;
  let winRate: number | null = null;
  if (closed.length > 0) {
    realizedPnlUsd = closed.reduce((sum, p) => sum + num(p.cashPnl), 0);
    const wins = closed.filter((p) => num(p.cashPnl) > 0).length;
    winRate = pct(wins, closed.length);
  }

  // --- Strategy family
  const reasons: string[] = [];
  let strategyFamily: StrategyFamily = "generalist";
  if (trades.length < 20) {
    strategyFamily = "low_signal";
    reasons.push(`only ${trades.length} trades observed`);
  } else if (basket.cohorts >= 3 && cryptoPctV > 0.6) {
    strategyFamily = "correlated_basket";
    reasons.push(`${basket.cohorts} cohorts where ≥3 crypto assets traded the same direction in a 30-min window`);
    reasons.push(`${(cryptoPctV * 100).toFixed(0)}% of trades are on crypto markets`);
  } else if (cryptoPctV > 0.8 && tradesPerHourMean > 5 && interTradeMedianSec < 120) {
    strategyFamily = "latency_arb";
    reasons.push(`high-cadence (${tradesPerHourMean.toFixed(1)}/hr, median interval ${interTradeMedianSec.toFixed(0)}s) on crypto-only markets`);
  } else if (midpointEntryPct > 0.6 && tradesPerHourMean > 10) {
    strategyFamily = "market_making";
    reasons.push(`${(midpointEntryPct * 100).toFixed(0)}% of entries near midpoint (0.45–0.55) with high cadence`);
  } else if (cryptoPctV > 0.7) {
    strategyFamily = "directional_crypto_intraday";
    reasons.push(`${(cryptoPctV * 100).toFixed(0)}% crypto, moderate cadence`);
  } else if (tailEntryPct > 0.5) {
    strategyFamily = "longshot_hunter";
    reasons.push(`${(tailEntryPct * 100).toFixed(0)}% of entries in the tail (price ≤ 0.10 or ≥ 0.90)`);
  } else {
    reasons.push(`no single signature dominates`);
  }

  // Count of distinct conditionIds touched — key signal for separating real
  // HFT (touches many markets) from position-trader scraping orderbook on
  // a few markets via thousands of fills.
  const distinctConditionIds = new Set(
    trades.map((t) => t.conditionId).filter((c): c is string => typeof c === "string" && c.length > 0),
  ).size;

  return {
    proxyWallet: input.proxyWallet ?? null,
    sampledTrades: trades.length,
    sampledOpenPositions: open.length,
    sampledClosedPositions: closed.length,
    distinctConditionIds,
    windowDays,
    tradesPerHourMean,
    interTradeMedianSec,
    interTradeStdevSec,
    cadenceBotScore,
    avgTradeUsd,
    medianTradeUsd,
    maxTradeUsd,
    sizeBuckets,
    topEventSlugs,
    topTitles,
    cryptoPct: cryptoPctV,
    concentrationPct,
    avgEntryPrice,
    midpointEntryPct,
    tailEntryPct,
    correlatedBasketCohorts: basket.cohorts,
    correlatedBasketExamples: basket.examples,
    hourlyHistogram,
    peakHourUtc,
    peakHourConcentrationPct,
    realizedPnlUsd,
    winRate,
    strategyFamily,
    classificationReasons: reasons,
    caveats,
  };
}
