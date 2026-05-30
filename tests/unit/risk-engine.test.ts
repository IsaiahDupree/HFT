import { describe, expect, it } from "vitest";
import { RiskEngine, emptyPortfolio } from "@/lib/risk/engine";
import type { RiskLimits } from "@/lib/risk/types";

function makeEngine(overrides: Partial<RiskLimits> = {}): RiskEngine {
  const defaults: RiskLimits = {
    enabled: true,
    max_order_notional_usd: 100,
    max_position_notional_usd: 500,
    max_daily_loss_usd: 50,
    max_open_positions: 3,
    max_orders_per_minute: 5,
    max_concentration_pct: 0.5,
    require_confirmation_above_usd: 80,
    forbidden_symbols: ["BADCOIN"],
  };
  return new RiskEngine({ ...defaults, ...overrides });
}

describe("RiskEngine.check — basic gates", () => {
  it("approves a well-sized order on a clean portfolio", () => {
    const engine = makeEngine();
    const r = engine.check({ symbol: "BTC-USD", side: "BUY", qty: 1, price: 50, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.details.notional).toBe(50);
      expect(r.details.requires_confirmation).toBe(false);
    }
  });

  it("rejects when halted", () => {
    const engine = makeEngine();
    engine.setHalted(true, "manual");
    const r = engine.check({ symbol: "BTC-USD", side: "BUY", qty: 1, price: 10, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HALTED");
  });

  it.each([
    { qty: 0, code: "INVALID_QTY" as const },
    { qty: -1, code: "INVALID_QTY" as const },
  ])("rejects qty=$qty with $code", ({ qty, code }) => {
    const engine = makeEngine();
    const r = engine.check({ symbol: "BTC-USD", side: "BUY", qty, price: 10, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("rejects price <= 0", () => {
    const engine = makeEngine();
    const r = engine.check({ symbol: "BTC-USD", side: "BUY", qty: 1, price: 0, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PRICE");
  });

  it("rejects forbidden symbols (case-insensitive)", () => {
    const engine = makeEngine();
    const r = engine.check({ symbol: "badcoin", side: "BUY", qty: 1, price: 10, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORBIDDEN_SYMBOL");
  });

  it("rejects ORDER_NOTIONAL when notional > max_order_notional_usd", () => {
    const engine = makeEngine({ max_order_notional_usd: 50 });
    const r = engine.check({ symbol: "X", side: "BUY", qty: 10, price: 6, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ORDER_NOTIONAL");
  });

  it("requires_confirmation flag flips above threshold", () => {
    const engine = makeEngine({ require_confirmation_above_usd: 50 });
    const r = engine.check({ symbol: "X", side: "BUY", qty: 1, price: 75, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.details.requires_confirmation).toBe(true);
  });
});

describe("RiskEngine.check — position + concentration", () => {
  it("rejects POSITION_NOTIONAL when projected position exceeds cap", () => {
    const engine = makeEngine({ max_position_notional_usd: 50, max_order_notional_usd: 1000 });
    const portfolio = { equity: 1000, cash: 1000, positions: { BTC: { qty: 1, avg_price: 30 } } };
    const r = engine.check({ symbol: "BTC", side: "BUY", qty: 2, price: 30, portfolio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POSITION_NOTIONAL");
  });

  it("rejects MAX_POSITIONS when opening would exceed limit", () => {
    const engine = makeEngine({ max_open_positions: 2 });
    const portfolio = {
      equity: 1000, cash: 1000,
      positions: { A: { qty: 1, avg_price: 10 }, B: { qty: 1, avg_price: 10 } },
    };
    const r = engine.check({ symbol: "C", side: "BUY", qty: 1, price: 10, portfolio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MAX_POSITIONS");
  });

  it("rejects CONCENTRATION when new position exceeds pct of equity", () => {
    const engine = makeEngine({ max_concentration_pct: 0.1, max_position_notional_usd: 99999 });
    const portfolio = { equity: 100, cash: 100, positions: {} };
    const r = engine.check({ symbol: "X", side: "BUY", qty: 1, price: 20, portfolio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONCENTRATION");
  });
});

describe("RiskEngine.check — daily loss", () => {
  it("trips DAILY_LOSS when equity drops below baseline by more than max_daily_loss_usd", () => {
    const engine = makeEngine({ max_daily_loss_usd: 25 });
    // First check establishes the day-start equity baseline.
    const p0 = { equity: 1000, cash: 1000, positions: {} };
    expect(engine.check({ symbol: "X", side: "BUY", qty: 1, price: 10, portfolio: p0 }).ok).toBe(true);
    // Now equity has fallen by $30 — daily loss exceeds $25 cap.
    const p1 = { equity: 970, cash: 970, positions: {} };
    const r = engine.check({ symbol: "X", side: "BUY", qty: 1, price: 10, portfolio: p1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DAILY_LOSS");
  });
});

describe("RiskEngine.check — rate limit", () => {
  it("rejects ORDER_RATE after max_orders_per_minute approvals in the same window", () => {
    const engine = makeEngine({ max_orders_per_minute: 3, max_order_notional_usd: 9999 });
    const portfolio = { equity: 1_000_000, cash: 1_000_000, positions: {} };
    for (let i = 0; i < 3; i++) {
      const r = engine.check({ symbol: `S${i}`, side: "BUY", qty: 1, price: 1, portfolio });
      expect(r.ok).toBe(true);
    }
    const r = engine.check({ symbol: "OVERFLOW", side: "BUY", qty: 1, price: 1, portfolio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ORDER_RATE");
  });
});

describe("RiskEngine — disabled short-circuit", () => {
  it("approves anything when limits.enabled=false", () => {
    const engine = makeEngine({ enabled: false, max_order_notional_usd: 0.01 });
    const r = engine.check({ symbol: "X", side: "BUY", qty: 1000, price: 1000, portfolio: emptyPortfolio() });
    expect(r.ok).toBe(true);
  });
});
