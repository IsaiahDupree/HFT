/**
 * Replay-fitness robustness tests — drive the REAL `computeReplayFitness`
 * pipeline (iterTickContexts → decide → applySignal → markToMarket → scoreAgent)
 * against a synthetic in-memory SQLite seeded with Coinbase snapshots. No
 * network, no real files, no wall-clock for inputs (every timestamp is a fixed
 * ISO string derived from a constant epoch), no nondeterministic RNG (the
 * genomes exercised here are purely price-driven — `Math.random` is never
 * consulted by cb_breakout / cb_mean_reversion).
 *
 * These complement arena-score.test.ts (which unit-tests scoreAgent directly):
 * here we assert the END-TO-END replay scorer's invariants — empty/degenerate
 * windows, determinism, bounds, the ending_equity↔pnl_pct identity, scale
 * invariance in starting cash, and monotonicity of fitness in realized PnL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMemoryDb } from "../helpers/db";
import type { Genome } from "@/lib/arena/genome";

// In-memory DB shared with the module under test via the standard mock the
// integration suite uses. A fresh DB is created per test in beforeEach.
let memDb: ReturnType<typeof makeMemoryDb> | null = null;
import { vi } from "vitest";
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

// Fixed reference epoch (2026-01-01T00:00:00Z). All synthetic timestamps are
// derived from this constant — never from Date.now() — so the suite is fully
// deterministic.
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
function iso(offsetMin: number): string {
  return new Date(BASE_MS + offsetMin * MIN).toISOString();
}

/** Seed one Coinbase snapshot. captured_at must be a Z-suffixed ISO string so
 *  the context loader's `captured_at <= nowIso` comparison is lexicographic-safe. */
