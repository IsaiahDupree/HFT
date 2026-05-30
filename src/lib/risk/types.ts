/**
 * Risk engine types — single shape used across venues.
 *
 * Ported from TradingBot/src/risk/{risk_engine.py, limits.py}; kept tight on
 * purpose. The Python version had extra knobs (breach handler, monitor_only,
 * day-rollover) we can grow into later — this is the v1 surface.
 */

export type RiskRejectCode =
  | "HALTED"
  | "INVALID_QTY"
  | "INVALID_PRICE"
  | "FORBIDDEN_SYMBOL"
  | "ORDER_NOTIONAL"
  | "ORDER_RATE"
  | "DAILY_LOSS"
  | "POSITION_NOTIONAL"
  | "MAX_POSITIONS"
  | "CONCENTRATION";

export type RiskCheckResult =
  | { ok: true; details: { notional: number; new_position_notional: number; requires_confirmation: boolean } }
  | { ok: false; code: RiskRejectCode; message: string; details?: Record<string, unknown> };

export type RiskLimits = {
  enabled: boolean;
  max_order_notional_usd: number;
  max_position_notional_usd: number;
  max_daily_loss_usd: number;
  max_open_positions: number;
  max_orders_per_minute: number;
  max_concentration_pct: number;       // 0..1 — fraction of equity
  require_confirmation_above_usd: number;
  forbidden_symbols: string[];
};

export type PortfolioSnapshot = {
  equity: number;
  cash: number;
  positions: Record<string, { qty: number; avg_price: number }>;
};

export type RiskCheckInput = {
  symbol: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  qty: number;
  price: number;
  portfolio: PortfolioSnapshot;
};
