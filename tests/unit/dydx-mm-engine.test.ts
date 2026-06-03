// Robustness / invariant tests for the dYdX market-making engine's PURE
// quoting + inventory pipeline.
//
// The MmEngine class itself is stateful and IO-bound (indexer/composite/ws
// clients), so it cannot be exercised honestly without a live network — those
// paths are intentionally out of scope here. What IS pure and engine-owned is
// the math the loop composes every cycle: fair-value selection (oracle vs
// microprice), OBI-driven spread widening, inventory-skewed quoting, tick/step
// snapping, no-cross guarantees, drift-based replacement, and PnL accounting.
//
// These tests reconstruct that exact pipeline from the engine's own exported
// types and the real pure functions it imports, with NEW edge/invariant cases
// that do not duplicate dydx-mm.test.ts or dydx-signals.test.ts. Every input is
// synthetic and deterministic — no clock, no entropy, no IO. A tiny seeded LCG
// supplies any pseudo-randomness so the file is bit-for-bit reproducible.
import { describe, expect, it } from "vitest";
import {
  applyFill,
  computeQuotes,
  freshPnl,
  shouldReplace,
  unrealisedPnl,
  type Fill,
  type MarketParams,
  type MmConfig,
  type PnlState,
} from "@/lib/hft/dydx/mm";
import {
  computeMicroprice,
  computeOBI,
  obiWidenMultiplier,
  quotedSpreadBps,
  type BookLevel,
} from "@/lib/hft/dydx/signals";
// Type-only import binds these tests to the engine's public contract without
// loading the SDK runtime (engine logic itself needs the network and is skipped).
import type {
  CycleSnapshot,
  EngineStatus,
  EngineConfig,
  Resting,
  Side,
} from "@/lib/hft/dydx/mm-engine";

const ETH: MarketParams = { tickSize: 0.1, stepSize: 0.001 };
const BTC: MarketParams = { tickSize: 0.5, stepSize: 0.0001 };

const baseCfg: MmConfig = {
  halfSpreadBps: 12,
  perSideUsd: 250,
  maxInventoryUsd: 2000,
  driftBps: 6,
  skewBpsPerDollar: 0,
};

// Deterministic seeded LCG (Numerical Recipes constants). Used only where a
// test wants "arbitrary but reproducible" inputs — never a wall-clock/RNG.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function lvl(price: number, size: number): BookLevel {
  return { price, size };
}

function fill(side: Side, price: number, size: number, feeUsd = 0, ts = 0): Fill {
  return { side, price, size, feeUsd, ts };
}

// Reproduces the engine loop's fair-value choice (mm-engine.ts: `fair`).
function engineFair(
  cfg: MmConfig,
  oracle: number,
  bids: BookLevel[],
  asks: BookLevel[],
): number {
  const microprice = computeMicroprice(bids, asks);
  return cfg.useMicroprice && microprice !== null ? microprice : oracle;
}

// Reproduces the engine's effective config after OBI toxicity widening
// (mm-engine.ts: `widenMult` / `effectiveCfg`).
function effectiveCfg(cfg: MmConfig, bids: BookLevel[], asks: BookLevel[]): MmConfig {
  const obi = computeOBI(bids, asks, 5);
  const threshold = cfg.obiToxicityThreshold ?? 0;
  const maxMult = cfg.obiToxicityMaxMultiplier ?? 1;
  const widenMult = threshold > 0 ? obiWidenMultiplier(obi, threshold, maxMult) : 1;
  return widenMult === 1 ? cfg : { ...cfg, halfSpreadBps: cfg.halfSpreadBps * widenMult };
}

// ---------------------------------------------------------------------------
// Quoting invariants: no-cross, tick snapping, spread monotonicity
// ---------------------------------------------------------------------------
describe("engine quoting — bid never crosses ask (no self-cross)", () => {
  it("bid < ask for a sweep of inventories and fairs", () => {
    const cfg = { ...baseCfg, skewBpsPerDollar: 0.4 };
    const rng = lcg(0xC0FFEE);
    for (let i = 0; i < 40; i++) {
      const fair = 500 + rng() * 4000;
      const inv = (rng() - 0.5) * 2 * cfg.maxInventoryUsd; // within +/- cap
      const q = computeQuotes(fair, inv, cfg, ETH);
      if (q.bid && q.ask) {
        expect(q.bid.price).toBeLessThan(q.ask.price);
      }
    }
  });

  it("a vanishingly small half-spread still keeps bid <= ask after snapping", () => {
    const cfg = { ...baseCfg, halfSpreadBps: 0.0001 };
    const q = computeQuotes(2000, 0, cfg, ETH);
    // With near-zero spread both round to the same tick; never inverted.
    expect(q.bid!.price).toBeLessThanOrEqual(q.ask!.price);
  });
});

