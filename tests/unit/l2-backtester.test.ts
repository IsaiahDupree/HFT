/**
 * Unit tests for the event-driven L2 backtester — the mechanics that make AS
 * market-making validatable: do-nothing flatness, queue-position fill blocking,
 * latency delaying arrivals, and per-fill maker-rebate accounting.
 */
import { describe, it, expect } from "vitest";
import { L2Backtester, type MarketEvent, type Strategy } from "@/lib/backtest/l2/engine";
import { asMmStrategy, asMmDollar, doNothingStrategy } from "@/lib/backtest/l2/strategies";
import { generateSyntheticEvents } from "@/lib/backtest/l2/synthetic";

/** Strategy that places ONE order on the first book event, then never again. */
function placeOnce(side: "bid" | "ask", price: number, size: number): Strategy {
  let placed = false;
  return (bt, ev) => {
    if (ev.kind === "book" && !placed) { placed = true; bt.placeLimit(ev.ts, side, price, size); }
  };
}

describe("L2 backtester mechanics", () => {
  it("do-nothing strategy → flat PnL, no fills, no inventory", () => {
    const s = new L2Backtester().run(generateSyntheticEvents({ n: 300, seed: 1 }), doNothingStrategy);
    expect(s.nFills).toBe(0);
    expect(s.finalInventory).toBe(0);
    expect(s.pnl).toBeCloseTo(0, 9);
  });

  it("queue-ahead blocks a small trade; a larger trade fills past the queue", () => {
    const events: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 0.5, bidSz: 100, askPx: 0.52, askSz: 100 }, // queueAhead = 100
      { ts: 1, kind: "trade", price: 0.5, size: 40, aggressor: "SELL" },        // 40 < 100 → no fill
      { ts: 2, kind: "trade", price: 0.5, size: 200, aggressor: "SELL" },       // consumes 60 left + fills 50
    ];
    const s = new L2Backtester({ latencyMs: 0, feeCategory: "geopolitics" }).run(events, placeOnce("bid", 0.5, 50));
    expect(s.nFills).toBe(1);
    expect(s.finalInventory).toBe(50); // bought 50 at our bid
  });

  it("latency delays order arrival — a trade before arrival does not fill", () => {
    const events: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 0.5, bidSz: 0, askPx: 0.52, askSz: 0 }, // queueAhead 0
      { ts: 0.5, kind: "trade", price: 0.5, size: 10, aggressor: "SELL" },  // order arrives ts 1.0 > 0.5
    ];
    const s = new L2Backtester({ latencyMs: 1000 }).run(events, placeOnce("bid", 0.5, 10));
    expect(s.nFills).toBe(0);
  });

  it("maker fill banks a rebate in a rebate-paying category (Finance 50%)", () => {
    const events: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 0.5, bidSz: 0, askPx: 0.52, askSz: 0 },
      { ts: 1, kind: "trade", price: 0.5, size: 50, aggressor: "SELL" },
    ];
    const s = new L2Backtester({ latencyMs: 0, feeCategory: "finance" }).run(events, placeOnce("bid", 0.5, 50));
    expect(s.nFills).toBe(1);
    expect(s.rebatesReceived).toBeGreaterThan(0);
    expect(s.feesPaid).toBe(0); // maker pays no taker fee
  });

  it("AS-logit maker (spread-calibrated params) produces fills and stays finite", () => {
    // params chosen so the logit half-spread quotes INSIDE the 0.03 market spread —
    // i.e. the maker improves the book and gets hit. Wide/uncalibrated params
    // (e.g. σ=0.4) quote far outside and never fill: that's the handbook's point.
    const s = new L2Backtester({ latencyMs: 50, feeCategory: "finance" })
      .run(generateSyntheticEvents({ n: 1500, seed: 7, spread: 0.03, tradeProb: 0.45 }), asMmStrategy({ gamma: 1, sigma: 0.05, kappa: 80, T: 1 }, { size: 20 }));
    expect(s.nFills).toBeGreaterThan(0);
    expect(Number.isFinite(s.pnl)).toBe(true);
  });
});

describe("asMmDollar + flat-bps fees (continuous venues / dYdX)", () => {
  it("quotes around mid in DOLLAR space (no 0/1 clamp) and skews against inventory", () => {
    const placed: Array<{ side: string; price: number }> = [];
    const mockBt: any = { book: { bidPx: 99, bidSz: 1, askPx: 101, askSz: 1 }, inventory: 0, tick: 1, cancel: () => {}, placeLimit: (_t: number, side: string, price: number) => { placed.push({ side, price }); return 1; } };
    const strat = asMmDollar({ size: 0.01, baseSpreadBps: 1, maxNotional: 10_000 });
    strat(mockBt, { ts: 0, kind: "book" } as MarketEvent);
    const bid = placed.find((p) => p.side === "bid")!, ask = placed.find((p) => p.side === "ask")!;
    expect(bid.price).toBeGreaterThan(50); expect(bid.price).toBeLessThan(100);   // dollar-range, NOT clamped to ~1
    expect(ask.price).toBeGreaterThan(100); expect(ask.price).toBeLessThan(150);
    placed.length = 0; mockBt.inventory = 50;                                       // long → reservation skews DOWN
    strat(mockBt, { ts: 1, kind: "book" } as MarketEvent);
    const bid2 = placed.find((p) => p.side === "bid");
    expect(bid2 === undefined || bid2.price < bid.price).toBe(true);
  });

  it("feeBps mode pays a flat-bps maker rebate (negative bps) instead of the binary curve", () => {
    const events: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 100, bidSz: 0, askPx: 101, askSz: 0 }, // queueAhead 0 at our bid
      { ts: 1, kind: "trade", price: 100, size: 50, aggressor: "SELL" },   // sells into the bid → maker fill
    ];
    const s = new L2Backtester({ latencyMs: 0, tick: 1, feeBps: { maker: -1, taker: 5 } }).run(events, placeOnce("bid", 100, 50));
    expect(s.nMakerFills).toBeGreaterThan(0);
    const filledQty = s.fills.filter((f) => f.isMaker).reduce((a, f) => a + f.qty, 0);
    expect(s.rebatesReceived).toBeCloseTo((1 / 1e4) * 100 * filledQty, 6); // -1bps maker = +rebate on $100 notional × qty
  });
});
