import { describe, expect, it } from "vitest";
import { checkOrder } from "@/lib/capsules/gate";
import type { Capsule } from "@/lib/capsules/types";

function makeCapsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap-1",
    agent_id: 1,
    strategy_id: 1,
    name: "Test capsule",
    status: "live",
    capital_allocated_usd: 1000,
    capital_deployed_usd: 0,
    capital_available_usd: 1000,
    max_daily_loss_usd: 100,
    max_total_drawdown_usd: 200,
    max_position_pct: 0.5,
    max_open_positions: 3,
    max_trades_per_day: 10,
    allowed_venues: ["polymarket", "coinbase"],
    allowed_symbols: null,
    min_seconds_between_trades: 0,
    current_pnl_usd: 0,
    daily_pnl_usd: 0,
    open_positions: 0,
    trades_today: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseInput = {
  venue: "coinbase",
  symbol: "BTC-USD",
  side: "BUY" as const,
  qty: 1,
  refPrice: 100,
};

describe("capsule gate — active status", () => {
  it.each(["draft", "paused", "stopped", "closed"] as const)("rejects when status=%s", (status) => {
    const r = checkOrder({ ...baseInput, capsule: makeCapsule({ status }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_NOT_ACTIVE");
  });

  it.each(["live", "paper"] as const)("allows when status=%s", (status) => {
    const r = checkOrder({ ...baseInput, capsule: makeCapsule({ status, max_position_pct: 0 }) });
    expect(r.ok).toBe(true);
  });
});

describe("capsule gate — allowed venues / symbols", () => {
  it("rejects when venue not in allowed_venues", () => {
    const r = checkOrder({ ...baseInput, venue: "binance", capsule: makeCapsule() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_VENUE_NOT_ALLOWED");
  });

  it("allows any venue when allowed_venues is empty", () => {
    const r = checkOrder({ ...baseInput, venue: "binance", capsule: makeCapsule({ allowed_venues: [], max_position_pct: 0 }) });
    expect(r.ok).toBe(true);
  });

  it("rejects when symbol not in allowed_symbols", () => {
    const r = checkOrder({ ...baseInput, symbol: "ETH-USD", capsule: makeCapsule({ allowed_symbols: ["BTC-USD"], max_position_pct: 0 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_SYMBOL_NOT_ALLOWED");
  });
});

describe("capsule gate — position pct cap", () => {
  it("rejects buy that would breach max_position_pct", () => {
    // capital_allocated=$1000, max_position_pct=0.5 ⇒ max deployable $500
    // capital_deployed=$400, new order 2 * $100 = $200 ⇒ projected $600 > $500
    const cap = makeCapsule({ capital_allocated_usd: 1000, capital_deployed_usd: 400, max_position_pct: 0.5 });
    const r = checkOrder({ ...baseInput, qty: 2, refPrice: 100, capsule: cap });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_MAX_POSITION_PCT");
  });

  it("allows sell even when capsule is at position cap (sells reduce deployed)", () => {
    const cap = makeCapsule({ capital_allocated_usd: 1000, capital_deployed_usd: 500, max_position_pct: 0.5 });
    const r = checkOrder({ ...baseInput, side: "SELL", qty: 100, refPrice: 100, capsule: cap });
    expect(r.ok).toBe(true);
  });
});

describe("capsule gate — daily loss + count caps", () => {
  it("rejects when daily_pnl <= -max_daily_loss_usd", () => {
    const cap = makeCapsule({ daily_pnl_usd: -120, max_daily_loss_usd: 100, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_DAILY_LOSS");
  });

  it("rejects when current_pnl <= -max_total_drawdown_usd (bug #12)", () => {
    const cap = makeCapsule({ current_pnl_usd: -250, max_total_drawdown_usd: 200, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_TOTAL_DRAWDOWN");
  });

  it("allows when current_pnl just above the total-drawdown cap", () => {
    const cap = makeCapsule({ current_pnl_usd: -150, max_total_drawdown_usd: 200, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(true);
  });

  it("rejects when open_positions >= max_open_positions", () => {
    const cap = makeCapsule({ open_positions: 3, max_open_positions: 3, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_MAX_OPEN_POSITIONS");
  });

  it("rejects when trades_today >= max_trades_per_day", () => {
    const cap = makeCapsule({ trades_today: 10, max_trades_per_day: 10, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_MAX_TRADES_PER_DAY");
  });
});

describe("capsule gate — cooldown", () => {
  it("rejects when secondsSinceLastTrade < min_seconds_between_trades", () => {
    const cap = makeCapsule({ min_seconds_between_trades: 60, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap, secondsSinceLastTrade: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CAPSULE_COOLDOWN");
  });

  it("allows when secondsSinceLastTrade >= min_seconds_between_trades", () => {
    const cap = makeCapsule({ min_seconds_between_trades: 60, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap, secondsSinceLastTrade: 90 });
    expect(r.ok).toBe(true);
  });

  it("allows when no cooldown configured (min_seconds_between_trades=0)", () => {
    const cap = makeCapsule({ min_seconds_between_trades: 0, max_position_pct: 0 });
    const r = checkOrder({ ...baseInput, capsule: cap });
    expect(r.ok).toBe(true);
  });
});
