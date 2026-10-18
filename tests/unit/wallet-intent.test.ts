import { describe, expect, it } from "vitest";
import { classifyIntent, type IntentTrade } from "@/lib/wallets/intent";

const NOW = Date.parse("2026-05-25T12:00:00Z");

function t(side: "BUY" | "SELL", marketKey: string, opts: Partial<IntentTrade> = {}): IntentTrade {
  return {
    marketKey,
    side,
    outcome: opts.outcome ?? "YES",
    price: opts.price ?? 0.5,
    usd: opts.usd ?? 100,
    ts: opts.ts ?? new Date(NOW - 10 * 60_000).toISOString(),
    ...opts,
  };
}

describe("classifyIntent", () => {
  it("returns 'idle' when no trades in window", () => {
    const out = classifyIntent([], { nowMs: NOW });
    expect(out.label).toBe("idle");
    expect(out.tradesObserved).toBe(0);
  });

  it("returns 'idle' when all trades are outside the window", () => {
    const old = t("BUY", "m1", { ts: new Date(NOW - 2 * 60 * 60_000).toISOString() });
    const out = classifyIntent([old], { windowMinutes: 60, nowMs: NOW });
    expect(out.label).toBe("idle");
  });

  it("returns 'mixed' with low confidence on < 3 recent trades", () => {
    const out = classifyIntent([t("BUY", "m1"), t("BUY", "m1")], { nowMs: NOW });
    expect(out.label).toBe("mixed");
    expect(out.confidence).toBeLessThan(0.5);
    expect(out.tradesObserved).toBe(2);
  });

  it("classifies 'accumulation' on overwhelming BUYs on ≤2 markets", () => {
    const trades: IntentTrade[] = [
      t("BUY", "m1"), t("BUY", "m1"), t("BUY", "m1"), t("BUY", "m1"), t("BUY", "m2"),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("accumulation");
    expect(out.buyShare).toBe(1);
    expect(out.distinctMarkets).toBe(2);
  });

  it("classifies 'distribution' on overwhelming SELLs on ≤2 markets", () => {
    const trades: IntentTrade[] = [
      t("SELL", "m1"), t("SELL", "m1"), t("SELL", "m1"), t("SELL", "m2"),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("distribution");
    expect(out.sellShare).toBe(1);
  });

  it("classifies 'basket_rotation' on ≥3 distinct markets in window (the @0xb55fa pattern)", () => {
    const trades: IntentTrade[] = [
      t("BUY", "btc"), t("BUY", "eth"), t("BUY", "sol"), t("BUY", "xrp"), t("BUY", "doge"),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("basket_rotation");
    expect(out.distinctMarkets).toBe(5);
  });

  it("'basket_rotation' wins over 'accumulation' when both could apply", () => {
    // 5 distinct markets, all BUYs — both labels could fire, but basket
    // rotation is the more specific signal.
    const trades: IntentTrade[] = [
      t("BUY", "btc"), t("BUY", "eth"), t("BUY", "sol"), t("BUY", "xrp"), t("BUY", "ada"),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("basket_rotation");
  });

  it("classifies 'scalp' on single market with both BUY and SELL", () => {
    const trades: IntentTrade[] = [
      t("BUY", "m1"), t("BUY", "m1"), t("SELL", "m1"), t("SELL", "m1"),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("scalp");
    expect(out.distinctMarkets).toBe(1);
  });

  it("classifies 'news_fade' on a large trade at extreme price", () => {
    // Mixed buy/sell on 2 markets so accumulation/distribution/basket_rotation
    // don't fire — leaves news_fade to catch the extreme-price big trade.
    const trades: IntentTrade[] = [
      t("BUY", "m1", { usd: 100, price: 0.50 }),
      t("SELL", "m1", { usd: 100, price: 0.50 }),
      t("BUY", "m2", { usd: 100, price: 0.50 }),
      t("BUY", "m1", { usd: 5_000, price: 0.92 }),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("news_fade");
    expect(out.reasons[0]).toContain("extreme price");
  });

  it("returns 'mixed' when no dominant pattern applies", () => {
    const trades: IntentTrade[] = [
      t("BUY", "m1", { usd: 50 }),
      t("SELL", "m2", { usd: 50 }),
      t("BUY", "m1", { usd: 50 }),
    ];
    const out = classifyIntent(trades, { nowMs: NOW });
    expect(out.label).toBe("mixed");
  });

  it("respects windowMinutes — trades older than window are excluded", () => {
    const trades: IntentTrade[] = [
      t("BUY", "m1", { ts: new Date(NOW - 90 * 60_000).toISOString() }), // 90min ago
      t("BUY", "m1", { ts: new Date(NOW - 10 * 60_000).toISOString() }),
      t("BUY", "m1", { ts: new Date(NOW - 5 * 60_000).toISOString() }),
    ];
    const out = classifyIntent(trades, { windowMinutes: 60, nowMs: NOW });
    expect(out.tradesObserved).toBe(2);
  });
});
