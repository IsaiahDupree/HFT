import { describe, it, expect } from "vitest";
import {
  applyLevelUpdate,
  applyTrade,
  initQueueState,
  levelSizeAt,
  simulateQueueFills,
  tradeHitsQuote,
  type QueueEvent,
  type RestingQuote,
  type TradeEvent,
} from "@/lib/backtest/queue-fill";

const bid = (price = 0.5, size = 25, postedTs = 1000): RestingQuote => ({ side: "bid", price, size, postedTs });
const ask = (price = 0.52, size = 25, postedTs = 1000): RestingQuote => ({ side: "ask", price, size, postedTs });
const level = (ts: number, size: number): QueueEvent => ({ ts, kind: "level", size });
const trade = (ts: number, price: number, size: number, aggressor: "BUY" | "SELL"): TradeEvent => ({
  ts,
  kind: "trade",
  price,
  size,
  aggressor,
});

describe("levelSizeAt", () => {
  it("finds the size at a price and returns 0 when absent", () => {
    const ladder = [
      [0.5, 100],
      [0.49, 40],
    ] as const;
    expect(levelSizeAt(ladder, 0.5)).toBe(100);
    expect(levelSizeAt(ladder, 0.49)).toBe(40);
    expect(levelSizeAt(ladder, 0.48)).toBe(0);
  });
  it("tolerates float representation of cent prices", () => {
    expect(levelSizeAt([[0.1 + 0.2, 7]], 0.3)).toBe(7); // 0.30000000000000004 vs 0.3
  });
});

describe("initQueueState — we join the BACK of the queue", () => {
  it("everything visible at post time is ahead of us", () => {
    const s = initQueueState(bid(0.5, 25), 180);
    expect(s.queueAhead).toBe(180);
    expect(s.queueBehind).toBe(0);
    expect(s.remaining).toBe(25);
    expect(s.fills).toEqual([]);
  });
  it("clamps negative inputs", () => {
    const s = initQueueState(bid(0.5, -5), -10);
    expect(s.queueAhead).toBe(0);
    expect(s.remaining).toBe(0);
  });
});

describe("applyLevelUpdate", () => {
  it("growth joins BEHIND us (price-time priority)", () => {
    const s = applyLevelUpdate(initQueueState(bid(), 100), 150);
    expect(s.queueAhead).toBe(100);
    expect(s.queueBehind).toBe(50);
  });
  it("cancellations shrink ahead/behind pro-rata by default", () => {
    let s = applyLevelUpdate(initQueueState(bid(), 60), 100); // ahead 60, behind 40
    s = applyLevelUpdate(s, 50); // 50 cancelled out of 100 -> halve both
    expect(s.queueAhead).toBeCloseTo(30, 9);
    expect(s.queueBehind).toBeCloseTo(20, 9);
  });
  it('"behind" mode is the pessimistic bound — cancels never shorten our wait first', () => {
    let s = applyLevelUpdate(initQueueState(bid(), 60), 100, "behind"); // ahead 60, behind 40
    s = applyLevelUpdate(s, 50, "behind");
    expect(s.queueAhead).toBeCloseTo(50, 9); // behind absorbed 40, ahead only 10
    expect(s.queueBehind).toBeCloseTo(0, 9);
  });
  it('"ahead" mode is the optimistic bound', () => {
    let s = applyLevelUpdate(initQueueState(bid(), 60), 100, "ahead");
    s = applyLevelUpdate(s, 50, "ahead");
    expect(s.queueAhead).toBeCloseTo(10, 9);
    expect(s.queueBehind).toBeCloseTo(40, 9);
  });
  it("unchanged size is a no-op (returns the same state object)", () => {
    const s0 = initQueueState(bid(), 100);
    expect(applyLevelUpdate(s0, 100)).toBe(s0);
  });
  it("never goes negative when the level empties", () => {
    const s = applyLevelUpdate(initQueueState(bid(), 100), 0);
    expect(s.queueAhead).toBe(0);
    expect(s.queueBehind).toBe(0);
  });
});

