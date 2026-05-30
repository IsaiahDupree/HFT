import { loadLimits } from "./limits";
import type {
  PortfolioSnapshot,
  RiskCheckInput,
  RiskCheckResult,
  RiskLimits,
  RiskRejectCode,
} from "./types";

/**
 * Pre-trade risk gate. Every order through the venue router goes through
 * RiskEngine.check() before adapter submit. Ported from
 * TradingBot/src/risk/risk_engine.py, trimmed to the checks that matter for
 * a single-operator Polymarket/Coinbase stack.
 *
 * Stateful pieces:
 *   - `halted` flag (toggled by KillSwitch)
 *   - rolling order-time deque for per-minute rate limit
 *   - daily-loss start-of-day equity baseline (set on first check each UTC day)
 */
export class RiskEngine {
  private limits: RiskLimits;
  private halted = false;
  private haltReason = "";
  private orderTimes: number[] = [];
  private dayStartEquity: number | null = null;
  private dayStartDate: string | null = null;
  private lastRejection: { code: RiskRejectCode; message: string } | null = null;

  constructor(limits?: RiskLimits) {
    this.limits = limits ?? loadLimits();
  }

  // ---------------------------------------------------------------- state

  setHalted(halted: boolean, reason = ""): void {
    this.halted = halted;
    this.haltReason = halted ? reason : "";
  }

  isHalted(): boolean {
    return this.halted;
  }

  getHaltReason(): string {
    return this.haltReason;
  }

  updateLimits(limits: RiskLimits): void {
    this.limits = limits;
  }

  getLimits(): RiskLimits {
    return this.limits;
  }

  getLastRejection(): { code: RiskRejectCode; message: string } | null {
    return this.lastRejection;
  }

  /** Reset day-PNL tracker so the next check captures a fresh baseline.
   *  Called after KillSwitch.resume() so a DAILY_LOSS halt doesn't immediately
   *  re-trip on the same baseline. */
  forceRollDay(): void {
    this.dayStartDate = null;
    this.dayStartEquity = null;
  }

  // ---------------------------------------------------------------- check

  check(input: RiskCheckInput): RiskCheckResult {
    if (!this.limits.enabled) return ok(input.qty * input.price);

    if (this.halted) {
      return this.reject("HALTED", `Trading is halted: ${this.haltReason || "kill switch engaged"}`);
    }
    if (input.qty <= 0) return this.reject("INVALID_QTY", "Order qty must be positive");
    if (input.price <= 0) return this.reject("INVALID_PRICE", "Reference price must be positive");

    const sym = input.symbol.toUpperCase();
    if (this.limits.forbidden_symbols.map((s) => s.toUpperCase()).includes(sym)) {
      return this.reject("FORBIDDEN_SYMBOL", `${input.symbol} is on the forbidden list`, { symbol: input.symbol });
    }

    const notional = input.qty * input.price;
    if (notional > this.limits.max_order_notional_usd) {
      return this.reject(
        "ORDER_NOTIONAL",
        `Order notional $${notional.toFixed(2)} exceeds max $${this.limits.max_order_notional_usd}`,
        { notional, limit: this.limits.max_order_notional_usd },
      );
    }

    const nowMs = Date.now();
    const cutoff = nowMs - 60_000;
    while (this.orderTimes.length && this.orderTimes[0] < cutoff) this.orderTimes.shift();
    if (this.orderTimes.length >= this.limits.max_orders_per_minute) {
      return this.reject("ORDER_RATE", `Order rate exceeds ${this.limits.max_orders_per_minute}/min`, {
        recent_orders: this.orderTimes.length,
      });
    }

    const equity = Number(input.portfolio.equity ?? 0);
    this.maybeRollDay(equity);

    // Daily-loss check
    if (this.dayStartEquity != null && this.dayStartEquity > 0) {
      const dayPnl = equity - this.dayStartEquity;
      if (dayPnl <= -Math.abs(this.limits.max_daily_loss_usd)) {
        return this.reject(
          "DAILY_LOSS",
          `Daily loss $${(-dayPnl).toFixed(2)} exceeds limit $${this.limits.max_daily_loss_usd}`,
          { day_pnl: dayPnl, day_start_equity: this.dayStartEquity },
        );
      }
    }

    // Resulting position
    const existing = input.portfolio.positions[input.symbol] ?? input.portfolio.positions[sym] ?? null;
    const existingQty = Number(existing?.qty ?? 0);
    const signedQty = sideIsBuy(input.side) ? input.qty : -input.qty;
    const newQty = existingQty + signedQty;
    const newNotional = Math.abs(newQty) * input.price;

    if (newNotional > this.limits.max_position_notional_usd) {
      return this.reject(
        "POSITION_NOTIONAL",
        `Position notional $${newNotional.toFixed(2)} exceeds max $${this.limits.max_position_notional_usd}`,
        { new_position_notional: newNotional, limit: this.limits.max_position_notional_usd },
      );
    }

    const opensNewPosition = existingQty === 0 && newQty !== 0;
    if (opensNewPosition) {
      const currentOpen = Object.values(input.portfolio.positions).filter(
        (p) => Math.abs(Number(p.qty ?? 0)) > 0,
      ).length;
      if (currentOpen + 1 > this.limits.max_open_positions) {
        return this.reject(
          "MAX_POSITIONS",
          `Opening would exceed max open positions (${this.limits.max_open_positions})`,
          { current_open: currentOpen },
        );
      }
    }

    if (equity > 0) {
      const concentration = newNotional / equity;
      if (concentration > this.limits.max_concentration_pct) {
        return this.reject(
          "CONCENTRATION",
          `Concentration ${(concentration * 100).toFixed(1)}% exceeds max ${(this.limits.max_concentration_pct * 100).toFixed(1)}%`,
          { concentration, limit: this.limits.max_concentration_pct },
        );
      }
    }

    this.orderTimes.push(nowMs);
    return ok(notional, newNotional, notional >= this.limits.require_confirmation_above_usd);
  }

  // -------------------------------------------------------------- helpers

  private maybeRollDay(currentEquity: number): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dayStartDate !== today) {
      this.dayStartDate = today;
      this.dayStartEquity = currentEquity;
    }
  }

  private reject(code: RiskRejectCode, message: string, details?: Record<string, unknown>): RiskCheckResult {
    this.lastRejection = { code, message };
    return { ok: false, code, message, details };
  }
}

function sideIsBuy(side: RiskCheckInput["side"]): boolean {
  return side.toLowerCase() === "buy";
}

function ok(notional: number, newPositionNotional?: number, requiresConfirm = false): RiskCheckResult {
  return {
    ok: true,
    details: {
      notional,
      new_position_notional: newPositionNotional ?? notional,
      requires_confirmation: requiresConfirm,
    },
  };
}

// ----------------------------------------------------------- empty portfolio

export function emptyPortfolio(): PortfolioSnapshot {
  return { equity: 0, cash: 0, positions: {} };
}

// ------------------------------------------------------------------- singleton

let defaultEngine: RiskEngine | null = null;

export function getDefaultRiskEngine(): RiskEngine {
  if (!defaultEngine) defaultEngine = new RiskEngine();
  return defaultEngine;
}

export function resetDefaultRiskEngineForTests(): void {
  defaultEngine = null;
}
