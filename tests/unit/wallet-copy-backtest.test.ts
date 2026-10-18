import { describe, expect, it } from "vitest";
import {
  backtestCopyTrades, backtestResolvedOutcomes, collapseSluggedTrades,
  interpolatePriceAt, parseGammaResolvedMarket,
  type PriceHistorySeries, type ResolvedMarket,
} from "../../src/lib/wallets/copy-backtest";

function series(tokenId: string, pts: Array<[number, number]>): PriceHistorySeries {
  return { tokenId, points: pts.map(([t, p]) => ({ t, p })) };
}

const now = Math.floor(Date.now() / 1000);

describe("interpolatePriceAt", () => {
  it("returns null when query is before window (no extrapolation)", () => {
    const s = series("a", [[100, 0.4], [200, 0.5]]);
    expect(interpolatePriceAt(s, 50)).toBeNull();
  });

  it("returns null when query is after window (no extrapolation)", () => {
    const s = series("a", [[100, 0.4], [200, 0.6]]);
    expect(interpolatePriceAt(s, 500)).toBeNull();
  });

  it("linearly interpolates between bracketing points", () => {
    const s = series("a", [[100, 0.40], [200, 0.60]]);
    // Halfway in time → halfway in price.
    expect(interpolatePriceAt(s, 150)).toBeCloseTo(0.50);
  });

  it("returns null on an empty series", () => {
    expect(interpolatePriceAt(series("a", []), 100)).toBeNull();
  });
});