describe("tradeHitsQuote", () => {
  it("our bid is hit only by SELL aggressors at <= our price", () => {
    expect(tradeHitsQuote(bid(0.5), trade(1, 0.5, 10, "SELL"))).toBe(true);
    expect(tradeHitsQuote(bid(0.5), trade(1, 0.49, 10, "SELL"))).toBe(true);
    expect(tradeHitsQuote(bid(0.5), trade(1, 0.51, 10, "SELL"))).toBe(false); // above our bid
    expect(tradeHitsQuote(bid(0.5), trade(1, 0.5, 10, "BUY"))).toBe(false); // buyer lifts the ask, not us
  });
  it("our ask is hit only by BUY aggressors at >= our price", () => {
    expect(tradeHitsQuote(ask(0.52), trade(1, 0.52, 10, "BUY"))).toBe(true);
    expect(tradeHitsQuote(ask(0.52), trade(1, 0.53, 10, "BUY"))).toBe(true);
    expect(tradeHitsQuote(ask(0.52), trade(1, 0.51, 10, "BUY"))).toBe(false);
    expect(tradeHitsQuote(ask(0.52), trade(1, 0.52, 10, "SELL"))).toBe(false);
  });
});

describe("applyTrade — price-time priority at our level", () => {
  it("a print smaller than the queue ahead does NOT fill us (the front-of-queue optimism this model removes)", () => {
    const q = bid(0.5, 25);
    const s = applyTrade(initQueueState(q, 100), q, trade(2000, 0.5, 50, "SELL"));
    expect(s.fills).toEqual([]); // the old model would have filled the whole clip here
    expect(s.queueAhead).toBe(50);
    expect(s.remaining).toBe(25);
  });
  it("the excess past the queue ahead fills us, then spills to the queue behind", () => {
    const q = bid(0.5, 25);
    let s = applyLevelUpdate(initQueueState(q, 30), 70); // ahead 30, behind 40
    s = applyTrade(s, q, trade(2000, 0.5, 60, "SELL")); // 30 ahead + 25 us + 5 behind
    expect(s.fills).toEqual([{ ts: 2000, price: 0.5, qty: 25 }]);
    expect(s.queueAhead).toBe(0);
    expect(s.queueBehind).toBe(35);
    expect(s.remaining).toBe(0);
  });
  it("partial fill when the excess is smaller than our size", () => {
    const q = bid(0.5, 25);
    const s = applyTrade(initQueueState(q, 10), q, trade(2000, 0.5, 18, "SELL"));
    expect(s.fills).toEqual([{ ts: 2000, price: 0.5, qty: 8 }]);
    expect(s.remaining).toBe(17);
  });
  it("a print THROUGH our price sweeps the level — full fill at OUR price", () => {
    const q = bid(0.5, 25);
    const s = applyTrade(initQueueState(q, 500), q, trade(2000, 0.48, 1, "SELL"));
    expect(s.fills).toEqual([{ ts: 2000, price: 0.5, qty: 25 }]);
    expect(s.queueAhead).toBe(0);
    expect(s.remaining).toBe(0);
  });
  it("irrelevant prints are no-ops", () => {
    const q = bid(0.5, 25);
    const s0 = initQueueState(q, 100);
    expect(applyTrade(s0, q, trade(2000, 0.51, 999, "SELL"))).toBe(s0); // above our bid
    expect(applyTrade(s0, q, trade(2000, 0.5, 999, "BUY"))).toBe(s0); // wrong aggressor
  });
  it("ask side is symmetric", () => {
    const q = ask(0.52, 25);
    let s = applyTrade(initQueueState(q, 10), q, trade(2000, 0.52, 30, "BUY"));
    expect(s.fills).toEqual([{ ts: 2000, price: 0.52, qty: 20 }]);
    s = applyTrade(s, q, trade(2100, 0.55, 1, "BUY")); // through-print above our ask
    expect(s.remaining).toBe(0);
  });
});

