/**
 * Fill models for the backtester. Concept ports from
 * https://github.com/nkaz001/hftbacktest — the full Rust engine's queue-position
 * model is overkill here, but two simple knobs already make backtest results
 * much more honest than mark-to-midpoint:
 *
 *   1. `walk_book`   — fill against the visible bid/ask in the snapshot
 *                       instead of midpoint, so a 10¢ spread on Polymarket
 *                       costs the strategy ~5¢/share vs the midpoint estimate.
 *   2. `latency_ms`  — defer fill decisions by N snapshot intervals so a
 *                       strategy that says "BUY at snapshot t" actually fills
 *                       at the orderbook visible at snapshot t + latency.
 *
 * Composition: the engine picks a fill function per (snapshot, decision)
 * and the latency layer is applied around it.
 */

import type { SnapshotPoint } from "./types";

export type FillModel = "midpoint" | "walk_book";

export type FillContext = {
  /** YES or NO leg of the binary market. */
  side: "YES" | "NO";
  /** 'open' = entering the position (we pay the ask); 'close' = exiting (we receive the bid). */
  action?: "open" | "close";
  snapshot: SnapshotPoint;
  size: number;            // shares
};

export type FillResult = {
  /** null when the model can't fill at this snapshot (no quote). */
  price: number | null;
  /** size actually filled — may be less than requested for walk_book on shallow books. */
  filledSize: number;
};

/**
 * Midpoint fill — the existing (optimistic) behavior. Always fills the full
 * size at the snapshot's midpoint price.
 */
export function midpointFill(ctx: FillContext): FillResult {
  const price = ctx.snapshot.midpoint;
  if (price == null || price <= 0) return { price: null, filledSize: 0 };
  return { price, filledSize: ctx.size };
}

/**
 * Walk-book fill — opening a position pays the ask; closing receives the bid.
 *
 * For Polymarket binary markets the snapshot only carries yes_price + no_price.
 * Treat those as the *ask* prices (worst case quotes for a BUY). The
 * corresponding bid for one side is `1 − ask_of_the_other_side`, so:
 *
 *   open YES  → pay yes_price          (the YES ask)
 *   close YES → receive 1 − no_price   (the YES bid, derived from NO ask)
 *   open NO   → pay no_price
 *   close NO  → receive 1 − yes_price
 *
 * Action defaults to 'open' so callers that don't pass it (older code, or
 * tests that don't care about direction) get the original BUY-side semantics.
 */
export function walkBookFill(ctx: FillContext): FillResult {
  const { yes_price, no_price, midpoint, spread } = ctx.snapshot;
  const action = ctx.action ?? "open";
  const halfSpread = (spread ?? 0) / 2;
  let price: number | null;
  if (ctx.side === "YES") {
    if (action === "open") {
      price = yes_price ?? (midpoint != null ? midpoint + halfSpread : null);
    } else {
      // close YES = sell into the bid = 1 − no_price; fallback midpoint − half
      price = no_price != null ? 1 - no_price : midpoint != null ? midpoint - halfSpread : null;
    }
  } else {
    if (action === "open") {
      price = no_price ?? (midpoint != null ? midpoint + halfSpread : null);
    } else {
      price = yes_price != null ? 1 - yes_price : midpoint != null ? midpoint - halfSpread : null;
    }
  }
  if (price == null || price <= 0) return { price: null, filledSize: 0 };
  return { price, filledSize: ctx.size };
}

/**
 * Resolve a model name to the function.
 */
export function getFillFn(model: FillModel): (ctx: FillContext) => FillResult {
  return model === "walk_book" ? walkBookFill : midpointFill;
}

/**
 * Apply a latency delay: a decision at snapshot index `i` fills at snapshot
 * index `i + delaySnapshots` (clamped to the last snapshot). Returns the
 * snapshot whose orderbook the fill should hit.
 */
export function applyLatency(
  snapshots: SnapshotPoint[],
  decisionIndex: number,
  delaySnapshots: number,
): SnapshotPoint {
  const target = Math.min(snapshots.length - 1, decisionIndex + Math.max(0, delaySnapshots));
  return snapshots[target];
}

/**
 * Convert latency milliseconds → snapshot count using the average inter-snapshot
 * gap. Useful when snapshots aren't evenly spaced (e.g. a worker that snapshots
 * every minute won't fire at exact intervals).
 */
export function latencyMsToSnapshots(snapshots: SnapshotPoint[], latencyMs: number): number {
  if (snapshots.length < 2 || latencyMs <= 0) return 0;
  const first = Date.parse(snapshots[0].captured_at);
  const last = Date.parse(snapshots[snapshots.length - 1].captured_at);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return 0;
  const avgGapMs = (last - first) / (snapshots.length - 1);
  if (avgGapMs <= 0) return 0;
  return Math.max(1, Math.round(latencyMs / avgGapMs));
}