describe("backtestCopyTrades", () => {
  const tokenId = "tkn-1";

  it("rejects trades older than maxAgeDays", () => {
    const trades = [
      // 200 days old → outside default 90-day window
      { asset: tokenId, timestamp: now - 200 * 86400, side: "BUY", price: 0.4 },
    ];
    const r = backtestCopyTrades(
      "0xabc",
      trades,
      new Map([[tokenId, series(tokenId, [[now - 200 * 86400, 0.4], [now - 199 * 86400, 0.5]])]]),
    );
    expect(r.trades_seen).toBe(1);
    expect(r.trades_used).toBe(0);
    expect(r.buckets.every((b) => b.n_trades === 0)).toBe(true);
  });

  it("rejects trades newer than the minAgeMinutes guard (exit would be in the future)", () => {
    const t0 = now - 60; // 1 minute ago
    const trades = [{ asset: tokenId, timestamp: t0, side: "BUY", price: 0.4 }];
    // Default hold horizons are at least 60 min, so a trade 1 min old can't
    // possibly have a 60-min hold's exit price observed yet.
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, [[t0, 0.4], [now, 0.42]])]]));
    expect(r.trades_used).toBe(0);
  });

  it("scores a clean BUY → up-move as a win for short lags", () => {
    const t0 = now - 86400; // a day ago
    const trades = [{ asset: tokenId, timestamp: t0, side: "BUY", price: 0.40 }];
    // Price rises from 0.40 at t0 to 0.50 over the next 2 hours, then flat.
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.40],
      [t0,       0.40],
      [t0 + 600, 0.42],   // +10 min
      [t0 + 1800, 0.45],  // +30 min
      [t0 + 3600, 0.48],  // +60 min
      [t0 + 14400, 0.55], // +4h
      [t0 + 86400, 0.55], // +24h
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, pts)]]), {
      lagsSec: [10, 60, 300],
      holdMinutes: [60, 240],
      slippageBps: 30,
      sizeUsd: 100,
    });
    expect(r.trades_seen).toBe(1);
    // Each (lag,hold) bucket should have 1 trade.
    expect(r.buckets.every((b) => b.n_trades === 1)).toBe(true);
    // The 4-hour hold buckets should be profitable (price rose to 0.55).
    const h240 = r.buckets.filter((b) => b.hold_min === 240);
    for (const b of h240) {
      expect(b.pnl_usd).toBeGreaterThan(0);
      expect(b.win_rate).toBe(1);
    }
    // best_lag_sec needs ≥3 trades in a bucket; with 1 trade per bucket this
    // synthetic case leaves best at the initial 0. The dedicated "best_lag"
    // test below covers the populated-best path.
  });

  it("scores a BUY → down-move as a loss", () => {
    const t0 = now - 86400;
    const trades = [{ asset: tokenId, timestamp: t0, side: "BUY", price: 0.60 }];
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.60],
      [t0, 0.60],
      [t0 + 3600, 0.55],
      [t0 + 14400, 0.45],
      [t0 + 86400, 0.45],
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, pts)]]), {
      holdMinutes: [60, 240],
    });
    const longHold = r.buckets.find((b) => b.hold_min === 240 && b.lag_sec === 60);
    expect(longHold).toBeDefined();
    expect(longHold!.pnl_usd).toBeLessThan(0);
    expect(longHold!.win_rate).toBe(0);
  });

  it("SELL signal profits when price drops", () => {
    const t0 = now - 86400;
    const trades = [{ asset: tokenId, timestamp: t0, side: "SELL", price: 0.70 }];
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.70],
      [t0, 0.70],
      [t0 + 3600, 0.60],
      [t0 + 14400, 0.50],
      [t0 + 86400, 0.50],
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, pts)]]), {
      holdMinutes: [60, 240],
    });
    const longHold = r.buckets.find((b) => b.hold_min === 240 && b.lag_sec === 60);
    expect(longHold!.pnl_usd).toBeGreaterThan(0);
  });

  it("skips trades with missing or out-of-range fields", () => {
    const trades = [
      { asset: "", timestamp: now, side: "BUY", price: 0.5 },         // empty token
      { asset: tokenId, timestamp: now, side: "WAT", price: 0.5 },    // bad side
      { asset: tokenId, timestamp: now, side: "BUY", price: 0 },      // zero price
      { asset: tokenId, timestamp: now, side: "BUY", price: 1.0 },    // ≥ 1
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, [[now, 0.5], [now + 60, 0.5]])]]));
    expect(r.trades_used).toBe(0);
  });

  it("skips when no price series is provided for the token", () => {
    const t0 = now - 86400;
    const trades = [{ asset: tokenId, timestamp: t0, side: "BUY", price: 0.4 }];
    const r = backtestCopyTrades("0xabc", trades, new Map(), { holdMinutes: [60, 240] });
    expect(r.trades_used).toBe(0);
    expect(r.notes.join(" ")).toMatch(/missing price history|too recent|too old/i);
  });

  it("computes avg_drift_bps as entry-mid vs wallet's fill", () => {
    const t0 = now - 7200; // 2 hours ago — well past the 65-min minAgeMinutes guard
    const trades = [{ asset: tokenId, timestamp: t0, side: "BUY", price: 0.50 }];
    // Mid rises from 0.50 → 0.51 in 60s → drift at +60s lag is +200 bps.
    const pts: Array<[number, number]> = [
      [t0, 0.50],
      [t0 + 60, 0.51],
      [t0 + 3600, 0.55],
      [t0 + 7200, 0.60],
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, pts)]]), {
      lagsSec: [60],
      holdMinutes: [60],
    });
    const b = r.buckets[0];
    expect(b.avg_drift_bps).toBeCloseTo(200, 0); // +1pp from 0.50 = 200 bps
  });

  it("reports best_lag/hold when there are profitable buckets with ≥3 trades", () => {
    const trades = [] as Array<{ asset: string; timestamp: number; side: string; price: number }>;
    const t0 = now - 86400;
    // Three winning BUYs in a row.
    for (let i = 0; i < 3; i++) {
      trades.push({ asset: tokenId, timestamp: t0 + i * 60, side: "BUY", price: 0.40 });
    }
    const pts: Array<[number, number]> = [
      [t0, 0.40],
      [t0 + 3600, 0.50],
      [t0 + 86400, 0.55],
    ];
    const r = backtestCopyTrades("0xabc", trades, new Map([[tokenId, series(tokenId, pts)]]), {
      lagsSec: [10, 60],
      holdMinutes: [60, 240],
    });
    expect(r.best_lag_sec).not.toBeNull();
    expect(r.best_hold_min).not.toBeNull();
    expect(r.best_pnl_usd).toBeGreaterThan(0);
  });
});

// ============================================================================
// Resolved-outcome scorer
// ============================================================================

