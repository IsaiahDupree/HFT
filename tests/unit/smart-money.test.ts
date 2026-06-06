import { describe, it, expect } from "vitest";
import { parseLeaderboard, rankWallets, positionConsensus, fillStyleProfile, realizedStats, isVerifiedProfitable, walletArchetype, DEFAULT_RANK, type LeaderboardRow, type Fill } from "@/lib/exec/smart-money";

const rawRow = (addr: string, acct: number, wins: Record<string, { pnl: number; roi: number; vlm: number }>) => ({
  ethAddress: addr, displayName: "", accountValue: String(acct),
  windowPerformances: Object.entries(wins).map(([k, v]) => [k, { pnl: String(v.pnl), roi: String(v.roi), vlm: String(v.vlm) }]),
});

describe("parseLeaderboard", () => {
  it("parses the windowPerformances array into typed windows", () => {
    const rows = parseLeaderboard({ leaderboardRows: [rawRow("0xabc", 1_000_000, { day: { pnl: 1, roi: 0.01, vlm: 100 }, allTime: { pnl: 50, roi: 0.5, vlm: 9000 } })] });
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0xabc");
    expect(rows[0].accountValue).toBe(1_000_000);
    expect(rows[0].allTime.roi).toBe(0.5);
    expect(rows[0].week.roi).toBe(0); // missing window → zeroed
  });
});

const row = (over: Partial<LeaderboardRow> & { address: string }): LeaderboardRow => ({
  displayName: "", accountValue: 100_000,
  day: { pnl: 200, roi: 0.01, vlm: 10_000 }, week: { pnl: 1_000, roi: 0.05, vlm: 50_000 },
  month: { pnl: 30_000, roi: 0.1, vlm: 1_000_000 }, allTime: { pnl: 80_000, roi: 0.3, vlm: 5_000_000 },
  ...over,
});

describe("rankWallets — copyable skill, not raw PnL", () => {
  it("EXCLUDES the HFT/MM (turnover above the cap) even with a fat ROI", () => {
    const mm = row({ address: "0xMM", accountValue: 100_000, month: { pnl: 40_000, roi: 0.4, vlm: 100_000_000 } }); // turnover 1000×
    expect(rankWallets([mm], DEFAULT_RANK)).toHaveLength(0);
  });
  it("EXCLUDES dust, inactive, a blowup, and a tiny-base ROI% explosion (no real dollars)", () => {
    const dust = row({ address: "0xdust", accountValue: 1_000 });
    const idle = row({ address: "0xidle", month: { pnl: 30_000, roi: 0.1, vlm: 1_000 } });
    const blowup = row({ address: "0xblow", allTime: { pnl: -50_000, roi: -0.2, vlm: 5_000_000 } });
    const tinyBase = row({ address: "0xtiny", month: { pnl: 200, roi: 20.0, vlm: 1_000_000 } }); // 2000% ROI but only $200
    expect(rankWallets([dust, idle, blowup, tinyBase], DEFAULT_RANK)).toHaveLength(0);
  });
  it("keeps a consistent active winner and ranks by consistency then score", () => {
    const great = row({ address: "0xgreat", day: { pnl: 300, roi: 0.02, vlm: 10_000 }, week: { pnl: 1_000, roi: 0.05, vlm: 50_000 }, month: { pnl: 40_000, roi: 0.15, vlm: 1_000_000 }, allTime: { pnl: 150_000, roi: 0.6, vlm: 5_000_000 } });
    const choppy = row({ address: "0xchoppy", day: { pnl: -500, roi: -0.05, vlm: 10_000 }, month: { pnl: 20_000, roi: 0.05, vlm: 1_000_000 }, allTime: { pnl: 60_000, roi: 0.2, vlm: 5_000_000 } });
    const ranked = rankWallets([choppy, great], DEFAULT_RANK);
    expect(ranked.map((r) => r.address)).toEqual(["0xgreat", "0xchoppy"]); // great is 4/4 consistent
    expect(ranked[0].consistency).toBe(1);
    expect(ranked[1].consistency).toBe(0.75);
  });
});

describe("positionConsensus", () => {
  it("aggregates net/gross notional + long/short wallet counts per coin, sorted by |net|", () => {
    const c = positionConsensus([
      { wallet: "a", coin: "BTC", szi: 2, notionalUsd: 200_000, accountValue: 1e6 },
      { wallet: "b", coin: "BTC", szi: 1, notionalUsd: 100_000, accountValue: 1e6 },
      { wallet: "c", coin: "BTC", szi: -0.5, notionalUsd: 50_000, accountValue: 1e6 },
      { wallet: "a", coin: "ETH", szi: -10, notionalUsd: 30_000, accountValue: 1e6 },
    ]);
    expect(c[0].coin).toBe("BTC");
    expect(c[0].netNotional).toBe(200_000 + 100_000 - 50_000); // 250k net long
    expect(c[0].longWallets).toBe(2);
    expect(c[0].shortWallets).toBe(1);
    expect(c[0].bias).toBe("long");
    expect(c[1].bias).toBe("short");
  });
});

