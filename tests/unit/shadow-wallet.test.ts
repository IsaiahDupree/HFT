/**
 * Pure-logic tests for the forward shadow-tracker (src/lib/wallets/shadow.ts):
 * latency calc, sample scheduling, book-top parsing, copy slippage, settlement,
 * and fill→logical-bet collapsing. No HTTP, no SQLite.
 */
import { describe, expect, it } from "vitest";
import {
  bookTop,
  collapseFills,
  copyEntrySlippage,
  detectionLatencyMs,
  mean,
  median,
  normalizeLeaderTrade,
  sampleDueTimes,
  settleCopyTrade,
  tokenWon,
  type FillForCollapse,
} from "@/lib/wallets/shadow";

describe("normalizeLeaderTrade", () => {
  const base = {
    transactionHash: "0xabc",
    asset: "123456",
    conditionId: "0xcond",
    title: "Lakers vs Celtics",
    outcome: "Lakers",
    outcomeIndex: 0,
    side: "buy",
    price: "0.42",
    size: "1000",
    usdcSize: "420",
    timestamp: 1_770_000_000, // unix SECONDS
  };

  it("normalizes a data-api row (seconds → ms, strings → numbers)", () => {
    const t = normalizeLeaderTrade(base)!;
    expect(t.leaderTsMs).toBe(1_770_000_000_000);
    expect(t.price).toBe(0.42);
    expect(t.usd).toBe(420);
    expect(t.side).toBe("BUY");
    expect(t.outcomeIndex).toBe(0);
  });

  it("passes millisecond timestamps through unchanged", () => {
    const t = normalizeLeaderTrade({ ...base, timestamp: 1_770_000_000_123 })!;
    expect(t.leaderTsMs).toBe(1_770_000_000_123);
  });

  it("falls back to size×price when usdcSize is missing", () => {
    const t = normalizeLeaderTrade({ ...base, usdcSize: undefined })!;
    expect(t.usd).toBeCloseTo(1000 * 0.42, 8);
  });

  it("rejects rows missing txHash / token / price / timestamp", () => {
    expect(normalizeLeaderTrade({ ...base, transactionHash: "" })).toBeNull();
    expect(normalizeLeaderTrade({ ...base, asset: undefined })).toBeNull();
    expect(normalizeLeaderTrade({ ...base, price: "0" })).toBeNull();
    expect(normalizeLeaderTrade({ ...base, timestamp: undefined })).toBeNull();
  });

  it("maps SELL side", () => {
    expect(normalizeLeaderTrade({ ...base, side: "SELL" })!.side).toBe("SELL");
  });
});

describe("detectionLatencyMs", () => {
  it("is detection time minus leader fill time", () => {
    expect(detectionLatencyMs(1_000_000, 1_032_500)).toBe(32_500);
  });
  it("clamps clock skew to 0 (data-api stamps whole seconds)", () => {
    expect(detectionLatencyMs(1_000_900, 1_000_000)).toBe(0);
  });
});

describe("sampleDueTimes", () => {
  const leader = 1_000_000;

  it("schedules detection-now plus +60s/+300s after the LEADER fill", () => {
    const due = sampleDueTimes(leader, leader + 30_000);
    expect(due).toEqual([
      { offsetSec: 0, dueMs: leader + 30_000 },
      { offsetSec: 60, dueMs: leader + 60_000 },
      { offsetSec: 300, dueMs: leader + 300_000 },
    ]);
  });

  it("never schedules in the past: late detection samples immediately", () => {
    const detected = leader + 90_000; // detected 90s late — +60s already gone
    const due = sampleDueTimes(leader, detected);
    expect(due.find((d) => d.offsetSec === 60)!.dueMs).toBe(detected);
    expect(due.find((d) => d.offsetSec === 300)!.dueMs).toBe(leader + 300_000);
  });
});

describe("bookTop", () => {
  it("finds best bid (max) and best ask (min) without assuming sort order", () => {
    const top = bookTop({
      bids: [{ price: "0.40", size: "10" }, { price: "0.43", size: "5" }, { price: "0.41", size: "1" }],
      asks: [{ price: "0.47", size: "10" }, { price: "0.44", size: "5" }],
    });
    expect(top.bestBid).toBeCloseTo(0.43, 8);
    expect(top.bestAsk).toBeCloseTo(0.44, 8);
    expect(top.spread).toBeCloseTo(0.01, 8);
    expect(top.mid).toBeCloseTo(0.435, 8);
  });

  it("returns nulls on empty / one-sided / missing books", () => {
    expect(bookTop(undefined)).toEqual({ bestBid: null, bestAsk: null, spread: null, mid: null });
    const oneSided = bookTop({ bids: [{ price: "0.4", size: "1" }], asks: [] });
    expect(oneSided.bestBid).toBeCloseTo(0.4, 8);
    expect(oneSided.bestAsk).toBeNull();
    expect(oneSided.spread).toBeNull();
  });
});

