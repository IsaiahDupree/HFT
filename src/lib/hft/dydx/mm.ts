// Pure quote-logic for the dYdX testnet market-making loop. Kept side-effect
// free so the math can be unit-tested independently of the SDK.

export type MmConfig = {
  /** Target half-spread (each side, in basis points). 10 = 0.10 % each side. */
  halfSpreadBps: number;
  /** Per-side notional in USD. */
  perSideUsd: number;
  /** Cap on |inventory| in USD. Once breached, only the flattening side quotes. */
  maxInventoryUsd: number;
  /** Quote drift tolerance (bps). If our resting order drifts > this from the
   *  fresh target, we replace it; otherwise we leave it alone. */
  driftBps: number;
  /** Inventory skew (bps per $1 of inventory). Positive = tilt quotes against
   *  current inventory to mean-revert. */
  skewBpsPerDollar: number;
  /** Use microprice (size-weighted bid/ask blend) as fair instead of oracle.
   *  Falls back to oracle when the L1 book is empty. */
  useMicroprice?: boolean;
  /** |OBI| above this triggers spread widening (toxic-flow defence). 0 disables. */
  obiToxicityThreshold?: number;
  /** Max multiplier applied to halfSpreadBps when |OBI| saturates at 1.0. */
  obiToxicityMaxMultiplier?: number;
  /** Quoted spread (in bps of mid) above this is treated as a market anomaly
   *  and we pause the cycle. 0 disables. */
  spreadAnomalyBps?: number;
};

export type MarketParams = {
  tickSize: number;
  stepSize: number;
};

export type QuotePair = {
  bid?: { price: number; size: number };
  ask?: { price: number; size: number };
  /** Fair value we'd quote around. */
  fair: number;
  /** Effective skew (bps) applied to fair based on inventory. */
  skewBps: number;
};

export function roundToTick(price: number, tickSize: number): number {
  return +(Math.round(price / tickSize) * tickSize).toFixed(10);
}

export function roundToStep(size: number, stepSize: number): number {
  return +(Math.max(stepSize, Math.round(size / stepSize) * stepSize)).toFixed(10);
}

/**
 * Compute one round of bid+ask quotes.
 *
 *   - fairValue is the reference (oracle / mid / external feed).
 *   - inventoryUsd is signed: + = long, - = short.
 *   - When |inventoryUsd| >= maxInventoryUsd, we suppress the side that would
 *     grow inventory (e.g. long → no more bids).
 *   - skewBps tilts the mid against inventory: long position → lower mid →
 *     bids further away, asks tighter (encourages flattening).
 */
export function computeQuotes(
  fairValue: number,
  inventoryUsd: number,
  cfg: MmConfig,
  mkt: MarketParams,
): QuotePair {
  const skewBps = -inventoryUsd * cfg.skewBpsPerDollar;
  const fair = fairValue * (1 + skewBps / 10000);

  const bidPrice = roundToTick(fair * (1 - cfg.halfSpreadBps / 10000), mkt.tickSize);
  const askPrice = roundToTick(fair * (1 + cfg.halfSpreadBps / 10000), mkt.tickSize);
  const size = roundToStep(cfg.perSideUsd / fair, mkt.stepSize);

  // Suppress the side that would push us past the inventory cap.
  const longBlocked = inventoryUsd >= cfg.maxInventoryUsd;
  const shortBlocked = inventoryUsd <= -cfg.maxInventoryUsd;

  return {
    fair,
    skewBps,
    bid: longBlocked ? undefined : { price: bidPrice, size },
    ask: shortBlocked ? undefined : { price: askPrice, size },
  };
}

/** Returns true if a resting order should be cancelled and re-placed. */
export function shouldReplace(
  restingPrice: number,
  targetPrice: number,
  driftBps: number,
): boolean {
  const drift = Math.abs(restingPrice - targetPrice) / targetPrice;
  return drift * 10000 > driftBps;
}

export type Fill = {
  side: "BUY" | "SELL";
  price: number;
  size: number;
  feeUsd: number;
  ts: number;
};

export type PnlState = {
  fills: Fill[];
  /** Running inventory (signed asset units). */
  position: number;
  /** Volume-weighted average cost of the current open position. */
  vwap: number;
  /** Cumulative realised PnL (USD). */
  realisedUsd: number;
  /** Cumulative fees paid (USD), already netted into realisedUsd. */
  feesUsd: number;
};

export function freshPnl(): PnlState {
  return { fills: [], position: 0, vwap: 0, realisedUsd: 0, feesUsd: 0 };
}

/**
 * Apply a fill to running PnL state. BUY adds to position at vwap; SELL
 * reduces position and books realised PnL against vwap. Crossing zero
 * (e.g. short→long) splits the fill so the booked PnL is correct.
 */
export function applyFill(state: PnlState, f: Fill): PnlState {
  const next: PnlState = { ...state, fills: [...state.fills, f], feesUsd: state.feesUsd + f.feeUsd };
  const dir = f.side === "BUY" ? +1 : -1;
  let qty = f.size;

  // Reduce existing position first if signs oppose.
  if (next.position !== 0 && Math.sign(next.position) !== dir) {
    const reduce = Math.min(qty, Math.abs(next.position));
    const pnlPerUnit = next.position > 0 ? (f.price - next.vwap) : (next.vwap - f.price);
    next.realisedUsd += pnlPerUnit * reduce;
    next.position += dir * reduce;
    qty -= reduce;
    if (next.position === 0) next.vwap = 0;
  }

  // Anything remaining opens / grows position; update vwap.
  if (qty > 0) {
    const newPos = next.position + dir * qty;
    const totalCost = next.vwap * Math.abs(next.position) + f.price * qty;
    next.vwap = totalCost / Math.abs(newPos);
    next.position = newPos;
  }

  next.realisedUsd -= f.feeUsd;
  return next;
}

/** Mark-to-market PnL using the current reference price. */
export function unrealisedPnl(state: PnlState, mark: number): number {
  if (state.position === 0) return 0;
  return state.position > 0
    ? (mark - state.vwap) * state.position
    : (state.vwap - mark) * -state.position;
}