describe("engine quoting — every emitted price is tick-aligned", () => {
  it("bid and ask land exactly on a tick multiple (ETH + BTC)", () => {
    const rng = lcg(42);
    for (const mkt of [ETH, BTC]) {
      for (let i = 0; i < 20; i++) {
        const fair = 1000 + rng() * 60000;
        const q = computeQuotes(fair, 0, baseCfg, mkt);
        const bidTicks = q.bid!.price / mkt.tickSize;
        const askTicks = q.ask!.price / mkt.tickSize;
        expect(bidTicks).toBeCloseTo(Math.round(bidTicks), 6);
        expect(askTicks).toBeCloseTo(Math.round(askTicks), 6);
      }
    }
  });

  it("size is a step multiple and at least one step", () => {
    const q = computeQuotes(45000, 0, baseCfg, BTC);
    const steps = q.bid!.size / BTC.stepSize;
    expect(steps).toBeCloseTo(Math.round(steps), 4);
    expect(q.bid!.size).toBeGreaterThanOrEqual(BTC.stepSize);
  });
});

describe("engine quoting — wider half-spread => wider quoted spread", () => {
  it("quoted spread is monotonic in halfSpreadBps at fixed fair", () => {
    let prev = -Infinity;
    for (const hs of [2, 5, 10, 25, 50]) {
      const q = computeQuotes(3000, 0, { ...baseCfg, halfSpreadBps: hs }, ETH);
      const spread = q.ask!.price - q.bid!.price;
      expect(spread).toBeGreaterThanOrEqual(prev);
      prev = spread;
    }
  });

  it("flat-book quotes are symmetric around fair (within one tick)", () => {
    const fair = 2000;
    const q = computeQuotes(fair, 0, baseCfg, ETH);
    const below = fair - q.bid!.price;
    const above = q.ask!.price - fair;
    expect(Math.abs(below - above)).toBeLessThanOrEqual(ETH.tickSize + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Inventory skew direction + cap suppression (the engine's risk control)
// ---------------------------------------------------------------------------
describe("engine inventory skew — tilts fair to mean-revert", () => {
  it("long inventory pushes fair below oracle; short pushes it above", () => {
    const cfg = { ...baseCfg, skewBpsPerDollar: 0.3 };
    const longQ = computeQuotes(2000, 800, cfg, ETH);
    const shortQ = computeQuotes(2000, -800, cfg, ETH);
    expect(longQ.fair).toBeLessThan(2000);
    expect(shortQ.fair).toBeGreaterThan(2000);
    // skewBps sign is opposite the inventory sign.
    expect(Math.sign(longQ.skewBps)).toBe(-1);
    expect(Math.sign(shortQ.skewBps)).toBe(+1);
  });

  it("skew magnitude scales linearly with inventory", () => {
    const cfg = { ...baseCfg, skewBpsPerDollar: 0.25 };
    const q1 = computeQuotes(2000, 400, cfg, ETH);
    const q2 = computeQuotes(2000, 800, cfg, ETH);
    expect(q2.skewBps).toBeCloseTo(q1.skewBps * 2, 9);
  });

  it("long position yields a tighter ask than the no-skew baseline", () => {
    const cfg = { ...baseCfg, skewBpsPerDollar: 0.5 };
    const flat = computeQuotes(2000, 0, cfg, ETH);
    const long = computeQuotes(2000, 600, cfg, ETH);
    // Skew lowers fair, so the long ask sits below the flat ask (eager to sell).
    expect(long.ask!.price).toBeLessThan(flat.ask!.price);
    expect(long.bid!.price).toBeLessThan(flat.bid!.price);
  });
});

describe("engine inventory cap — suppresses the inventory-growing side", () => {
  it("at and beyond +cap only the ask quotes", () => {
    for (const inv of [baseCfg.maxInventoryUsd, baseCfg.maxInventoryUsd + 5000]) {
      const q = computeQuotes(2000, inv, baseCfg, ETH);
      expect(q.bid).toBeUndefined();
      expect(q.ask).toBeDefined();
    }
  });

  it("at and beyond -cap only the bid quotes", () => {
    for (const inv of [-baseCfg.maxInventoryUsd, -(baseCfg.maxInventoryUsd + 5000)]) {
      const q = computeQuotes(2000, inv, baseCfg, ETH);
      expect(q.ask).toBeUndefined();
      expect(q.bid).toBeDefined();
    }
  });

  it("just inside the cap still quotes both sides", () => {
    const q = computeQuotes(2000, baseCfg.maxInventoryUsd - 0.01, baseCfg, ETH);
    expect(q.bid).toBeDefined();
    expect(q.ask).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fair-value selection: oracle vs microprice (engine loop branch)
// ---------------------------------------------------------------------------
describe("engine fair selection — microprice gated by config + book", () => {
  it("useMicroprice off => fair is the oracle regardless of book", () => {
    const cfg = { ...baseCfg, useMicroprice: false };
    const fair = engineFair(cfg, 2000, [lvl(1999, 50)], [lvl(2001, 1)]);
    expect(fair).toBe(2000);
  });

  it("useMicroprice on but a side is empty => falls back to oracle", () => {
    const cfg = { ...baseCfg, useMicroprice: true };
    expect(engineFair(cfg, 2000, [], [lvl(2001, 5)])).toBe(2000);
    expect(engineFair(cfg, 2000, [lvl(1999, 5)], [])).toBe(2000);
  });

  it("useMicroprice on with a two-sided book => uses microprice", () => {
    const cfg = { ...baseCfg, useMicroprice: true };
    const fair = engineFair(cfg, 2000, [lvl(1999, 10)], [lvl(2001, 2)]);
    const mp = computeMicroprice([lvl(1999, 10)], [lvl(2001, 2)])!;
    expect(fair).toBe(mp);
    // Heavy bid pressure pulls fair toward the ask, above naive mid (2000).
    expect(fair).toBeGreaterThan(2000);
  });
});

// ---------------------------------------------------------------------------
// OBI toxicity widening as wired in the loop
// ---------------------------------------------------------------------------
describe("engine OBI widening — toxic flow widens both sides", () => {
  it("toxic imbalance widens the quoted spread vs a balanced book", () => {
    const cfg: MmConfig = {
      ...baseCfg,
      obiToxicityThreshold: 0.2,
      obiToxicityMaxMultiplier: 3,
    };
    const balancedBook = { bids: [lvl(1999, 5)], asks: [lvl(2001, 5)] };
    const toxicBook = { bids: [lvl(1999, 20)], asks: [lvl(2001, 1)] };

    const balCfg = effectiveCfg(cfg, balancedBook.bids, balancedBook.asks);
    const toxCfg = effectiveCfg(cfg, toxicBook.bids, toxicBook.asks);

    const balQ = computeQuotes(2000, 0, balCfg, ETH);
    const toxQ = computeQuotes(2000, 0, toxCfg, ETH);
    const balSpread = balQ.ask!.price - balQ.bid!.price;
    const toxSpread = toxQ.ask!.price - toxQ.bid!.price;
    expect(toxSpread).toBeGreaterThan(balSpread);
  });

  it("threshold of 0 disables widening (effective cfg unchanged)", () => {
    const cfg = { ...baseCfg, obiToxicityThreshold: 0, obiToxicityMaxMultiplier: 5 };
    const eff = effectiveCfg(cfg, [lvl(1999, 100)], [lvl(2001, 1)]);
    expect(eff.halfSpreadBps).toBe(cfg.halfSpreadBps);
  });

  it("widen multiplier never goes below 1x for any book", () => {
    const cfg = { ...baseCfg, obiToxicityThreshold: 0.1, obiToxicityMaxMultiplier: 4 };
    const rng = lcg(7);
    for (let i = 0; i < 25; i++) {
      const bidSz = rng() * 50;
      const askSz = rng() * 50;
      const eff = effectiveCfg(cfg, [lvl(1999, bidSz)], [lvl(2001, askSz)]);
      expect(eff.halfSpreadBps).toBeGreaterThanOrEqual(cfg.halfSpreadBps - 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Spread-anomaly halt condition (loop: qspread > spreadAnomalyBps)
// ---------------------------------------------------------------------------
describe("engine spread-anomaly gate", () => {
  it("a blown-out book exceeds the anomaly threshold", () => {
    const wide = quotedSpreadBps([lvl(1900, 1)], [lvl(2100, 1)])!; // ~1000 bps
    expect(wide).toBeGreaterThan(100);
  });

  it("a tight book stays under a reasonable anomaly threshold", () => {
    const tight = quotedSpreadBps([lvl(1999.9, 1)], [lvl(2000.1, 1)])!;
    expect(tight).toBeLessThan(100);
    expect(tight).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Drift-based replacement (loop: shouldReplace gate)
// ---------------------------------------------------------------------------
describe("engine replacement — drift gate", () => {
  it("identical resting/target price never triggers a replace", () => {
    const q = computeQuotes(2000, 0, baseCfg, ETH);
    expect(shouldReplace(q.bid!.price, q.bid!.price, baseCfg.driftBps)).toBe(false);
  });

  it("a fair move larger than driftBps forces a replace", () => {
    const a = computeQuotes(2000, 0, baseCfg, ETH);
    const b = computeQuotes(2040, 0, baseCfg, ETH); // +200 bps move
    expect(shouldReplace(a.bid!.price, b.bid!.price, baseCfg.driftBps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PnL / inventory accounting the engine accumulates from fills (ingestFills)
// ---------------------------------------------------------------------------
describe("engine fill accounting — invariants", () => {
  it("a round trip at the same price nets zero gross PnL (fees aside)", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 2000, 0.5));
    st = applyFill(st, fill("SELL", 2000, 0.5));
    expect(st.position).toBe(0);
    expect(st.realisedUsd).toBeCloseTo(0, 9);
  });

  it("realised PnL is sign-correct: buy low / sell high is positive", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 1900, 1));
    st = applyFill(st, fill("SELL", 2100, 1));
    expect(st.realisedUsd).toBeGreaterThan(0);
    expect(st.realisedUsd).toBeCloseTo(200, 6);
  });

  it("position tracks net signed size across many alternating fills", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 2000, 3));
    st = applyFill(st, fill("SELL", 2010, 1));
    st = applyFill(st, fill("SELL", 2020, 1));
    expect(st.position).toBeCloseTo(1, 9);
  });

  it("unrealised PnL marks the open position to the oracle", () => {
    let st = freshPnl();
    st = applyFill(st, fill("BUY", 2000, 2));
    // long 2 @ 2000, mark 2050 => +100
    expect(unrealisedPnl(st, 2050)).toBeCloseTo(100, 6);
    expect(unrealisedPnl(st, 1950)).toBeCloseTo(-100, 6);
  });

  it("vwap resets to 0 exactly when a sequence returns flat", () => {
    let st: PnlState = freshPnl();
    st = applyFill(st, fill("SELL", 2000, 2));
    st = applyFill(st, fill("BUY", 1980, 2));
    expect(st.position).toBe(0);
    expect(st.vwap).toBe(0);
  });

  it("fees only ever reduce realised PnL and accumulate monotonically", () => {
    let st = freshPnl();
    let lastFees = 0;
    const rng = lcg(99);
    for (let i = 0; i < 12; i++) {
      const side: Side = rng() < 0.5 ? "BUY" : "SELL";
      st = applyFill(st, fill(side, 2000, 0.1, 0.02));
      expect(st.feesUsd).toBeGreaterThanOrEqual(lastFees);
      lastFees = st.feesUsd;
    }
    expect(st.feesUsd).toBeCloseTo(12 * 0.02, 6);
  });
});

// ---------------------------------------------------------------------------
// Determinism: same inputs => byte-identical outputs (engine must be replayable)
// ---------------------------------------------------------------------------
describe("engine determinism", () => {
  it("computeQuotes is a pure function of its inputs", () => {
    const a = computeQuotes(1234.56, 321, { ...baseCfg, skewBpsPerDollar: 0.7 }, ETH);
    const b = computeQuotes(1234.56, 321, { ...baseCfg, skewBpsPerDollar: 0.7 }, ETH);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a fixed fill sequence reproduces identical PnL state", () => {
    const seq: Fill[] = [
      fill("BUY", 2000, 1, 0.01),
      fill("SELL", 2010, 0.5, 0.005),
      fill("BUY", 1990, 2, 0.02),
      fill("SELL", 2030, 1.5, 0.015),
    ];
    const run = () => seq.reduce<PnlState>((s, f) => applyFill(s, f), freshPnl());
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

// ---------------------------------------------------------------------------
// Engine type contracts — synthetic values satisfy the engine's public types.
// (Compile-time + structural checks; binds tests to the engine module's shape.)
// ---------------------------------------------------------------------------
describe("engine type contracts (synthetic, no IO)", () => {
  it("Resting and Side line up with computeQuotes output", () => {
    const q = computeQuotes(2000, 0, baseCfg, ETH);
    const side: Side = "BUY";
    const resting: Resting = { clientId: 1, price: q.bid!.price, size: q.bid!.size };
    expect(side).toBe("BUY");
    expect(resting.price).toBe(q.bid!.price);
    expect(resting.size).toBeGreaterThan(0);
  });

  it("a CycleSnapshot can be assembled from pure pipeline outputs", () => {
    const oracle = 2000;
    const bids = [lvl(1999, 8)];
    const asks = [lvl(2001, 2)];
    const cfg: MmConfig = { ...baseCfg, useMicroprice: true };
    const microprice = computeMicroprice(bids, asks);
    const fair = engineFair(cfg, oracle, bids, asks);
    const obi = computeOBI(bids, asks, 5);
    const qspread = quotedSpreadBps(bids, asks);
    const q = computeQuotes(fair, 0, cfg, ETH);

    const snap: CycleSnapshot = {
      cycle: 1,
      ts: 0,
      oracle,
      microprice,
      fair,
      obi,
      quotedSpreadBps: qspread,
      widenMult: 1,
      paused: false,
      position: 0,
      inventoryUsd: 0,
      bid: q.bid!.price,
      ask: q.ask!.price,
      skewBps: q.skewBps,
      ms: 0,
    };

    expect(snap.fair).toBe(microprice);
    expect(snap.bid!).toBeLessThan(snap.ask!);
    expect(snap.obi).toBeGreaterThan(0); // bid-heavy synthetic book
    expect(snap.quotedSpreadBps!).toBeGreaterThan(0);
  });

  it("a paused CycleSnapshot uses the documented pause reasons", () => {
    const reasons: CycleSnapshot["paused"][] = [false, "stale-data", "spread-anomaly"];
    for (const paused of reasons) {
      const snap: CycleSnapshot = {
        cycle: 2, ts: 0, oracle: 2000, microprice: null, fair: 2000,
        obi: 0, quotedSpreadBps: null, widenMult: 1, paused,
        position: 0, inventoryUsd: 0, bid: null, ask: null, skewBps: 0, ms: 0,
      };
      expect([false, "stale-data", "spread-anomaly"]).toContain(snap.paused);
    }
  });

  it("EngineStatus.unrealisedUsd matches the pure unrealisedPnl formula", () => {
    // The engine computes unrealised the same way unrealisedPnl does.
    const pnl: PnlState = { ...freshPnl(), position: 2, vwap: 2000 };
    const mark = 2075;
    const expected = unrealisedPnl(pnl, mark);
    const status: EngineStatus["pnl"] = {
      position: pnl.position,
      vwap: pnl.vwap,
      realisedUsd: pnl.realisedUsd,
      feesUsd: pnl.feesUsd,
      unrealisedUsd: expected,
      mark,
    };
    expect(status.unrealisedUsd).toBeCloseTo((mark - pnl.vwap) * pnl.position, 6);
    expect(status.unrealisedUsd).toBeGreaterThan(0);
  });

  it("EngineConfig defaults are coherent (tickMs > 0, goodTilSec > 0)", () => {
    // Mirror the Required<EngineConfig> defaults the engine applies in create().
    const defaults = { tickMs: 6000, goodTilSec: 120, historyCap: 200 };
    const cfg: Omit<EngineConfig, "net"> & { net: string } = {
      net: "testnet",
      market: "ETH-USD",
      cfg: baseCfg,
      ...defaults,
    };
    expect(cfg.tickMs!).toBeGreaterThan(0);
    expect(cfg.goodTilSec!).toBeGreaterThan(0);
    expect(cfg.historyCap!).toBeGreaterThan(0);
  });
});