describe("simulateQueueFills — driver", () => {
  it("seeds queue ahead from the last level observation at-or-before post time", () => {
    const q = bid(0.5, 25, 1000);
    const r = simulateQueueFills(q, [
      level(500, 300),
      level(900, 80), // <- the book we joined behind
      level(1500, 80),
      trade(2000, 0.5, 80, "SELL"), // exactly consumes the queue ahead
      trade(2500, 0.5, 25, "SELL"), // now fills us in full
    ]);
    expect(r.fills).toEqual([{ ts: 2500, price: 0.5, qty: 25 }]);
    expect(r.fullyFilled).toBe(true);
    expect(r.firstFillTs).toBe(2500);
  });
  it("no lookahead: prints at-or-before postedTs can never fill us", () => {
    const q = bid(0.5, 25, 1000);
    const r = simulateQueueFills(q, [level(900, 0), trade(1000, 0.4, 9999, "SELL")]);
    expect(r.fills).toEqual([]);
    expect(r.filledQty).toBe(0);
  });
  it("uses fallbackVisibleAtPost when no level precedes the post", () => {
    const q = bid(0.5, 25, 1000);
    const r = simulateQueueFills(q, [trade(2000, 0.5, 30, "SELL")], { fallbackVisibleAtPost: 10 });
    expect(r.fills).toEqual([{ ts: 2000, price: 0.5, qty: 20 }]);
    expect(r.remaining).toBe(5);
  });
  it("size arriving after us never delays our fill", () => {
    const q = bid(0.5, 25, 1000);
    const r = simulateQueueFills(q, [
      level(900, 10),
      level(1500, 500), // 490 join behind us
      trade(2000, 0.5, 35, "SELL"), // 10 ahead + 25 us
    ]);
    expect(r.fills).toEqual([{ ts: 2000, price: 0.5, qty: 25 }]);
  });
  it("cancellations ahead of us shorten the wait (pro-rata, all ahead here)", () => {
    const q = bid(0.5, 25, 1000);
    const r = simulateQueueFills(q, [
      level(900, 100),
      level(1500, 0), // the whole level cancelled — we are now front
      trade(2000, 0.5, 5, "SELL"),
    ]);
    expect(r.fills).toEqual([{ ts: 2000, price: 0.5, qty: 5 }]);
    expect(r.remaining).toBe(20);
    expect(r.fullyFilled).toBe(false);
  });
  it("cancelMode 'behind' delays the fill vs 'ahead' on the same tape", () => {
    const q = bid(0.5, 25, 1000);
    const tape: QueueEvent[] = [
      level(900, 60),
      level(1100, 100), // +40 behind
      level(1200, 50), // 50 cancelled
      trade(2000, 0.5, 35, "SELL"),
    ];
    const pess = simulateQueueFills(q, tape, { cancelMode: "behind" }); // ahead 50 -> trade only clears 35
    const opt = simulateQueueFills(q, tape, { cancelMode: "ahead" }); // ahead 10 -> fills 25
    expect(pess.filledQty).toBe(0);
    expect(opt.fills).toEqual([{ ts: 2000, price: 0.5, qty: 25 }]);
  });
  it("accumulates partial fills and stops once filled", () => {
    const q = bid(0.5, 30, 1000);
    const r = simulateQueueFills(q, [
      level(900, 10),
      trade(2000, 0.5, 22, "SELL"), // 12 to us
      trade(3000, 0.5, 10, "SELL"), // 10 to us
      trade(4000, 0.49, 1, "SELL"), // sweep -> remaining 8
      trade(5000, 0.5, 100, "SELL"), // already done — ignored
    ]);
    expect(r.fills).toEqual([
      { ts: 2000, price: 0.5, qty: 12 },
      { ts: 3000, price: 0.5, qty: 10 },
      { ts: 4000, price: 0.5, qty: 8 },
    ]);
    expect(r.filledQty).toBe(30);
    expect(r.firstFillTs).toBe(2000);
    expect(r.lastFillTs).toBe(4000);
    expect(r.fullyFilled).toBe(true);
  });
  it("never-touched quote reports zero fills and full remainder", () => {
    const q = ask(0.52, 25, 1000);
    const r = simulateQueueFills(q, [level(900, 40), trade(2000, 0.5, 999, "SELL")]);
    expect(r.fills).toEqual([]);
    expect(r.remaining).toBe(25);
    expect(r.firstFillTs).toBeUndefined();
    expect(r.fullyFilled).toBe(false);
  });
  it("is deterministic — identical inputs give identical results", () => {
    const q = bid(0.5, 25, 1000);
    const tape: QueueEvent[] = [
      level(900, 60),
      level(1100, 90),
      level(1300, 45),
      trade(2000, 0.5, 40, "SELL"),
      trade(2500, 0.5, 40, "SELL"),
    ];
    expect(simulateQueueFills(q, tape)).toEqual(simulateQueueFills(q, tape));
  });
});