function seedCb(productId: string, offsetMin: number, price: number): void {
  memDb!.prepare(
    `INSERT INTO coinbase_snapshots (product_id, best_bid, best_ask, midpoint, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(productId, price - 0.5, price + 0.5, price, iso(offsetMin));
}

/** Seed a price path: one snapshot per minute starting at offsetMin=0. */
function seedPath(productId: string, prices: number[]): void {
  for (let i = 0; i < prices.length; i++) seedCb(productId, i, prices[i]);
}

function cbBreakout(overrides: Partial<Extract<Genome, { kind: "cb_breakout" }>["params"]> = {}): Genome {
  return {
    kind: "cb_breakout",
    params: {
      product_id: "BTC-USD",
      lookback_min: 1440,
      breakout_mult: 1.001,
      entry_size_usd: 10,
      target_pct: 0.50,   // huge target so a modest rise never closes the position
      stop_pct: 0.50,     // huge stop so a modest dip never closes the position
      time_stop_min: 4320, // 3 days — beyond any window we test
      ...overrides,
    },
  };
}

// Mean-reversion is purely price-driven: a BUY fires on the first tick whose
// z-score (price vs rolling mean) drops at or below −z_entry. We use it for all
// "active trade" scenarios because cb_breakout's rolling-max window includes the
// latest price, so its `latest > max × mult` gate can never trip on monotone data.
const MR_ENTRY_SIZE_USD = 10;
function cbMeanReversion(overrides: Partial<Extract<Genome, { kind: "cb_mean_reversion" }>["params"]> = {}): Genome {
  return {
    kind: "cb_mean_reversion",
    params: {
      product_id: "BTC-USD",
      lookback_min: 4320,
      z_entry: 1.0,
      z_exit: 0.0,
      entry_size_usd: MR_ENTRY_SIZE_USD,
      stop_pct: 0.10,
      time_stop_min: 4320,
      ...overrides,
    },
  };
}

// 13 flat ticks build a tight mean (sd≈0 needs ≥12 samples); the subsequent dip
// to 95 then trips the −1σ entry on the first 95 tick. Identical prefix across
// variants guarantees the SAME entry tick + entry price, so downstream metrics
// differ only by the terminal price.
const MR_DIP_PREFIX = new Array(13).fill(100) as number[];

// A window covering the full seeded path at 1-min ticks. End is well past the
// last snapshot so the final price is always visible on the last tick.
function fullWindow(lastOffsetMin: number) {
  return { startIso: iso(0), endIso: iso(lastOffsetMin), tickIntervalMin: 1, startingCash: 1000 };
}

let savedShadow: string | undefined;
beforeEach(() => {
  memDb?.close();
  memDb = makeMemoryDb();
  // Shadow-gate path touches extra tables + the decision pipeline; keep it OFF
  // so the replay is the pure decide/apply/mtm loop (matches prod default).
  savedShadow = process.env.ARENA_SHADOW_GATES;
  delete process.env.ARENA_SHADOW_GATES;
});
afterEach(() => {
  if (savedShadow === undefined) delete process.env.ARENA_SHADOW_GATES;
  else process.env.ARENA_SHADOW_GATES = savedShadow;
  memDb?.close();
  memDb = null;
});

async function compute(genome: Genome, opts: Parameters<typeof import("@/lib/arena/replay-fitness").computeReplayFitness>[1]) {
  const { computeReplayFitness } = await import("@/lib/arena/replay-fitness");
  return computeReplayFitness(genome, opts);
}

describe("computeReplayFitness — empty / degenerate windows", () => {
  it("no snapshots at all → zero ticks, zero trades, flat equity", async () => {
    const r = await compute(cbBreakout(), fullWindow(60));
    expect(r.ticks).toBe(0);
    expect(r.trades_count).toBe(0);
    expect(r.win_rate).toBe(0);
    expect(r.pnl_pct).toBe(0);
    expect(r.max_dd_pct).toBe(0);
    expect(r.fitness).toBe(0);
    expect(r.starting_cash).toBe(1000);
    expect(r.ending_equity).toBe(1000);
  });

  it("snapshots present but genome never fires → ticks>0, no trades, flat equity", async () => {
    // Perfectly flat path: breakout condition (latest > max × 1.001) never holds.
    seedPath("BTC-USD", new Array(30).fill(100));
    const r = await compute(cbBreakout(), fullWindow(30));
    expect(r.ticks).toBeGreaterThan(0);
    expect(r.trades_count).toBe(0);
    expect(r.pnl_pct).toBe(0);
    expect(r.max_dd_pct).toBe(0);
    expect(r.fitness).toBe(0);
    expect(r.ending_equity).toBeCloseTo(r.starting_cash, 9);
  });

  it("window where end precedes start → no ticks yielded", async () => {
    seedPath("BTC-USD", new Array(30).fill(100));
    const r = await compute(cbBreakout(), { startIso: iso(20), endIso: iso(10), tickIntervalMin: 1, startingCash: 1000 });
    expect(r.ticks).toBe(0);
    expect(r.trades_count).toBe(0);
    expect(r.ending_equity).toBe(1000);
  });

  it("snapshots exist only for a different product → genome holds forever", async () => {
    seedPath("ETH-USD", [100, 101, 102, 103, 104, 105, 106, 107]);
    const r = await compute(cbBreakout({ product_id: "BTC-USD" }), fullWindow(8));
    // Context still yields ticks (ETH snapshots exist) but BTC genome never finds its product.
    expect(r.ticks).toBeGreaterThan(0);
    expect(r.trades_count).toBe(0);
    expect(r.pnl_pct).toBe(0);
    expect(r.ending_equity).toBe(1000);
  });
});

describe("computeReplayFitness — determinism", () => {
  it("identical inputs produce byte-identical results across repeated calls", async () => {
    seedPath("BTC-USD", [100, 100, 100, 100, 101, 102, 103, 104, 105, 106]);
    const a = await compute(cbBreakout(), fullWindow(10));
    const b = await compute(cbBreakout(), fullWindow(10));
    const c = await compute(cbBreakout(), fullWindow(10));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("a fresh genome object with the same params yields the same result", async () => {
    seedPath("BTC-USD", [100, 100, 100, 100, 101, 102, 103, 104, 105, 106]);
    const a = await compute(cbBreakout(), fullWindow(10));
    const b = await compute(cbBreakout(), fullWindow(10)); // separate object, same shape
    expect(b).toEqual(a);
  });

  it("mean-reversion genome is also deterministic (price-driven, no RNG)", async () => {
    // A dip below the rolling mean by >1 sigma triggers a BUY.
    const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 95];
    seedPath("BTC-USD", prices);
    const a = await compute(cbMeanReversion(), fullWindow(prices.length));
    const b = await compute(cbMeanReversion(), fullWindow(prices.length));
    expect(b).toEqual(a);
  });
});

describe("computeReplayFitness — structural bounds & identities", () => {
  it("win_rate is always within [0, 1]", async () => {
    seedPath("BTC-USD", [100, 100, 100, 100, 101, 102, 103, 104, 103, 102]);
    const r = await compute(cbBreakout(), fullWindow(10));
    expect(r.win_rate).toBeGreaterThanOrEqual(0);
    expect(r.win_rate).toBeLessThanOrEqual(1);
  });

  it("max_dd_pct, trades_count, ticks are all non-negative", async () => {
    seedPath("BTC-USD", [100, 100, 100, 100, 99, 98, 97, 96, 95, 94]);
    const r = await compute(cbBreakout(), fullWindow(10));
    expect(r.max_dd_pct).toBeGreaterThanOrEqual(0);
    expect(r.trades_count).toBeGreaterThanOrEqual(0);
    expect(r.ticks).toBeGreaterThanOrEqual(0);
  });

  it("win_rate is 0 whenever there were no closed trades", async () => {
    seedPath("BTC-USD", new Array(20).fill(100)); // flat → no entries → no exits
    const r = await compute(cbBreakout(), fullWindow(20));
    expect(r.trades_count).toBe(0);
    expect(r.win_rate).toBe(0);
  });

  it("no-trade window: pnl_pct equals (ending_equity − starting_cash) / starting_cash exactly", async () => {
    // Flat path → no positions ever opened → scoreAgent's liveEquity and the
    // replay's ending_equity coincide (open-principal term is 0 in both).
    seedPath("BTC-USD", [100, 100, 100, 100, 101, 103, 105, 107, 108, 109]);
    const r = await compute(cbBreakout(), fullWindow(10));
    expect(r.pnl_pct).toBeCloseTo((r.ending_equity - r.starting_cash) / r.starting_cash, 9);
  });

  it("closed-trade window: pnl_pct equals (ending_equity − starting_cash) / starting_cash exactly", async () => {
    // Dip → BUY → recover to the rolling mean → target-hit EXIT. No positions
    // remain open at window end, so the identity holds with the realized PnL.
    const prices = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 0.0 }), fullWindow(prices.length));
    expect(r.trades_count).toBe(1); // the round-trip closed
    expect(r.pnl_pct).toBeCloseTo((r.ending_equity - r.starting_cash) / r.starting_cash, 9);
  });

  it("open-position window: pnl_pct = (ending_equity − open_principal − starting_cash)/starting_cash", async () => {
    // A single position is still OPEN at window end. scoreAgent computes pnl_pct
    // from cash+unrealized only (position_basket_json stays "[]" in replay), while
    // ending_equity additionally folds in the locked principal — so the two differ
    // by exactly one entry's size_usd. This pins down that real behavior.
    const prices = [...MR_DIP_PREFIX, 95, 95, 95];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(prices.length));
    expect(r.trades_count).toBe(0); // still open → no closed trade
    const openPrincipal = MR_ENTRY_SIZE_USD; // exactly one open position of this size
    expect(r.pnl_pct).toBeCloseTo((r.ending_equity - openPrincipal - r.starting_cash) / r.starting_cash, 9);
  });

  it("starting_cash reflects the requested startingCash option", async () => {
    seedPath("BTC-USD", [100, 100, 100, 100, 101, 102]);
    const r = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(6), tickIntervalMin: 1, startingCash: 2500 });
    expect(r.starting_cash).toBe(2500);
  });

  it("fitness lies in the (pnl − 2·dd) + [0, 0.025] activity-bonus band, for a genome that actually trades", async () => {
    // Mean-reversion dip → BUY (entries_count ≥ 1) → the activity bonus is in
    // play, so fitness sits strictly inside the band, never below the base.
    const prices = [...MR_DIP_PREFIX, 95, 95, 95];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(prices.length));
    const base = r.pnl_pct - 2 * r.max_dd_pct;
    expect(r.fitness).toBeGreaterThanOrEqual(base - 1e-9);
    expect(r.fitness).toBeLessThanOrEqual(base + 0.025 + 1e-9);
    // One entry → +0.005 bonus → fitness strictly above the base.
    expect(r.fitness).toBeGreaterThan(base);
  });

  it("flat market → fitness exactly equals pnl_pct (no dd, no trades, no bonus)", async () => {
    seedPath("BTC-USD", new Array(15).fill(100));
    const r = await compute(cbBreakout(), fullWindow(15));
    expect(r.fitness).toBeCloseTo(r.pnl_pct, 12);
    expect(r.pnl_pct).toBe(0);
  });
});

describe("computeReplayFitness — scale invariance in starting cash", () => {
  it("trade STRUCTURE is independent of startingCash; ABSOLUTE pnl is invariant while pnl_pct scales with bankroll", async () => {
    // A real trade fires (mean-reversion dip BUY). entry_size_usd is fixed in
    // DOLLARS, so a 10× larger bankroll executes the identical $10 trade — the
    // trade structure (count, win-rate) and the absolute PnL are invariant, but
    // pnl_pct = realized_pnl / startingCash shrinks as the bankroll grows.
    const prices = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", prices);
    const small = await compute(cbMeanReversion({ z_exit: 0.0 }), { startIso: iso(0), endIso: iso(prices.length), tickIntervalMin: 1, startingCash: 1000 });
    const big = await compute(cbMeanReversion({ z_exit: 0.0 }), { startIso: iso(0), endIso: iso(prices.length), tickIntervalMin: 1, startingCash: 100_000 });
    expect(small.trades_count).toBe(1); // sanity: a trade actually happened
    // Structure: identical trade.
    expect(big.trades_count).toBe(small.trades_count);
    expect(big.win_rate).toBeCloseTo(small.win_rate, 9);
    // Absolute realized PnL (pnl_pct × startingCash) is invariant.
    expect(big.pnl_pct * big.starting_cash).toBeCloseTo(small.pnl_pct * small.starting_cash, 6);
    // ending_equity − startingCash (the absolute dollar PnL) is invariant.
    expect(big.ending_equity - big.starting_cash).toBeCloseTo(small.ending_equity - small.starting_cash, 6);
    // pnl_pct itself shrinks by exactly the bankroll ratio (100×).
    expect(big.pnl_pct).toBeCloseTo(small.pnl_pct / 100, 12);
    expect(big.pnl_pct).toBeLessThan(small.pnl_pct);
  });

  it("ending_equity scales additively with the extra starting cash", async () => {
    const prices = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", prices);
    const small = await compute(cbMeanReversion({ z_exit: 0.0 }), { startIso: iso(0), endIso: iso(prices.length), tickIntervalMin: 1, startingCash: 1000 });
    const big = await compute(cbMeanReversion({ z_exit: 0.0 }), { startIso: iso(0), endIso: iso(prices.length), tickIntervalMin: 1, startingCash: 100_000 });
    // Same trades, just a different cash cushion → equity differs by exactly the cash delta.
    expect(big.ending_equity - small.ending_equity).toBeCloseTo(99_000, 6);
  });
});

describe("computeReplayFitness — monotonicity in PnL", () => {
  it("with an identical entry, a higher terminal price ⇒ strictly higher pnl_pct and fitness", async () => {
    // Same dip-prefix ⇒ SAME entry tick + entry price + entry fee. The only
    // difference is the terminal price, which a still-open BUY marks to market.
    // (Both pnl values are negative here because the replay's scoreAgent path
    // excludes the locked principal of an open position — a real, documented
    // quirk; monotonicity in the terminal price holds regardless of sign.)
    const shallow = [...MR_DIP_PREFIX, 95, 96, 97]; // terminal 97
    const steep = [...MR_DIP_PREFIX, 95, 96, 99];   // terminal 99

    seedPath("BTC-USD", shallow);
    const rShallow = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(shallow.length));

    memDb!.close();
    memDb = makeMemoryDb();
    seedPath("BTC-USD", steep);
    const rSteep = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(steep.length));

    // Both fire exactly one BUY that stays open (target/stop/time-stop never hit).
    expect(rShallow.trades_count).toBe(0);
    expect(rSteep.trades_count).toBe(0);
    // Drawdown is the same negligible entry-fee blip in both runs.
    expect(rShallow.max_dd_pct).toBeLessThan(1e-3);
    expect(rSteep.max_dd_pct).toBeLessThan(1e-3);
    // Higher terminal price → strictly higher unrealized PnL → strictly higher fitness.
    expect(rSteep.pnl_pct).toBeGreaterThan(rShallow.pnl_pct);
    expect(rSteep.fitness).toBeGreaterThan(rShallow.fitness);
    // ending_equity (which DOES count the principal) is also strictly higher.
    expect(rSteep.ending_equity).toBeGreaterThan(rShallow.ending_equity);
  });

  it("a profitable round-trip yields positive pnl_pct; a losing one yields negative pnl_pct", async () => {
    // Dip → BUY → recover to mean → target-hit EXIT at a profit.
    const winning = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", winning);
    const win = await compute(cbMeanReversion({ z_exit: 0.0 }), fullWindow(winning.length));
    expect(win.trades_count).toBe(1);
    expect(win.win_rate).toBe(1);
    expect(win.pnl_pct).toBeGreaterThan(0);

    memDb!.close();
    memDb = makeMemoryDb();
    // Dip → BUY → crash through the −5% stop → stop-out EXIT at a loss.
    const losing = [...MR_DIP_PREFIX, 95, 80, 80];
    seedPath("BTC-USD", losing);
    const loss = await compute(cbMeanReversion({ z_exit: 0.0, stop_pct: 0.05 }), fullWindow(losing.length));
    expect(loss.trades_count).toBe(1);
    expect(loss.win_rate).toBe(0);
    expect(loss.pnl_pct).toBeLessThan(0);
  });

  it("a deeper terminal drop on an open BUY ⇒ no higher pnl_pct than a shallower drop", async () => {
    // Two open-position runs that both stay below entry: the one ending lower
    // must NOT score above the one ending higher (anti-monotone guard).
    const lessBad = [...MR_DIP_PREFIX, 95, 94, 94]; // terminal 94
    seedPath("BTC-USD", lessBad);
    const a = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(lessBad.length));

    memDb!.close();
    memDb = makeMemoryDb();
    const worse = [...MR_DIP_PREFIX, 95, 92, 92]; // terminal 92 (further below entry)
    seedPath("BTC-USD", worse);
    const b = await compute(cbMeanReversion({ z_exit: 5.0 }), fullWindow(worse.length));

    expect(a.trades_count).toBe(0);
    expect(b.trades_count).toBe(0);
    expect(b.pnl_pct).toBeLessThanOrEqual(a.pnl_pct);
  });
});

describe("computeReplayFitness — tick accounting", () => {
  it("more ticks are produced for a finer tick interval over the same window", async () => {
    seedPath("BTC-USD", new Array(40).fill(100));
    const coarse = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(40), tickIntervalMin: 5, startingCash: 1000 });
    const fine = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(40), tickIntervalMin: 1, startingCash: 1000 });
    expect(fine.ticks).toBeGreaterThan(coarse.ticks);
  });

  it("extending the window end never decreases the tick count", async () => {
    seedPath("BTC-USD", new Array(60).fill(100));
    const shortW = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(20), tickIntervalMin: 1, startingCash: 1000 });
    const longW = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(50), tickIntervalMin: 1, startingCash: 1000 });
    expect(longW.ticks).toBeGreaterThanOrEqual(shortW.ticks);
    expect(longW.ticks).toBeGreaterThan(0);
  });

  it("ticks before the first snapshot are skipped (no window yielded with empty history)", async () => {
    // Snapshots only from offset 30..39; ticks at 0..29 see no history and are skipped.
    for (let i = 30; i < 40; i++) seedCb("BTC-USD", i, 100);
    const r = await compute(cbBreakout(), { startIso: iso(0), endIso: iso(40), tickIntervalMin: 1, startingCash: 1000 });
    // At most 11 ticks (offsets 30..40 inclusive) can yield a non-empty window.
    expect(r.ticks).toBeGreaterThan(0);
    expect(r.ticks).toBeLessThanOrEqual(11);
  });
});

describe("computeReplayFitness — closed-trade accounting", () => {
  it("a round-trip (dip BUY then mean-recover target hit) registers exactly one winning closed trade", async () => {
    // z_exit=0 ⇒ target = rolling mean (≈100). Recovery to 100 trips the target.
    const prices = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 0.0 }), fullWindow(prices.length));
    expect(r.trades_count).toBe(1);
    expect(r.win_rate).toBe(1); // the only closed trade was profitable
    expect(r.win_rate).toBeGreaterThanOrEqual(0);
    expect(r.win_rate).toBeLessThanOrEqual(1);
    expect(r.pnl_pct).toBeGreaterThan(0);
  });

  it("a stop-out registers a closed trade with win_rate 0 and negative pnl", async () => {
    // Dip BUY at 95, then a crash to 80 punches through the −5% stop (95×0.95=90.25).
    const prices = [...MR_DIP_PREFIX, 95, 80, 80];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 0.0, stop_pct: 0.05 }), fullWindow(prices.length));
    expect(r.trades_count).toBe(1);
    expect(r.win_rate).toBe(0);
    expect(r.pnl_pct).toBeLessThan(0); // realized loss + coinbase taker fees
  });

  it("after a closed round-trip, no position remains open ⇒ ending_equity ≈ starting + realized PnL", async () => {
    const prices = [...MR_DIP_PREFIX, 95, 100, 100];
    seedPath("BTC-USD", prices);
    const r = await compute(cbMeanReversion({ z_exit: 0.0 }), fullWindow(prices.length));
    // No open principal at end ⇒ the pnl_pct↔equity identity is exact.
    expect(r.ending_equity).toBeCloseTo(r.starting_cash * (1 + r.pnl_pct), 6);
  });
});
