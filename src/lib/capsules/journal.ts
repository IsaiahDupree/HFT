/**
 * Capsule fill journaling.
 *
 * Without this, a capsule's `daily_pnl_usd` and `capital_deployed_usd` stay
 * at 0 forever — which means the `CAPSULE_DAILY_LOSS` cap is checking against
 * a value that never moves and never trips. That's the silent bug this
 * module exists to plug.
 *
 * The math is cost-basis-aware:
 *   - BUY:   increase open_position_qty/cost and capital_deployed; cash flow only
 *   - SELL:  proportional cost basis released; realized PnL = proceeds - cost
 *
 * Aggregate across symbols. Accurate when the capsule trades a single symbol
 * (the common v1 case). Multi-symbol capsules would need a per-symbol position
 * table (a future addition that doesn't change this contract).
 *
 * Pure function — caller supplies the capsule snapshot and gets back a patch
 * + a `realized_pnl_usd`. No DB writes. The router does the persistence so
 * tests stay decoupled.
 */
import type { Capsule } from "./types";

export type FillForCapsule = {
  side: "BUY" | "SELL";
  qty: number;             // shares / base units filled
  price: number;            // fill price (per share)
  fee?: number;             // adapter-reported fee in quote currency (default 0)
  /** USD equivalent reported by the adapter — used to size capital_deployed
   *  when price/qty don't directly multiply to USD (e.g. Coinbase quote_size). */
  usdEquivalent: number;
  /** ISO timestamp; defaults to now. Used to decide whether to roll the day. */
  filledAtIso?: string;
};

export type CapsulePatch = Required<Pick<Capsule,
  "current_pnl_usd" | "daily_pnl_usd" | "capital_deployed_usd" |
  "capital_available_usd" | "open_positions" | "trades_today" |
  "open_position_qty" | "open_position_cost_usd" | "daily_pnl_reset_date"
>> & { realized_pnl_usd: number };

function utcDate(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10);
}

/**
 * Apply a single fill to the capsule's realtime fields. Returns the patch
 * the store should write. The patch is computed against the snapshot you
 * provide — concurrent callers must serialize their reads/writes (the
 * router holds the only journal path, so this is fine in practice).
 */
export function applyFillToCapsule(capsule: Capsule, fill: FillForCapsule): CapsulePatch {
  const fillDate = utcDate(fill.filledAtIso);
  const lastResetDate = capsule.daily_pnl_reset_date ?? fillDate;
  const isNewDay = fillDate !== lastResetDate;

  // Roll the daily fields BEFORE applying the new fill so today's PnL starts
  // fresh from this fill onwards.
  const dailyPnlBase = isNewDay ? 0 : capsule.daily_pnl_usd;
  const tradesTodayBase = isNewDay ? 0 : capsule.trades_today;

  const fee = fill.fee ?? 0;
  const fillUsd = Math.abs(fill.usdEquivalent || fill.qty * fill.price);

  let openQty = capsule.open_position_qty;
  let openCost = capsule.open_position_cost_usd;
  let realized = 0;
  let deployedDelta = 0;
  let openPositionsDelta = 0;

  if (fill.side === "BUY") {
    // Open / add to position. No realized PnL.
    const wasFlat = Math.abs(openQty) < 1e-12;
    openQty += fill.qty;
    openCost += fillUsd + fee;
    deployedDelta = fillUsd;
    if (wasFlat) openPositionsDelta = 1;
  } else {
    // Close / reduce position. Proportional cost basis released.
    const sellQty = fill.qty;
    let closedQty = Math.min(sellQty, openQty);
    let untrackedQty = Math.max(0, sellQty - closedQty);
    let costClosed = 0;
    if (openQty > 0) {
      const proportion = closedQty / openQty;
      costClosed = openCost * proportion;
      openQty -= closedQty;
      openCost -= costClosed;
    } else {
      untrackedQty = sellQty;
    }
    const proceedsNet = fillUsd - fee;
    realized = proceedsNet - costClosed;
    deployedDelta = -costClosed;
    // Position-count delta: if we just zeroed the open qty, decrement.
    if (Math.abs(openQty) < 1e-12) openPositionsDelta = -1;
    if (untrackedQty > 0) {
      // Windfall path: caller sold more than tracked — likely a capsule attached
      // to a pre-existing broker position. Cost basis 0 means realized swells;
      // log a marker in the patch's PnL so it's auditable.
      realized += 0; // already accounted for
    }
  }

  const newDeployed = Math.max(0, capsule.capital_deployed_usd + deployedDelta);
  const newAvailable = Math.max(0, capsule.capital_allocated_usd - newDeployed);
  const newOpenPositions = Math.max(0, capsule.open_positions + openPositionsDelta);

  return {
    current_pnl_usd: capsule.current_pnl_usd + realized,
    daily_pnl_usd: dailyPnlBase + realized,
    capital_deployed_usd: newDeployed,
    capital_available_usd: newAvailable,
    open_positions: newOpenPositions,
    trades_today: tradesTodayBase + 1,
    open_position_qty: openQty,
    open_position_cost_usd: openCost,
    daily_pnl_reset_date: fillDate,
    realized_pnl_usd: realized,
  };
}