describe("copyEntrySlippage", () => {
  it("BUY copy pays best ask minus leader price", () => {
    expect(copyEntrySlippage("BUY", 0.42, { bestBid: 0.42, bestAsk: 0.44 })).toBeCloseTo(0.02, 8);
  });
  it("SELL copy (mirrored exit) pays leader price minus best bid", () => {
    expect(copyEntrySlippage("SELL", 0.42, { bestBid: 0.40, bestAsk: 0.44 })).toBeCloseTo(0.02, 8);
  });
  it("null when the needed side of the book is empty", () => {
    expect(copyEntrySlippage("BUY", 0.42, { bestBid: 0.4, bestAsk: null })).toBeNull();
    expect(copyEntrySlippage("SELL", 0.42, { bestBid: null, bestAsk: 0.44 })).toBeNull();
  });
});

describe("tokenWon", () => {
  const res = { winningIndex: 1, clobTokenIds: ["tokYES", "tokNO"] };
  it("matches the bought token against the winning index", () => {
    expect(tokenWon("tokNO", res)).toBe(true);
    expect(tokenWon("tokYES", res)).toBe(false);
  });
  it("null for tokens not in the market", () => {
    expect(tokenWon("other", res)).toBeNull();
  });
});

describe("settleCopyTrade", () => {
  it("hold-to-resolution: win pays (1−entry)/entry, loss −100%", () => {
    const win = settleCopyTrade({ copyEntry: 0.25, leaderEntry: 0.20, won: true })!;
    expect(win.copyRoi).toBeCloseTo(3.0, 8);   // (1−0.25)/0.25
    expect(win.leaderRoi).toBeCloseTo(4.0, 8); // (1−0.20)/0.20
    const loss = settleCopyTrade({ copyEntry: 0.25, leaderEntry: 0.20, won: false })!;
    expect(loss.copyRoi).toBeCloseTo(-1.0, 8);
    expect(loss.leaderRoi).toBeCloseTo(-1.0, 8);
  });

  it("mirrored early exit overrides resolution", () => {
    const r = settleCopyTrade({
      copyEntry: 0.30, leaderEntry: 0.28, won: false,
      exit: { copyExit: 0.45, leaderExit: 0.50 },
    })!;
    expect(r.copyRoi).toBeCloseTo(0.5, 8);            // (0.45−0.30)/0.30
    expect(r.leaderRoi).toBeCloseTo((0.50 - 0.28) / 0.28, 8);
  });

  it("falls back to resolution when the exit sample is missing", () => {
    const r = settleCopyTrade({
      copyEntry: 0.30, leaderEntry: 0.28, won: true,
      exit: { copyExit: null, leaderExit: 0.50 },
    })!;
    expect(r.copyRoi).toBeCloseTo((1 - 0.30) / 0.30, 8);
  });

  it("null when entry is missing or above the copyable cap (0.985)", () => {
    expect(settleCopyTrade({ copyEntry: null, leaderEntry: 0.5, won: true })).toBeNull();
    expect(settleCopyTrade({ copyEntry: 0.99, leaderEntry: 0.5, won: true })).toBeNull();
  });
});

describe("collapseFills", () => {
  const fill = (id: number, tsSec: number, usd: number, price: number, over: Partial<FillForCollapse> = {}): FillForCollapse => ({
    id, tokenId: "tokA", side: "BUY", price, usd, leaderTsMs: tsSec * 1000, ...over,
  });

  it("merges same-token same-side fills within the window into one bet (usd summed, vwap)", () => {
    const bets = collapseFills([fill(1, 0, 600, 0.40), fill(2, 120, 400, 0.45)]);
    expect(bets).toHaveLength(1);
    const b = bets[0]!;
    expect(b.firstFillId).toBe(1);
    expect(b.usd).toBe(1000);
    expect(b.fillCount).toBe(2);
    // usd-weighted vwap: (600×0.40 + 400×0.45) / 1000
    expect(b.leaderVwap).toBeCloseTo(0.42, 8);
  });

  it("the ≥$1k filter sees the COLLAPSED clip, not the split fills", () => {
    const bets = collapseFills([fill(1, 0, 600, 0.40), fill(2, 60, 600, 0.40)]);
    expect(bets[0]!.usd).toBe(1200); // two $600 fills = one $1.2k clip
  });

  it("separates fills beyond the window, on other tokens, and opposite sides", () => {
    const bets = collapseFills([
      fill(1, 0, 100, 0.40),
      fill(2, 4000, 100, 0.40),                       // > 1h after bet 1's first fill
      fill(3, 10, 100, 0.40, { tokenId: "tokB" }),    // different token
      fill(4, 20, 100, 0.40, { side: "SELL" }),       // different side
    ]);
    expect(bets).toHaveLength(4);
  });

  it("is input-order independent", () => {
    const a = collapseFills([fill(2, 120, 400, 0.45), fill(1, 0, 600, 0.40)]);
    expect(a).toHaveLength(1);
    expect(a[0]!.firstFillId).toBe(1);
  });
});

describe("median / mean", () => {
  it("median of odd and even lists, null on empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("mean, null on empty", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNull();
  });
});
