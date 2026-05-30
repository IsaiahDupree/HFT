// Microstructure signals — pure compute functions, no side effects.
//
// `computeMicroprice` returns the size-weighted blend of best bid and best ask.
// Intuition: when bid_size >> ask_size, the next trade tends to lift the ask,
// so "fair" sits closer to the ask. Quoting around mid biases your ask down
// and your bid up; microprice corrects this.
//
// `computeOBI` returns top-N order-book imbalance ∈ [−1, +1]. Positive means
// the bid side has more visible size than the ask side (book pressure up).

export type BookLevel = { price: number; size: number };

/**
 * Size-weighted fair value:  (bidSize × ask + askSize × bid) / (bidSize + askSize)
 * Returns null when either side is empty (no opinion).
 */
export function computeMicroprice(bids: BookLevel[], asks: BookLevel[]): number | null {
  const bid = bids[0];
  const ask = asks[0];
  if (!bid || !ask) return null;
  if (bid.size <= 0 && ask.size <= 0) return null;
  const denom = bid.size + ask.size;
  if (denom <= 0) return null;
  return (bid.size * ask.price + ask.size * bid.price) / denom;
}

/**
 * Top-N order-book imbalance.
 *   OBI = (sum(bid_size_top_N) − sum(ask_size_top_N)) / total
 *   ∈ [−1, +1], positive when bid side is heavier.
 * Returns 0 when both sides are empty.
 */
export function computeOBI(bids: BookLevel[], asks: BookLevel[], levels = 5): number {
  const bidSum = bids.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const askSum = asks.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const total = bidSum + askSum;
  if (total <= 0) return 0;
  return (bidSum - askSum) / total;
}

/** Best-bid-ask spread in basis points of mid. Null if either side missing. */
export function quotedSpreadBps(bids: BookLevel[], asks: BookLevel[]): number | null {
  const b = bids[0]?.price;
  const a = asks[0]?.price;
  if (!b || !a) return null;
  const mid = (b + a) / 2;
  if (mid <= 0) return null;
  return ((a - b) / mid) * 10000;
}

/**
 * Simple toxicity multiplier for half-spread widening: scales linearly between
 * 1× (no toxicity, |OBI| ≤ threshold) and maxMultiplier (|OBI| ≥ 1.0).
 * Caller decides whether to apply directionally (widen only the side being
 * picked off) or symmetrically (widen both).
 */
export function obiWidenMultiplier(obi: number, threshold: number, maxMultiplier: number): number {
  const m = Math.abs(obi);
  if (m <= threshold) return 1;
  if (m >= 1) return maxMultiplier;
  const t = (m - threshold) / (1 - threshold);
  return 1 + t * (maxMultiplier - 1);
}