describe("fillStyleProfile — copyability", () => {
  const mkFills = (n: number, spanMs: number, coin = "ETH", dir = "Open Long", pnl = 1): Fill[] =>
    Array.from({ length: n }, (_, i) => ({ coin, dir: i % 2 ? "Close Long" : dir, sz: 1, px: 2000, closedPnl: i % 2 ? pnl : 0, time: 1_000_000 + Math.floor((i / n) * spanMs) }));

  it("classifies a high-frequency wallet as un-copyable scalper/MM", () => {
    const p = fillStyleProfile(mkFills(2000, 86_400_000)); // 2000 fills in 1 day → ~2000/day
    expect(p.classification).toBe("scalper/MM (un-copyable)");
    expect(p.tradesPerDay).toBeGreaterThan(50);
  });
  it("classifies a handful of trades over weeks as a position trader", () => {
    const p = fillStyleProfile(mkFills(20, 30 * 86_400_000)); // 20 fills / 30d ≈ 0.67/day
    expect(p.classification).toBe("position trader");
  });
  it("computes win rate, long bias, and top coins", () => {
    const fills: Fill[] = [
      { coin: "BTC", dir: "Open Long", sz: 1, px: 60000, closedPnl: 0, time: 1 },
      { coin: "BTC", dir: "Close Long", sz: 1, px: 61000, closedPnl: 1000, time: 2 },
      { coin: "BTC", dir: "Open Long", sz: 1, px: 61000, closedPnl: 0, time: 3 },
      { coin: "BTC", dir: "Close Long", sz: 1, px: 60500, closedPnl: -500, time: 4 },
      { coin: "ETH", dir: "Open Short", sz: 1, px: 2000, closedPnl: 0, time: 5 },
      { coin: "ETH", dir: "Close Short", sz: 1, px: 1950, closedPnl: 50, time: 6 },
    ];
    const p = fillStyleProfile(fills);
    expect(p.winRate).toBeCloseTo(2 / 3, 5);   // 2 of 3 closes profitable
    expect(p.longBias).toBeCloseTo(2 / 3, 5);  // 2 of 3 opens long
    expect(p.topCoins[0]).toBe("BTC");         // most fills
  });
  it("returns 'thin' for too few fills", () => {
    expect(fillStyleProfile([]).classification).toBe("thin");
  });
});

describe("realizedStats + isVerifiedProfitable — the leaderboard rank ≠ real profitability", () => {
  const close = (pnl: number, t = 1): Fill => ({ coin: "BTC", dir: "Close Long", sz: 1, px: 60000, closedPnl: pnl, time: t });
  it("computes realized PnL, win rate, and profit factor from closed fills", () => {
    const s = realizedStats([close(100), close(100), close(-50)]);
    expect(s.nClosed).toBe(3);
    expect(s.realizedPnl).toBe(150);
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
    expect(s.profitFactor).toBeCloseTo(200 / 50, 5);
  });
  it("THE TRAP: high win rate but NEGATIVE expectancy fails verification (pennies before a steamroller)", () => {
    // 8 small wins (+100) + 1 huge loss (−2000): 89% win rate, but net −1200, profit factor 0.4
    const fills = [...Array(8).fill(0).map((_, i) => close(100, i + 1)), close(-2000, 9)];
    const s = realizedStats(fills);
    expect(s.winRate).toBeCloseTo(8 / 9, 5);   // looks great
    expect(s.realizedPnl).toBe(-1200);          // but loses money
    expect(s.profitFactor).toBeLessThan(1);
    expect(isVerifiedProfitable(s)).toBe(false); // correctly NOT copyable — this is the 0xbe4e91ae pattern
  });
  it("a genuinely profitable wallet (net positive, PF ≥ 1, enough trades) verifies", () => {
    const fills = [...Array(12).fill(0).map((_, i) => close(i % 3 === 0 ? -50 : 100, i + 1))];
    const s = realizedStats(fills);
    expect(s.realizedPnl).toBeGreaterThan(0);
    expect(isVerifiedProfitable(s)).toBe(true);
  });
  it("too few closed trades is unverifiable (not enough sample)", () => {
    expect(isVerifiedProfitable(realizedStats([close(100), close(100)]))).toBe(false);
  });
});

describe("walletArchetype — pin out the strategy from behavior", () => {
  it("high-activity neutral = market-maker; high-activity directional = hft-scalper", () => {
    expect(walletArchetype({ tradesPerDay: 500, longBias: 0.5, topCoinShare: 0.4 })).toBe("market-maker");
    expect(walletArchetype({ tradesPerDay: 500, longBias: 0.95, topCoinShare: 0.4 })).toBe("hft-scalper");
  });
  it("mid activity = directional-swing; low = position-trader; ~none = low-activity", () => {
    expect(walletArchetype({ tradesPerDay: 10, longBias: 0.9, topCoinShare: 0.4 })).toBe("directional-swing");
    expect(walletArchetype({ tradesPerDay: 1, longBias: 0.9, topCoinShare: 0.4 })).toBe("position-trader");
    expect(walletArchetype({ tradesPerDay: 0.1, longBias: 0.5, topCoinShare: 0.4 })).toBe("low-activity");
  });
  it("one-market concentration = specialist", () => {
    expect(walletArchetype({ tradesPerDay: 20, longBias: 0.6, topCoinShare: 0.9 })).toBe("specialist");
  });
});
