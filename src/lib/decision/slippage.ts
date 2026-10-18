/**
 * Slippage estimator (Phase 15 of selective-micro-edges PRD).
 *
 * The existing edge gate computes `net_edge = edge - fees`. But the edge
 * is measured at top-of-book mid-price, and we don't actually FILL at the
 * top — we fill at progressively worse prices as we eat through the book.
 * This module corrects that.
 *
 * Pure function. Given a target order size + an L2 order book snapshot,
 * returns:
 *   - volume_weighted_fill_price: the actual VWAP we'd pay/receive
 *   - impact_bps: deviation from top-of-book in basis points
 *   - filled_size_usd: how much of the order actually filled at any price
 *     (may be less than requested if the book is thin)
 *
 * BUY orders walk the asks (cheapest first → progressively more expensive).
 * SELL orders walk the bids (highest first → progressively cheaper).
 *
 * The edge gate (gates.ts) consults this when ctx.snapshot.orderBook is
 * supplied so the gate's net-edge calculation reflects the realistic
 * fill price, not the top-of-book.
 */

export type L2Level = {
  /** Price per share (0..1 for binary markets). */
  price: number;
  /** Size in SHARES at this price level. */
  size: number;
};

export type OrderBookL2 = {
  /** Bids descending (highest first). Sells walk this. */
  bids: readonly L2Level[];
  /** Asks ascending (lowest first). Buys walk this. */
  asks: readonly L2Level[];
};

export type SlippageEstimate = {
  /** Side the estimate is for. */
  side: "BUY" | "SELL";
  /** Requested size in USD. */
  requested_size_usd: number;
  /** Actual size in USD that the book can fill. May be less when book is thin. */
  filled_size_usd: number;
  /** VWAP of the fill, in price units. */
  vwap: number;
  /** Top-of-book mid (or best ask for BUY, best bid for SELL). */
  top_of_book: number;
  /** (vwap - top_of_book) / top_of_book × 10_000. Positive = paid more for BUY. */
  impact_bps: number;
  /** True if the book ran out before the order could fully fill. */
  partial_fill: boolean;
};

/**
 * Walk the order book to fill `requestedSizeUsd` USD of the given side.
 *
 * Edge cases:
 *   - Empty book on that side → returns filled_size_usd=0, vwap=NaN
 *   - Requested ≤ 0 → returns filled_size_usd=0 immediately
 *   - Thin book → fills as much as possible, marks partial_fill=true
 */
export function estimateSlippage(
  side: "BUY" | "SELL",
  requestedSizeUsd: number,
  book: OrderBookL2,
): SlippageEstimate {
  if (!Number.isFinite(requestedSizeUsd) || requestedSizeUsd <= 0) {
    return zeroEstimate(side, 0, book);
  }

  const levels = side === "BUY" ? book.asks : book.bids;
  if (levels.length === 0) {
    return zeroEstimate(side, requestedSizeUsd, book);
  }

  const topOfBook = levels[0]!.price;
  if (!Number.isFinite(topOfBook) || topOfBook <= 0) {
    return zeroEstimate(side, requestedSizeUsd, book);
  }

  let remainingUsd = requestedSizeUsd;
  let filledUsd = 0;
  let weightedPriceSum = 0; // sum of (price × usd_at_level)

  for (const level of levels) {
    if (remainingUsd <= 0) break;
    const price = level.price;
    if (!Number.isFinite(price) || price <= 0) continue;
    const usdAtLevel = level.size * price; // size is in shares
    const consumed = Math.min(remainingUsd, usdAtLevel);
    if (consumed <= 0) continue;
    filledUsd += consumed;
    weightedPriceSum += price * consumed;
    remainingUsd -= consumed;
  }

  if (filledUsd === 0) {
    return zeroEstimate(side, requestedSizeUsd, book);
  }

  const vwap = weightedPriceSum / filledUsd;
  const rawImpact = (vwap - topOfBook) / topOfBook;
  // For SELL we expect VWAP ≤ top-of-book (bids descend) — invert sign so
  // impact_bps is always non-negative for "cost of walking the book."
  const impactBps = Math.abs(rawImpact) * 10_000;

  return {
    side,
    requested_size_usd: requestedSizeUsd,
    filled_size_usd: filledUsd,
    vwap,
    top_of_book: topOfBook,
    impact_bps: +impactBps.toFixed(2),
    partial_fill: filledUsd < requestedSizeUsd - 1e-6,
  };
}

function zeroEstimate(side: "BUY" | "SELL", requested: number, book: OrderBookL2): SlippageEstimate {
  const levels = side === "BUY" ? book.asks : book.bids;
  return {
    side,
    requested_size_usd: requested,
    filled_size_usd: 0,
    vwap: Number.NaN,
    top_of_book: levels[0]?.price ?? Number.NaN,
    impact_bps: 0,
    partial_fill: true,
  };
}
