import { describe, it, expect } from "vitest";
import { L2Backtester, type MarketEvent } from "@/lib/backtest/l2/engine";
import { asMmDollar } from "@/lib/backtest/l2/strategies";

const book = (over: Partial<{ bidPx: number; bidSz: number; askPx: number; askSz: number }> = {}): MarketEvent =>
  ({ ts: 0, kind: "book", bidPx: 99, bidSz: 10, askPx: 101, askSz: 10, ...over });

const OPTS = { size: 1, baseSpreadBps: 1.5, maxNotional: 20_000, gamma: 1.0 };

/** Drive one book event with a given starting inventory; return the resting quotes. */
function quote(inventory = 0, over = {}, opts = OPTS) {
  const bt = new L2Backtester({ latencyMs: 0, tick: 1, feeBps: { maker: 0, taker: 5 } });
  bt.inventory = inventory;
  bt.run([book(over)], asMmDollar(opts));
  const orders = [...bt.orders.values()];
  return { bid: orders.find((o) => o.side === "bid"), ask: orders.find((o) => o.side === "ask") };
}

describe("asMmDollar — quoting", () => {
  it("posts a two-sided quote around mid, snapped to the tick grid, non-crossed", () => {
    const { bid, ask } = quote();                 // mid 100, market half-spread 1 dominates
    expect(bid?.price).toBe(99);
    expect(ask?.price).toBe(101);
    expect(bid!.price).toBeLessThan(ask!.price);
  });

  it("skews the reservation DOWN when long (sells inventory cheaper, buys less eagerly)", () => {
    const flat = quote(0);
    const long = quote(100);                       // invNotional 100·100 = 10k = half the cap
    expect(long.bid!.price).toBeLessThan(flat.bid!.price);
    expect(long.ask!.price).toBeLessThan(flat.ask!.price);
  });

  it("skews the reservation UP when short (mirror of long)", () => {
    const flat = quote(0);
    const short = quote(-100);
    expect(short.bid!.price).toBeGreaterThan(flat.bid!.price);
    expect(short.ask!.price).toBeGreaterThan(flat.ask!.price);
  });

  it("drops the BID once inventory notional hits +maxNotional (stop buying)", () => {
    const { bid, ask } = quote(300);               // invNotional 30k > 20k cap
    expect(bid).toBeUndefined();
    expect(ask).toBeDefined();
  });

  it("drops the ASK once inventory notional hits −maxNotional (stop selling)", () => {
    const { bid, ask } = quote(-300);
    expect(ask).toBeUndefined();
    expect(bid).toBeDefined();
  });

  it("withdraws entirely on a degenerate/crossed book", () => {
    const { bid, ask } = quote(0, { bidPx: 100, askPx: 100 }); // ask ≤ bid
    expect(bid).toBeUndefined();
    expect(ask).toBeUndefined();
  });

  it("is deterministic for identical inputs", () => {
    expect(quote(50)).toEqual(quote(50));
  });
});

describe("L2 engine — feeBps continuous-venue accounting", () => {
  // A resting bid at 99, then a SELL large enough to clear the queue ahead and fill us.
  function fillBid(makerBps: number) {
    const bt = new L2Backtester({ latencyMs: 0, tick: 1, feeBps: { maker: makerBps, taker: 5 } });
    let placed = false;
    const evs: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 99, bidSz: 10, askPx: 101, askSz: 10 },
      { ts: 1, kind: "trade", price: 99, size: 15, aggressor: "SELL" }, // 15 > queueAhead 10 → fills 5
    ];
    return bt.run(evs, (b, ev) => { if (ev.kind === "book" && !placed) { placed = true; b.placeLimit(ev.ts, "bid", 99, 5); } });
  }

  it("a maker fill with a NEGATIVE maker bps earns a rebate and goes long", () => {
    const s = fillBid(-1.1);
    expect(s.nFills).toBe(1);
    expect(s.nMakerFills).toBe(1);
    expect(s.nTakerFills).toBe(0);
    expect(s.finalInventory).toBe(5);
    expect(s.rebatesReceived).toBeCloseTo(1.1 / 1e4 * 5 * 99, 9); // +rebate on notional
  });

  it("a maker fill with a POSITIVE maker bps pays a fee (negative 'rebate')", () => {
    const s = fillBid(2);
    expect(s.rebatesReceived).toBeCloseTo(-2 / 1e4 * 5 * 99, 9);
  });

  it("a trade smaller than the queue ahead does NOT fill us (queue position respected)", () => {
    const bt = new L2Backtester({ latencyMs: 0, tick: 1, feeBps: { maker: 0, taker: 5 } });
    let placed = false;
    const s = bt.run([
      { ts: 0, kind: "book", bidPx: 99, bidSz: 10, askPx: 101, askSz: 10 },
      { ts: 1, kind: "trade", price: 99, size: 4, aggressor: "SELL" }, // 4 < queueAhead 10 → no fill
    ], (b, ev) => { if (ev.kind === "book" && !placed) { placed = true; b.placeLimit(ev.ts, "bid", 99, 5); } });
    expect(s.nFills).toBe(0);
    expect(s.finalInventory).toBe(0);
  });

  it("PnL marks final inventory to the current mid", () => {
    const s = fillBid(0);             // bought 5 @ 99, no fee/rebate → cash −495, inv 5
    expect(s.finalInventory).toBe(5); // marked at mid 100 → pnl = −495 + 5·100 = +5
    expect(s.pnl).toBeCloseTo(5, 6);
  });

  it("the full run is deterministic (same events → same summary)", () => {
    expect(fillBid(-1).pnl).toBe(fillBid(-1).pnl);
    expect(fillBid(-1).nFills).toBe(fillBid(-1).nFills);
  });
});