describe("parseGammaResolvedMarket", () => {
  it("parses a resolved binary market with YES winner", () => {
    const m = parseGammaResolvedMarket({
      conditionId: "0xabc",
      closed: true,
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]',
      clobTokenIds: '["yes_tok","no_tok"]',
      closedTime: "2026-03-12 00:53:39+00",
    });
    expect(m).not.toBeNull();
    expect(m!.winningIndex).toBe(0);
    expect(m!.clobTokenIds).toEqual(["yes_tok", "no_tok"]);
    expect(m!.outcomePayouts).toEqual([1, 0]);
    expect(typeof m!.closedTime).toBe("number");
  });

  it("parses a resolved binary market with NO winner", () => {
    const m = parseGammaResolvedMarket({
      conditionId: "0xabc", closed: true,
      outcomePrices: '["0","1"]', clobTokenIds: '["yes_tok","no_tok"]',
    });
    expect(m!.winningIndex).toBe(1);
  });

  it("returns null for an unresolved market", () => {
    expect(parseGammaResolvedMarket({ conditionId: "0xabc", closed: false })).toBeNull();
  });

  it("returns null for a market with no clear winner (invalid resolution)", () => {
    // Both outcomes at 0.5 — Polymarket sometimes resolves this way on push.
    const m = parseGammaResolvedMarket({
      conditionId: "0xabc", closed: true,
      outcomePrices: '["0.5","0.5"]', clobTokenIds: '["a","b"]',
    });
    expect(m).toBeNull();
  });
});

describe("backtestResolvedOutcomes", () => {
  const cond = "0xcond";
  const yesTok = "yes_tok";
  const noTok = "no_tok";
  const yesWon: ResolvedMarket = {
    conditionId: cond, winningIndex: 0,
    outcomePayouts: [1, 0], clobTokenIds: [yesTok, noTok],
  };
  const noWon: ResolvedMarket = {
    conditionId: cond, winningIndex: 1,
    outcomePayouts: [0, 1], clobTokenIds: [yesTok, noTok],
  };

  it("scores BUY YES at $0.40 with YES winning as +1.5x payout", () => {
    const trades = [{ conditionId: cond, asset: yesTok, side: "BUY", price: 0.40 }];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, yesWon]]), {
      slippageBpsTiers: [0], sizeUsd: 100,
    });
    // Payout multiple = (1 - 0.40) / 0.40 = 1.5 → $100 × 1.5 = $150 profit
    expect(r.buckets[0].pnl_usd).toBeCloseTo(150, 1);
    expect(r.buckets[0].win_rate).toBe(1);
    expect(r.buckets[0].avg_winner_multiple).toBeCloseTo(1.5, 2);
  });

  it("scores BUY YES at $0.40 with NO winning as −$100 loss per copy", () => {
    const trades = [{ conditionId: cond, asset: yesTok, side: "BUY", price: 0.40 }];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, noWon]]), {
      slippageBpsTiers: [0], sizeUsd: 100,
    });
    expect(r.buckets[0].pnl_usd).toBeCloseTo(-100, 1);
    expect(r.buckets[0].win_rate).toBe(0);
  });

  it("treats SELL YES as a bet against YES (= buy NO at 1-p)", () => {
    // SELL YES at 0.7 → bearish bet. Modeled as BUY NO at 0.3.
    const trades = [{ conditionId: cond, asset: yesTok, side: "SELL", price: 0.70 }];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, noWon]]), {
      slippageBpsTiers: [0], sizeUsd: 100,
    });
    // NO wins → payout multiple = (1 - 0.30) / 0.30 = 2.333… → $233.33 profit
    expect(r.buckets[0].pnl_usd).toBeCloseTo(233.33, 1);
    expect(r.buckets[0].win_rate).toBe(1);
  });

  it("skips SELL trades when treatSellAsInverseBet=false", () => {
    const trades = [{ conditionId: cond, asset: yesTok, side: "SELL", price: 0.70 }];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, noWon]]), {
      slippageBpsTiers: [0], treatSellAsInverseBet: false,
    });
    expect(r.trades_used).toBe(0);
  });

  it("evaluates multiple slippage tiers — higher slip strictly hurts", () => {
    const trades = [
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.40 },
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.40 },
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.40 },
    ];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, yesWon]]), {
      slippageBpsTiers: [0, 100, 500], sizeUsd: 100,
    });
    const [s0, s100, s500] = r.buckets;
    expect(s0.pnl_usd).toBeGreaterThan(s100.pnl_usd);
    expect(s100.pnl_usd).toBeGreaterThan(s500.pnl_usd);
    // Best is the lowest-slippage tier (since it's the most profitable, ≥3 trades).
    expect(r.best_slippage_bps).toBe(0);
  });

  it("counts unresolved markets and missing-token skips separately", () => {
    const trades = [
      { conditionId: "0xunknown", asset: yesTok, side: "BUY", price: 0.4 }, // unresolved
      { conditionId: cond, asset: "wrong_tok", side: "BUY", price: 0.4 },   // token not in market
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.4 },        // good
    ];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, yesWon]]));
    expect(r.trades_skipped_unresolved).toBe(1);
    expect(r.trades_skipped_no_token_match).toBe(1);
    expect(r.trades_used).toBe(1);
  });

  it("ignores malformed trades (no condition, missing price, bad side)", () => {
    const trades = [
      { conditionId: "", asset: yesTok, side: "BUY", price: 0.4 },
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0 },
      { conditionId: cond, asset: yesTok, side: "WAT", price: 0.4 },
    ];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, yesWon]]));
    expect(r.trades_used).toBe(0);
  });

  it("over a mix of wins and losses, computes win_rate correctly", () => {
    // 3 wins, 1 loss → win rate = 0.75
    const trades = [
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.4 },          // YES wins, profit
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.6 },          // YES wins, profit
      { conditionId: cond, asset: yesTok, side: "BUY", price: 0.7 },          // YES wins, profit
      { conditionId: "0xother", asset: "other_yes", side: "BUY", price: 0.8 }, // NO wins → loss
    ];
    const otherCond: ResolvedMarket = {
      conditionId: "0xother", winningIndex: 1,
      outcomePayouts: [0, 1], clobTokenIds: ["other_yes", "other_no"],
    };
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, yesWon], ["0xother", otherCond]]), {
      slippageBpsTiers: [0],
    });
    expect(r.buckets[0].n_trades).toBe(4);
    expect(r.buckets[0].n_wins).toBe(3);
    expect(r.buckets[0].win_rate).toBeCloseTo(0.75, 2);
  });
});

