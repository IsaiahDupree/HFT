import type { RiskLimits } from "./types";

/**
 * Load global risk limits from environment.
 *
 * Per-venue caps still live in their own envs (MAX_TRADE_USD,
 * COINBASE_MAX_TRADE_USD) because they pre-date the unified engine and we
 * don't want to silently relax them. Once the venue router fully owns
 * execution, those can be folded into RISK_* and dropped from each adapter.
 */
export function loadLimits(): RiskLimits {
  return {
    enabled: process.env.RISK_DISABLED === "1" ? false : true,
    max_order_notional_usd: num("RISK_MAX_ORDER_USD", 250),
    max_position_notional_usd: num("RISK_MAX_POSITION_USD", 1000),
    max_daily_loss_usd: num("RISK_MAX_DAILY_LOSS_USD", 200),
    max_open_positions: num("RISK_MAX_OPEN_POSITIONS", 20),
    max_orders_per_minute: num("RISK_MAX_ORDERS_PER_MIN", 60),
    max_concentration_pct: num("RISK_MAX_CONCENTRATION_PCT", 0.25),
    require_confirmation_above_usd: num("RISK_CONFIRM_ABOVE_USD", 100),
    forbidden_symbols: list("RISK_FORBIDDEN_SYMBOLS"),
  };
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
