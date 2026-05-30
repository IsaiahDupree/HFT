import type { Capsule, CapsuleCheckCode, CapsuleCheckResult } from "./types";

/**
 * Per-order capsule gate. Pure, sync, dependency-free — easy to unit test.
 * Ported from TradingBot/src/capsules/gate.py.
 *
 * Caller responsibilities:
 *   - Look up capsule via store.get(id) (NOT_FOUND is the caller's check).
 *   - Track cooldowns externally and pass `secondsSinceLastTrade` if relevant.
 *
 * Returns:
 *   { ok: true }                         → order may proceed to the global RiskEngine
 *   { ok: false, code: ..., reason: ...} → router rejects with code & reason copied
 *                                          into evolution_log.payload_json
 */
export function checkOrder(input: {
  capsule: Capsule;
  venue: string;
  symbol: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  qty: number;
  refPrice: number;
  secondsSinceLastTrade?: number;
}): CapsuleCheckResult {
  const c = input.capsule;
  const side = input.side.toLowerCase();

  if (!isActive(c)) {
    return fail("CAPSULE_NOT_ACTIVE", `capsule ${c.id} status=${c.status}, not paper/live`);
  }

  if (c.allowed_venues.length > 0 && !c.allowed_venues.includes(input.venue)) {
    return fail("CAPSULE_VENUE_NOT_ALLOWED", `venue ${input.venue} not in capsule allowed_venues ${JSON.stringify(c.allowed_venues)}`);
  }

  if (c.allowed_symbols != null && !c.allowed_symbols.includes(input.symbol)) {
    return fail("CAPSULE_SYMBOL_NOT_ALLOWED", `symbol ${input.symbol} not in capsule allowed_symbols`);
  }

  if (c.max_open_positions > 0 && c.open_positions >= c.max_open_positions) {
    return fail("CAPSULE_MAX_OPEN_POSITIONS", `open_positions ${c.open_positions} >= cap ${c.max_open_positions}`);
  }

  if (c.max_trades_per_day > 0 && c.trades_today >= c.max_trades_per_day) {
    return fail("CAPSULE_MAX_TRADES_PER_DAY", `trades_today ${c.trades_today} >= cap ${c.max_trades_per_day}`);
  }

  // max_position_pct only binds on buys (sells reduce deployed capital, so
  // can never trip the cap; pre-fix in TradingBot this rejected exits).
  if (side === "buy" && c.max_position_pct > 0 && c.capital_allocated_usd > 0 && input.refPrice > 0) {
    const orderNotional = Math.abs(input.qty) * input.refPrice;
    const projectedDeployed = c.capital_deployed_usd + orderNotional;
    const projectedPct = projectedDeployed / c.capital_allocated_usd;
    if (projectedPct > c.max_position_pct) {
      return fail(
        "CAPSULE_MAX_POSITION_PCT",
        `adding $${orderNotional.toFixed(2)} would breach max_position_pct ${(c.max_position_pct * 100).toFixed(0)}% of capsule capital`,
      );
    }
  }

  // Realized daily loss cap (capsule-level, separate from RiskEngine's global cap).
  if (c.max_daily_loss_usd > 0 && c.daily_pnl_usd <= -Math.abs(c.max_daily_loss_usd)) {
    return fail(
      "CAPSULE_DAILY_LOSS",
      `capsule daily_pnl $${c.daily_pnl_usd.toFixed(2)} <= -max_daily_loss_usd $${c.max_daily_loss_usd.toFixed(2)}`,
    );
  }

  // Realized total drawdown cap — capsule cumulative PnL since allocation.
  // Pre-2026-05-26: this cap was stored on the capsule but never enforced
  // (bug #12). A capsule could lose past its configured total-loss limit
  // without the gate intervening; only daily_pnl_usd was being checked.
  if (c.max_total_drawdown_usd > 0 && c.current_pnl_usd <= -Math.abs(c.max_total_drawdown_usd)) {
    return fail(
      "CAPSULE_TOTAL_DRAWDOWN",
      `capsule current_pnl $${c.current_pnl_usd.toFixed(2)} <= -max_total_drawdown_usd $${c.max_total_drawdown_usd.toFixed(2)}`,
    );
  }

  // Cooldown: caller passes the elapsed time since the last trade on this
  // (symbol, side). Cheaper than tracking per-capsule state inside the gate.
  if (
    c.min_seconds_between_trades > 0 &&
    input.secondsSinceLastTrade != null &&
    input.secondsSinceLastTrade < c.min_seconds_between_trades
  ) {
    return fail(
      "CAPSULE_COOLDOWN",
      `cooldown: ${input.secondsSinceLastTrade.toFixed(1)}s elapsed, need ${c.min_seconds_between_trades.toFixed(1)}s`,
    );
  }

  return { ok: true };
}

function isActive(c: Capsule): boolean {
  return c.status === "paper" || c.status === "live";
}

function fail(code: CapsuleCheckCode, reason: string): CapsuleCheckResult {
  return { ok: false, code, reason };
}