// ============================================================================
// Slug de-dup + sample-size verdict
// ============================================================================

describe("collapseSluggedTrades", () => {
  const cond = "0xcond";
  const yes = "yes_tok";

  it("collapses N orders on same (cond,asset,side) within window into 1 vwap trade", () => {
    const t0 = 1_700_000_000;
    const trades = [
      { conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: t0 },
      { conditionId: cond, asset: yes, side: "BUY", price: 0.42, usdcSize: 100, timestamp: t0 + 60 },
      { conditionId: cond, asset: yes, side: "BUY", price: 0.44, usdcSize: 100, timestamp: t0 + 120 },
    ];
    const out = collapseSluggedTrades(trades, 3600);
    expect(out.length).toBe(1);
    expect(Number(out[0].price)).toBeCloseTo(0.42, 3);
    expect(Number(out[0].usdcSize)).toBeCloseTo(300, 1);
    expect(out[0].timestamp).toBe(t0);
  });

  it("keeps orders separate when outside the window", () => {
    const t0 = 1_700_000_000;
    const trades = [
      { conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: t0 },
      { conditionId: cond, asset: yes, side: "BUY", price: 0.50, usdcSize: 100, timestamp: t0 + 7200 },
    ];
    const out = collapseSluggedTrades(trades, 3600);
    expect(out.length).toBe(2);
  });

  it("keeps BUY and SELL on same market separate", () => {
    const t0 = 1_700_000_000;
    const trades = [
      { conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: t0 },
      { conditionId: cond, asset: yes, side: "SELL", price: 0.50, usdcSize: 100, timestamp: t0 + 60 },
    ];
    const out = collapseSluggedTrades(trades, 3600);
    expect(out.length).toBe(2);
    expect(new Set(out.map((t) => t.side))).toEqual(new Set(["BUY", "SELL"]));
  });

  it("disabled when windowSec=0", () => {
    const t0 = 1_700_000_000;
    const trades = [
      { conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: t0 },
      { conditionId: cond, asset: yes, side: "BUY", price: 0.42, usdcSize: 100, timestamp: t0 + 60 },
    ];
    expect(collapseSluggedTrades(trades, 0).length).toBe(2);
  });
});

