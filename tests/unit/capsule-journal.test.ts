import { describe, expect, it } from "vitest";
import { applyFillToCapsule } from "@/lib/capsules/journal";
import type { Capsule } from "@/lib/capsules/types";

function makeCapsule(over: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap-1",
    agent_id: 1,
    strategy_id: 1,
    name: "test",
    status: "live",
    capital_allocated_usd: 1000,
    capital_deployed_usd: 0,
    capital_available_usd: 1000,
    max_daily_loss_usd: 100,
    max_total_drawdown_usd: 200,
    max_position_pct: 0.5,
    max_open_positions: 5,
    max_trades_per_day: 100,
    allowed_venues: ["sim"],
    allowed_symbols: null,
    min_seconds_between_trades: 0,
    current_pnl_usd: 0,
    daily_pnl_usd: 0,
    open_positions: 0,
    trades_today: 0,
    open_position_qty: 0,
    open_position_cost_usd: 0,
    daily_pnl_reset_date: "2026-01-01",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("applyFillToCapsule — BUY opens position", () => {
  it("opens a position; no realized PnL; deploys cash", () => {
    const cap = makeCapsule();
    const patch = applyFillToCapsule(cap, {
      side: "BUY", qty: 10, price: 25, usdEquivalent: 250,
      filledAtIso: "2026-01-01T12:00:00Z",
    });
    expect(patch.realized_pnl_usd).toBe(0);
    expect(patch.daily_pnl_usd).toBe(0);
    expect(patch.capital_deployed_usd).toBe(250);
    expect(patch.capital_available_usd).toBe(750);
    expect(patch.open_position_qty).toBe(10);
    expect(patch.open_position_cost_usd).toBe(250);
    expect(patch.open_positions).toBe(1);
    expect(patch.trades_today).toBe(1);
  });

  it("includes the fee in cost basis", () => {
    const cap = makeCapsule();
    const patch = applyFillToCapsule(cap, {
      side: "BUY", qty: 10, price: 25, usdEquivalent: 250, fee: 2.5,
    });
    expect(patch.open_position_cost_usd).toBe(252.5);
  });
});

describe("applyFillToCapsule — SELL realizes PnL", () => {
  it("realizes positive PnL on a profitable round trip", () => {
    // Buy 10@25 = $250 cost
    const opened = makeCapsule({
      capital_deployed_usd: 250, capital_available_usd: 750,
      open_position_qty: 10, open_position_cost_usd: 250,
      open_positions: 1, trades_today: 1,
    });
    // Sell 10@30 = $300 proceeds → +$50 realized
    const patch = applyFillToCapsule(opened, {
      side: "SELL", qty: 10, price: 30, usdEquivalent: 300,
    });
    expect(patch.realized_pnl_usd).toBeCloseTo(50, 5);
    expect(patch.daily_pnl_usd).toBeCloseTo(50, 5);
    expect(patch.current_pnl_usd).toBeCloseTo(50, 5);
    expect(patch.open_position_qty).toBe(0);
    expect(patch.open_position_cost_usd).toBe(0);
    expect(patch.open_positions).toBe(0);
    expect(patch.capital_deployed_usd).toBe(0);
  });

  it("realizes negative PnL on a losing round trip", () => {
    const opened = makeCapsule({
      capital_deployed_usd: 250, capital_available_usd: 750,
      open_position_qty: 10, open_position_cost_usd: 250,
      open_positions: 1, trades_today: 1,
    });
    const patch = applyFillToCapsule(opened, {
      side: "SELL", qty: 10, price: 20, usdEquivalent: 200,
    });
    expect(patch.realized_pnl_usd).toBeCloseTo(-50, 5);
    expect(patch.daily_pnl_usd).toBeCloseTo(-50, 5);
  });

  it("partial sell realizes proportional cost basis", () => {
    // Position: 10 shares cost $250 ($25 avg cost)
    const opened = makeCapsule({
      capital_deployed_usd: 250,
      open_position_qty: 10, open_position_cost_usd: 250,
      open_positions: 1, trades_today: 1,
    });
    // Sell half at $30 → proceeds 150, proportional cost 125 → +25 realized
    const patch = applyFillToCapsule(opened, {
      side: "SELL", qty: 5, price: 30, usdEquivalent: 150,
    });
    expect(patch.realized_pnl_usd).toBeCloseTo(25, 5);
    expect(patch.open_position_qty).toBeCloseTo(5, 5);
    expect(patch.open_position_cost_usd).toBeCloseTo(125, 5);
    expect(patch.open_positions).toBe(1); // still open
  });
});

describe("applyFillToCapsule — daily roll", () => {
  it("resets daily_pnl_usd and trades_today on a new UTC day", () => {
    // Pretend yesterday we lost $30 over 5 trades
    const yesterday = makeCapsule({
      daily_pnl_usd: -30, trades_today: 5,
      daily_pnl_reset_date: "2026-01-01",
      open_position_qty: 10, open_position_cost_usd: 250,
      capital_deployed_usd: 250,
    });
    // Today's first fill — a sell that nets +10
    const patch = applyFillToCapsule(yesterday, {
      side: "SELL", qty: 10, price: 26, usdEquivalent: 260,
      filledAtIso: "2026-01-02T00:00:01Z",
    });
    // daily_pnl_usd resets to 0 first, then +10 from today's realized
    expect(patch.daily_pnl_usd).toBeCloseTo(10, 5);
    // trades_today resets to 0, then +1
    expect(patch.trades_today).toBe(1);
    // daily_pnl_reset_date advances
    expect(patch.daily_pnl_reset_date).toBe("2026-01-02");
    // current_pnl_usd accumulates across days (yesterday + today)
    expect(patch.current_pnl_usd).toBeCloseTo(10, 5);
  });

  it("keeps the day rolling on same-day fills", () => {
    const morning = makeCapsule({
      daily_pnl_usd: 20, trades_today: 1,
      daily_pnl_reset_date: "2026-01-01",
      open_position_qty: 10, open_position_cost_usd: 250,
      capital_deployed_usd: 250,
    });
    const patch = applyFillToCapsule(morning, {
      side: "SELL", qty: 10, price: 25.5, usdEquivalent: 255,
      filledAtIso: "2026-01-01T15:00:00Z",
    });
    expect(patch.daily_pnl_usd).toBeCloseTo(25, 5); // 20 + 5
    expect(patch.trades_today).toBe(2);
  });
});
