/**
 * Orderbook imbalance detector — measure bid/ask depth skew at the top N
 * levels of a Polymarket binary market orderbook.
 *
 * When bid-side USD depth at top-3 levels is ≥ 3× ask-side depth (or vice
 * versa), there's a microstructure pressure signal that often precedes a
 * price move within seconds.
 *
 * Pure function. Caller supplies an L2 snapshot (bids sorted desc, asks
 * sorted asc); returns ImbalanceOpportunity or null.
 *
 * Caveats stamped in the detector's design (not return value — agents read
 * these from docs):
 *   - Spoofing: large orders can appear and vanish without trading. v1
 *     emits the raw signal; agents/operators apply judgment. A future
 *     enhancement is "persistence check" — require imbalance to hold across
 *     N consecutive polls before signaling.
 *   - Latency: signal decays in seconds. Polling-based detection is best-
 *     effort; WS upgrade is the proper fix.
 *
 * Returns null on: empty book, one-sided book, dust-book below minimum
 * total depth, ratio inside the normal range (no skew worth acting on).
 */

export type OrderbookLevel = { price: number; size: number };
export type OrderbookSide = OrderbookLevel[];

export type OrderbookSnapshot = {
  conditionId: string;
  marketTitle?: string;
  /** Sorted descending by price. */
  bids: OrderbookSide;
  /** Sorted ascending by price. */
  asks: OrderbookSide;
  ts: string;
};

export type ImbalanceOpportunity = {
  conditionId: string;
  marketTitle?: string;
  bidDepthUsd: number;
  askDepthUsd: number;
  /** bidDepth / askDepth. > 1 = bid-heavy (buying pressure). */
  imbalanceRatio: number;
  /** 0..1 — normalized strength of the skew. */
  signalStrength: number;
  /** BUY when bid-heavy, SELL when ask-heavy. */
  side: "BUY" | "SELL";
  topBidPrice: number;
  topAskPrice: number;
  edge: number;
  reason: string;
  /** Alias for consumer code that wants a generic "marketKey" field. */
  marketKey: string;
};

export type ImbalanceOptions = {
  /** How many top-of-book levels to sum. Default 3. */
  topLevels?: number;
  /** Trigger ratio. Default 3.0 (bid-heavy) or 1/3.0 (ask-heavy). */
  minRatio?: number;
  /** Total bid+ask depth (USD) below which book is too thin for signal. Default 1000. */
  minTotalDepthUsd?: number;
};

export function detectOrderbookImbalance(
  book: OrderbookSnapshot,
  opts: ImbalanceOptions = {},
): ImbalanceOpportunity | null {
  const topLevels = opts.topLevels ?? 3;
  const minRatio = opts.minRatio ?? 3.0;
  const minDepth = opts.minTotalDepthUsd ?? 1000;

  if (!book.bids?.length || !book.asks?.length) return null;

  const bidsTop = book.bids.slice(0, topLevels);
  const asksTop = book.asks.slice(0, topLevels);

  // USD depth = sum(price × size). For Polymarket binary markets, price ∈ (0,1)
  // and size is share count; price × size ≈ USD notional.
  const bidDepth = bidsTop.reduce((s, x) => s + x.price * x.size, 0);
  const askDepth = asksTop.reduce((s, x) => s + x.price * x.size, 0);
  if (bidDepth + askDepth < minDepth) return null;
  if (bidDepth <= 0 || askDepth <= 0) return null;

  const ratio = bidDepth / askDepth;

  let side: "BUY" | "SELL" | null = null;
  if (ratio >= minRatio) side = "BUY";
  else if (ratio <= 1 / minRatio) side = "SELL";
  if (!side) return null;

  // Strength: 0 at threshold, asymptotically 1 at extreme. Scale so that
  // 5× the threshold = strength 1.0.
  const excess = side === "BUY" ? ratio / minRatio - 1 : minRatio / ratio - 1;
  const signalStrength = Math.min(1, Math.max(0, excess / 5));

  // "Edge" is approximate — half the bid-ask spread × signalStrength, as a
  // rough proxy for the price move the imbalance might pull through.
  const spread = asksTop[0].price - bidsTop[0].price;
  const edge = Math.max(0, spread / 2) * signalStrength;

  return {
    conditionId: book.conditionId,
    marketTitle: book.marketTitle,
    bidDepthUsd: bidDepth,
    askDepthUsd: askDepth,
    imbalanceRatio: ratio,
    signalStrength,
    side,
    topBidPrice: bidsTop[0].price,
    topAskPrice: asksTop[0].price,
    edge,
    reason: `${side === "BUY" ? "bid" : "ask"}-heavy ${ratio.toFixed(2)}:1 (bid=$${bidDepth.toFixed(0)}, ask=$${askDepth.toFixed(0)}, strength ${(signalStrength * 100).toFixed(0)}%)`,
    marketKey: book.conditionId,
  };
}