describe("backtestResolvedOutcomes — verdict + de-dup integration", () => {
  const cond = "0xc1";
  const yes = "yes1";
  const market: ResolvedMarket = { conditionId: cond, winningIndex: 0, outcomePayouts: [1, 0], clobTokenIds: [yes, "no1"] };

  it("verdict is 'insufficient_data' when distinct markets < minDistinctMarkets", () => {
    const trades = [{ conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: 1_700_000_000 }];
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, market]]), {
      minDistinctMarkets: 10, slippageBpsTiers: [0, 100],
    });
    expect(r.verdict.rating).toBe("insufficient_data");
    expect(r.distinct_markets_used).toBe(1);
  });

  it("verdict is 'profitable' on a >5% per-copy return across enough markets", () => {
    const markets = new Map<string, ResolvedMarket>();
    const trades: any[] = [];
    for (let i = 0; i < 10; i++) {
      const c = `0xmkt${i}`;
      const tok = `yes${i}`;
      markets.set(c, { conditionId: c, winningIndex: 0, outcomePayouts: [1, 0], clobTokenIds: [tok, `no${i}`] });
      trades.push({ conditionId: c, asset: tok, side: "BUY", price: 0.40, usdcSize: 100, timestamp: 1_700_000_000 + i });
    }
    const r = backtestResolvedOutcomes("0xabc", trades, markets, { minDistinctMarkets: 10 });
    expect(r.verdict.rating).toBe("profitable");
    expect(r.distinct_markets_used).toBe(10);
  });

  it("de-dup collapses 299 same-market same-side orders into 1 logical bet", () => {
    const trades: any[] = [];
    for (let i = 0; i < 299; i++) {
      trades.push({ conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: 1_700_000_000 + i });
    }
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, market]]), { slippageBpsTiers: [0] });
    expect(r.trades_seen).toBe(299);
    expect(r.trades_after_dedup).toBe(1);
    expect(r.buckets[0].n_trades).toBe(1);
  });

  it("de-dup can be disabled (dedupWindowSec=0)", () => {
    const trades: any[] = [];
    for (let i = 0; i < 5; i++) {
      trades.push({ conditionId: cond, asset: yes, side: "BUY", price: 0.40, usdcSize: 100, timestamp: 1_700_000_000 + i });
    }
    const r = backtestResolvedOutcomes("0xabc", trades, new Map([[cond, market]]), { dedupWindowSec: 0, slippageBpsTiers: [0] });
    expect(r.trades_after_dedup).toBe(5);
    expect(r.buckets[0].n_trades).toBe(5);
  });
});

describe("backtestCopyTrades — natural-hold (redemption-based exits)", () => {
  const tokenId = "tkn-x";
  const cond = "0xnat";
  const t0 = Math.floor(Date.now() / 1000) - 86400 * 3; // 3 days ago

  it("emits an extra hold_min=-1 bucket exiting at the redemption timestamp", () => {
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.40],
      [t0, 0.40],
      [t0 + 3600, 0.55],
      [t0 + 7200, 0.60],          // <- redemption time
      [t0 + 14400, 0.45],
    ];
    const trades = [{ conditionId: cond, asset: tokenId, side: "BUY", price: 0.40, timestamp: t0 }];
    const r = backtestCopyTrades(
      "0xabc", trades,
      new Map([[tokenId, { tokenId, points: pts.map(([t, p]) => ({ t, p })) }]]),
      {
        lagsSec: [60], holdMinutes: [60],
        redemptionByCondition: new Map([[cond, t0 + 7200]]),
      },
    );
    const natural = r.buckets.find((b) => b.hold_min === -1);
    expect(natural).toBeDefined();
    expect(natural!.n_trades).toBe(1);
    // YES rose from 0.40 → 0.60 by redemption → profitable bullish copy.
    expect(natural!.pnl_usd).toBeGreaterThan(0);
  });

  it("does NOT emit the natural bucket when redemptionByCondition is omitted", () => {
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.40], [t0, 0.40], [t0 + 7200, 0.60], [t0 + 14400, 0.45],
    ];
    const trades = [{ conditionId: cond, asset: tokenId, side: "BUY", price: 0.40, timestamp: t0 }];
    const r = backtestCopyTrades(
      "0xabc", trades,
      new Map([[tokenId, { tokenId, points: pts.map(([t, p]) => ({ t, p })) }]]),
      { lagsSec: [60], holdMinutes: [60] },
    );
    expect(r.buckets.some((b) => b.hold_min === -1)).toBe(false);
  });

  it("skips the natural bucket when redemption time is before/at entry+lag", () => {
    const pts: Array<[number, number]> = [
      [t0 - 60, 0.40], [t0, 0.40], [t0 + 7200, 0.60],
    ];
    const trades = [{ conditionId: cond, asset: tokenId, side: "BUY", price: 0.40, timestamp: t0 }];
    const r = backtestCopyTrades(
      "0xabc", trades,
      new Map([[tokenId, { tokenId, points: pts.map(([t, p]) => ({ t, p })) }]]),
      {
        lagsSec: [60], holdMinutes: [60],
        // Redemption BEFORE the trade — natural hold doesn't make sense, skip.
        redemptionByCondition: new Map([[cond, t0 - 100]]),
      },
    );
    const natural = r.buckets.find((b) => b.hold_min === -1);
    expect(natural?.n_trades ?? 0).toBe(0);
  });
});


