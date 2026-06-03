/**
 * Pure-function tests for the live per-agent diagnostic reader
 * (`src/lib/arena/diagnostic.ts`). The diagnostic mirrors sim.ts:decide() but
 * returns the numeric reading + threshold instead of a Signal.
 *
 * These tests construct fully-synthetic LiveAgents + TickContexts and assert
 * concrete properties (status, label format, invariants, monotonicity,
 * determinism, edge/empty inputs) of every branch that is computable WITHOUT
 * touching the database, network, or files. Branches that require IO
 * (cb_momentum_burst's candle load, wallet_copy_filtered, llm_probability_oracle)
 * are only exercised through their pure early-return paths.
 *
 * Fully deterministic: no wall-clock reads, no nondeterministic RNG. A small
 * seeded LCG is used only for the determinism sweeps and produces a fixed
 * stream for a fixed seed.
 */
import { describe, expect, it } from "vitest";
import { diagnoseAgent, diagnoseAgents, type AgentDiagnostic, type DiagStatus } from "@/lib/arena/diagnostic";
import type { Genome } from "@/lib/arena/genome";
import type { LiveAgent, Position, Snapshot, SnapshotWindow, TickContext } from "@/lib/arena/types";

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = new Date("2026-05-25T22:00:00Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** Build a LiveAgent with the given genome. All numeric DB fields are fixed. */
function makeAgent(genome: Genome, overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    id: 1, name: "diag-test", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "test",
    cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: 1000, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 0, wins_count: 0,
    alive: 1, is_elite: 0, retire_reason: null, retired_at: null,
    created_at: "", updated_at: "",
    genome,
    positions: [],
    ...overrides,
  };
}

function mkPosition(market_id = "m1", price = 0.5): Position {
  return {
    venue: "sim-poly", market_id, side: "BUY", size_usd: 10,
    entry_price: price, opened_at: iso(T0),
  };
}

/** Build a single-market poly SnapshotWindow. `prices` are oldest→newest; the
 *  last entry is also `latest`. Snapshots are spaced `stepMin` minutes apart,
 *  ending exactly at `endMs`. */
function polyWindow(
  market_id: string,
  prices: number[],
  endMs: number,
  stepMin = 5,
  category = "crypto",
): SnapshotWindow {
  const n = prices.length;
  const history: Snapshot[] = prices.map((price, i) => ({
    venue: "sim-poly" as const,
    market_id,
    price,
    category,
    captured_at: iso(endMs - (n - 1 - i) * stepMin * 60_000),
  }));
  return { history, latest: history[history.length - 1] };
}

/** Build a single-market coinbase SnapshotWindow (no category). */
function cbWindow(
  market_id: string,
  prices: number[],
  endMs: number,
  stepMin = 1,
): SnapshotWindow {
  const n = prices.length;
  const history: Snapshot[] = prices.map((price, i) => ({
    venue: "sim-coinbase" as const,
    market_id,
    price,
    captured_at: iso(endMs - (n - 1 - i) * stepMin * 60_000),
  }));
  return { history, latest: history[history.length - 1] };
}

function ctxFrom(windows: Record<string, SnapshotWindow>, nowMs = T0 + 60 * 60_000): TickContext {
  return { now: iso(nowMs), snapshots: new Map(Object.entries(windows)) };
}

/** Seeded LCG → [0,1). Deterministic for a fixed seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALL_STATUSES: DiagStatus[] = ["in-position", "would-enter", "watching", "no-data"];
function isValidDiag(d: AgentDiagnostic): boolean {
  return (
    ALL_STATUSES.includes(d.status) &&
    typeof d.label === "string" &&
    d.label.length > 0 &&
    (d.detail === undefined || typeof d.detail === "string")
  );
}

// ── in-position short-circuit ───────────────────────────────────────────────

describe("diagnoseAgent — in-position short-circuit", () => {
  it("returns in-position with an N-open label regardless of genome/ctx", () => {
    const agent = makeAgent(
      { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
      { positions: [mkPosition("m1"), mkPosition("m2")] },
    );
    const d = diagnoseAgent(agent, ctxFrom({}));
    expect(d.status).toBe("in-position");
    expect(d.label).toBe("2 open");
  });

  it("open-position count in the label matches positions.length for 1..5", () => {
    for (let n = 1; n <= 5; n++) {
      const positions = Array.from({ length: n }, (_, i) => mkPosition(`m${i}`));
      const agent = makeAgent(
        { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
        { positions },
      );
      const d = diagnoseAgent(agent, ctxFrom({}));
      expect(d.status).toBe("in-position");
      expect(d.label).toBe(`${n} open`);
    }
  });
});

// ── random_walk_baseline ────────────────────────────────────────────────────

describe("diagnoseAgent — random_walk_baseline", () => {
  it("is always 'watching' and reports trade_prob as a per-tick percentage", () => {
    const agent = makeAgent({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } });
    const d = diagnoseAgent(agent, ctxFrom({}));
    expect(d.status).toBe("watching");
    expect(d.label).toBe("trade_prob=5.0% per tick");
  });

  it("never depends on ctx — empty ctx and rich ctx give the same reading", () => {
    const agent = makeAgent({ kind: "random_walk_baseline", params: { trade_prob: 0.012, buy_bias_pct: 0.5, entry_size_usd: 10 } });
    const a = diagnoseAgent(agent, ctxFrom({}));
    const b = diagnoseAgent(agent, ctxFrom({ x: polyWindow("x", [0.4, 0.5, 0.6, 0.7], T0 + 60 * 60_000) }));
    expect(a).toEqual(b);
    expect(a.label).toBe("trade_prob=1.2% per tick");
  });
});

// ── cb_mean_reversion ───────────────────────────────────────────────────────

function mrGenome(z_entry = 1.5, lookback_min = 60): Genome {
  return {
    kind: "cb_mean_reversion",
    params: { product_id: "BTC-USD", lookback_min, z_entry, z_exit: 0, entry_size_usd: 10, stop_pct: 0.01, time_stop_min: 60 },
  };
}

describe("diagnoseAgent — cb_mean_reversion", () => {
  it("no-data when the product has no snapshot window at all", () => {
    const agent = makeAgent(mrGenome());
    const d = diagnoseAgent(agent, ctxFrom({ "ETH-USD": cbWindow("ETH-USD", [1, 2, 3], T0 + 60 * 60_000) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no BTC-USD snaps");
  });

  it("no-data when fewer than 12 snaps fall inside the lookback window", () => {
    const now = T0 + 60 * 60_000;
    const prices = Array.from({ length: 8 }, (_, i) => 100 + i);
    const agent = makeAgent(mrGenome(1.5, 60));
    const d = diagnoseAgent(agent, ctxFrom({ "BTC-USD": cbWindow("BTC-USD", prices, now, 1) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("8/12 snaps");
  });

  it("no-data with σ=0 label when all in-window prices are identical", () => {
    const now = T0 + 60 * 60_000;
    const prices = Array.from({ length: 15 }, () => 100);
    const agent = makeAgent(mrGenome(1.5, 60));
    const d = diagnoseAgent(agent, ctxFrom({ "BTC-USD": cbWindow("BTC-USD", prices, now, 1) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("σ=0");
  });

  it("watching when z is above the entry gate (price near the mean)", () => {
    const now = T0 + 60 * 60_000;
    // 14 alternating ±1 around 100, last price = 100 → z ≈ 0, never <= -z_entry.
    const prices = Array.from({ length: 15 }, (_, i) => (i === 14 ? 100 : 100 + (i % 2 === 0 ? 1 : -1)));
    const agent = makeAgent(mrGenome(1.5, 60));
    const d = diagnoseAgent(agent, ctxFrom({ "BTC-USD": cbWindow("BTC-USD", prices, now, 1) }));
    expect(d.status).toBe("watching");
    // threshold label is the negated z_entry to 2dp
    expect(d.label).toMatch(/^z=-?\d+\.\d{2} \/ ≤-1\.50$/);
  });

  it("would-enter when the latest price is far below the mean (deep negative z)", () => {
    const now = T0 + 60 * 60_000;
    // 14 bars at 100 then a crash to 90 → mean pulled down only slightly, z strongly negative.
    const prices = [...Array.from({ length: 14 }, () => 100), 90];
    const agent = makeAgent(mrGenome(1.0, 60));
    const d = diagnoseAgent(agent, ctxFrom({ "BTC-USD": cbWindow("BTC-USD", prices, now, 1) }));
    expect(d.status).toBe("would-enter");
    expect(d.detail).toMatch(/^μ=\d+\.\d{2} σ=\d+\.\d{2} window=60min$/);
  });

  it("lowering z_entry can only make would-enter more (not less) likely for a fixed crash", () => {
    const now = T0 + 60 * 60_000;
    const prices = [...Array.from({ length: 14 }, () => 100), 97]; // mild dip
    const ctx = ctxFrom({ "BTC-USD": cbWindow("BTC-USD", prices, now, 1) });
    const strict = diagnoseAgent(makeAgent(mrGenome(2.5, 60)), ctx);
    const loose = diagnoseAgent(makeAgent(mrGenome(1.0, 60)), ctx);
    const fired = (d: AgentDiagnostic) => d.status === "would-enter";
    // Monotone: if the strict gate fires, the looser one must also fire.
    expect(!fired(strict) || fired(loose)).toBe(true);
  });
});

// ── poly_breakout ───────────────────────────────────────────────────────────

function polyBreakoutGenome(breakout_mult = 1.2, lookback_h = 24): Genome {
  return {
    kind: "poly_breakout",
    params: { lookback_h, breakout_mult, entry_size_usd: 10, target_pts: 5, stop_pts: 5, time_stop_h: 24 },
  };
}

describe("diagnoseAgent — poly_breakout", () => {
  it("no-data when there are no sim-poly markets in ctx", () => {
    const agent = makeAgent(polyBreakoutGenome());
    const d = diagnoseAgent(agent, ctxFrom({ "BTC-USD": cbWindow("BTC-USD", [1, 2, 3, 4, 5], T0 + 60 * 60_000) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("thin poly history");
  });

  it("no-data when fewer than 4 in-window snaps exist", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.3, 0.4, 0.5], now, 5); // only 3 snaps
    const d = diagnoseAgent(makeAgent(polyBreakoutGenome(1.2, 24)), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("thin poly history");
  });

  it("ratio is bounded by 1.0 because the latest snap is itself in-window (max ≥ latest)", () => {
    const now = T0 + 60 * 60_000;
    // latest 0.70 is the highest, but it's part of inWindow so max == 0.70 → ratio 1.000.
    const w = polyWindow("p1", [0.40, 0.45, 0.50, 0.70], now, 5);
    const d = diagnoseAgent(makeAgent(polyBreakoutGenome(1.2, 24)), ctxFrom({ p1: w }, now));
    expect(d.label).toMatch(/^top=\d+\.\d{3}× \/ >1\.20×$/);
    const ratio = parseFloat(d.label.match(/top=([\d.]+)×/)![1]);
    expect(ratio).toBeLessThanOrEqual(1.0);
    expect(ratio).toBeCloseTo(1.0, 3); // latest is the running high → ratio == 1
  });

  it("watching when latest is below the recent high (ratio < 1)", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.40, 0.45, 0.70, 0.52], now, 5); // high=0.70, latest 0.52 → 0.743
    const d = diagnoseAgent(makeAgent(polyBreakoutGenome(1.2, 24)), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("watching");
    const ratio = parseFloat(d.label.match(/top=([\d.]+)×/)![1]);
    expect(ratio).toBeLessThan(1.0);
  });

  it("picks the market with the highest latest/max ratio across multiple poly markets", () => {
    const now = T0 + 60 * 60_000;
    const lo = polyWindow("lo", [0.50, 0.50, 0.50, 0.30], now, 5); // ratio 0.30/0.50 = 0.6
    const hi = polyWindow("hi", [0.40, 0.40, 0.40, 0.40], now, 5); // ratio 0.40/0.40 = 1.0 (latest is the high)
    const d = diagnoseAgent(makeAgent(polyBreakoutGenome(1.5, 24)), ctxFrom({ lo, hi }, now));
    // best ratio across markets is hi's 1.000; never exceeds the multiplier.
    expect(d.status).toBe("watching");
    expect(d.label).toContain("top=1.000×");
  });
});

// ── cb_breakout ─────────────────────────────────────────────────────────────

function cbBreakoutGenome(breakout_mult = 1.05, lookback_min = 60): Genome {
  return {
    kind: "cb_breakout",
    params: { product_id: "BTC-USD", lookback_min, breakout_mult, entry_size_usd: 10, target_pct: 0.01, stop_pct: 0.01, time_stop_min: 60 },
  };
}

describe("diagnoseAgent — cb_breakout", () => {
  it("no-data when the product window is missing", () => {
    const d = diagnoseAgent(makeAgent(cbBreakoutGenome()), ctxFrom({ "ETH-USD": cbWindow("ETH-USD", [1, 2, 3, 4], T0 + 60 * 60_000) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no BTC-USD snaps");
  });

  it("no-data with an N/4 label when fewer than 4 in-window snaps exist", () => {
    const now = T0 + 60 * 60_000;
    const w = cbWindow("BTC-USD", [100, 101, 102], now, 1); // 3 snaps within 60min
    const d = diagnoseAgent(makeAgent(cbBreakoutGenome(1.05, 60)), ctxFrom({ "BTC-USD": w }, now));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("3/4 snaps");
  });

  it("ratio is capped at 1.0 — latest snap is in-window so max ≥ latest, never fires", () => {
    const now = T0 + 60 * 60_000;
    const w = cbWindow("BTC-USD", [100, 101, 100, 110], now, 1); // latest 110 is the running high → ratio 1.0
    const d = diagnoseAgent(makeAgent(cbBreakoutGenome(1.05, 60)), ctxFrom({ "BTC-USD": w }, now));
    expect(d.status).toBe("watching");
    expect(d.label).toMatch(/^ratio=\d+\.\d{4} \/ >1\.050$/);
    const ratio = parseFloat(d.label.match(/ratio=([\d.]+)/)![1]);
    expect(ratio).toBeLessThanOrEqual(1.0);
    expect(ratio).toBeCloseTo(1.0, 4);
  });

  it("watching when the latest is at the recent max (ratio == 1, not strictly >)", () => {
    const now = T0 + 60 * 60_000;
    const w = cbWindow("BTC-USD", [100, 110, 105, 110], now, 1); // max=110, latest=110 → ratio 1.0
    const d = diagnoseAgent(makeAgent(cbBreakoutGenome(1.05, 60)), ctxFrom({ "BTC-USD": w }, now));
    expect(d.status).toBe("watching");
    expect(d.label).toContain("ratio=1.0000");
  });

  it("ratio < 1 when latest dips below the recent high", () => {
    const now = T0 + 60 * 60_000;
    const w = cbWindow("BTC-USD", [100, 120, 110, 90], now, 1); // high 120, latest 90 → 0.75
    const d = diagnoseAgent(makeAgent(cbBreakoutGenome(1.05, 60)), ctxFrom({ "BTC-USD": w }, now));
    expect(d.status).toBe("watching");
    const ratio = parseFloat(d.label.match(/ratio=([\d.]+)/)![1]);
    expect(ratio).toBeCloseTo(0.75, 4);
  });
});

// ── cross_venue_arb ─────────────────────────────────────────────────────────

function arbGenome(edge_pts = 5): Genome {
  return {
    kind: "cross_venue_arb",
    params: { cb_product_id: "BTC-USD", poly_condition_id: "cond-1", edge_pts, bs_vol_window_days: 14, entry_size_usd: 10, time_stop_h: 24 },
  };
}

describe("diagnoseAgent — cross_venue_arb", () => {
  it("no-data when either implied-prob map is missing the condition", () => {
    const agent = makeAgent(arbGenome());
    const d = diagnoseAgent(agent, { now: iso(T0), snapshots: new Map(), polyImpliedProb: new Map([["cond-1", 0.6]]) });
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("bs/poly prob missing");
  });

  it("would-enter when |spread| meets the edge gate; spread is (poly−bs)×100 points", () => {
    const agent = makeAgent(arbGenome(5));
    const ctx: TickContext = {
      now: iso(T0), snapshots: new Map(),
      polyImpliedProb: new Map([["cond-1", 0.70]]),
      bsImpliedProb: new Map([["cond-1", 0.60]]),
    };
    const d = diagnoseAgent(agent, ctx);
    expect(d.status).toBe("would-enter"); // spread = 10pt >= 5pt
    expect(d.label).toBe("spread=10.0pt / ≥5pt");
    expect(d.detail).toBe("poly=70.0% bs=60.0%");
  });

  it("spread sign flips with prob order but |spread| (and firing) is symmetric", () => {
    const ctx = (poly: number, bs: number): TickContext => ({
      now: iso(T0), snapshots: new Map(),
      polyImpliedProb: new Map([["cond-1", poly]]),
      bsImpliedProb: new Map([["cond-1", bs]]),
    });
    const agent = makeAgent(arbGenome(5));
    const up = diagnoseAgent(agent, ctx(0.70, 0.60));
    const down = diagnoseAgent(agent, ctx(0.60, 0.70));
    expect(up.status).toBe(down.status); // both fire on |10pt| >= 5pt
    expect(up.label).toContain("spread=10.0pt");
    expect(down.label).toContain("spread=-10.0pt");
  });

  it("watching when |spread| is below the edge gate", () => {
    const agent = makeAgent(arbGenome(20));
    const ctx: TickContext = {
      now: iso(T0), snapshots: new Map(),
      polyImpliedProb: new Map([["cond-1", 0.52]]),
      bsImpliedProb: new Map([["cond-1", 0.50]]),
    };
    const d = diagnoseAgent(agent, ctx); // spread 2pt < 20pt
    expect(d.status).toBe("watching");
  });
});

// ── poly_fade_spike ─────────────────────────────────────────────────────────

function fadeGenome(threshold_pts = 5, lookback_h = 24, confirm_quiet_h = 6): Genome {
  return {
    kind: "poly_fade_spike",
    params: { threshold_pts, lookback_h, confirm_quiet_h, entry_size_usd: 10, exit_target_pts: 5, stop_pts: 5, time_stop_h: 24 },
  };
}

describe("diagnoseAgent — poly_fade_spike", () => {
  it("no-data when there are no poly markets", () => {
    const d = diagnoseAgent(makeAgent(fadeGenome()), ctxFrom({}));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no poly markets");
  });

  it("watching when the move is below threshold", () => {
    const now = T0 + 48 * 60 * 60_000;
    // gentle drift: spread between lookback and latest is tiny in points.
    const prices = Array.from({ length: 30 }, (_, i) => 0.50 + i * 0.0005);
    const w = polyWindow("p1", prices, now, 60); // hourly spacing
    const d = diagnoseAgent(makeAgent(fadeGenome(10, 24, 6)), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("watching");
    expect(d.label).toMatch(/^move=-?\d+\.\dpt \/ ≥10\.0pt$/);
  });

  it("best market is the one with the largest |move| across markets", () => {
    const now = T0 + 48 * 60 * 60_000;
    const flat = polyWindow("flat", Array.from({ length: 30 }, () => 0.50), now, 60);
    // big mover: rises from 0.40 to 0.80 → 40pt move over the series.
    const big = polyWindow("big", Array.from({ length: 30 }, (_, i) => 0.40 + i * (0.40 / 29)), now, 60);
    const d = diagnoseAgent(makeAgent(fadeGenome(5, 24, 6)), ctxFrom({ flat, big }, now));
    // label reports the best (big) market's move; magnitude should be large.
    const m = d.label.match(/^move=(-?\d+\.\d)pt/);
    expect(m).not.toBeNull();
    expect(Math.abs(parseFloat(m![1]))).toBeGreaterThan(10);
  });
});

// ── polymarket_market_maker ─────────────────────────────────────────────────

function mmGenome(token_id = "any", spread_pts = 2): Genome {
  return {
    kind: "polymarket_market_maker",
    params: { token_id, spread_pts, stop_pts: 4, time_stop_h: 6, entry_size_usd: 5 },
  };
}

describe("diagnoseAgent — polymarket_market_maker", () => {
  it("no-data when no liquid poly market exists (all prices at the rails)", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.98, 0.99, 0.97, 0.99], now, 5); // >= 0.95 → illiquid
    const d = diagnoseAgent(makeAgent(mmGenome("any")), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no liquid poly mkts");
  });

  it("would-enter on a liquid poly market; side alternates by entries_count parity", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.45, 0.50, 0.55, 0.50], now, 5);
    const even = diagnoseAgent(makeAgent(mmGenome("any"), { entries_count: 0 }), ctxFrom({ p1: w }, now));
    const odd = diagnoseAgent(makeAgent(mmGenome("any"), { entries_count: 1 }), ctxFrom({ p1: w }, now));
    expect(even.status).toBe("would-enter");
    expect(odd.status).toBe("would-enter");
    expect(even.label).toContain("MM BUY@0.500");
    expect(odd.label).toContain("MM SELL@0.500");
  });

  it("honours an explicit token_id present in ctx (even at the rails)", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("tok-x", [0.99, 0.99, 0.99, 0.99], now, 5);
    const d = diagnoseAgent(makeAgent(mmGenome("tok-x")), ctxFrom({ "tok-x": w }, now));
    // explicit token short-circuits the liquidity scan → still would-enter
    expect(d.status).toBe("would-enter");
    expect(d.label).toContain("MM BUY@0.990");
  });
});

// ── category_specialist ─────────────────────────────────────────────────────

function catGenome(category = "crypto", inner_strategy: "fade_spike" | "breakout" = "fade_spike", threshold_pts = 5): Genome {
  return {
    kind: "category_specialist",
    params: {
      category: category as never, inner_strategy, threshold_pts, lookback_h: 24, confirm_quiet_h: 6,
      entry_size_usd: 10, exit_target_pts: 5, stop_pts: 5, time_stop_h: 24, breakout_mult: 1.2,
    },
  };
}

describe("diagnoseAgent — category_specialist", () => {
  it("no-data when no market matches the chosen category", () => {
    const now = T0 + 48 * 60 * 60_000;
    const w = polyWindow("p1", [0.5, 0.5, 0.5, 0.5], now, 60, "elections");
    const d = diagnoseAgent(makeAgent(catGenome("crypto", "fade_spike")), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no crypto markets in ctx");
  });

  it("counts only same-category poly markets and reports the count", () => {
    const now = T0 + 48 * 60 * 60_000;
    const a = polyWindow("a", Array.from({ length: 6 }, () => 0.5), now, 60, "crypto");
    const b = polyWindow("b", Array.from({ length: 6 }, () => 0.5), now, 60, "crypto");
    const other = polyWindow("c", Array.from({ length: 6 }, () => 0.5), now, 60, "sports");
    const d = diagnoseAgent(makeAgent(catGenome("crypto", "fade_spike", 5)), ctxFrom({ a, b, c: other }, now));
    expect(d.status).toBe("watching");
    expect(d.label).toContain("· 2 mkts ·"); // only the two crypto markets counted
    expect(d.label).toMatch(/^crypto\/fs/);
  });

  it("breakout inner strategy never fires here (best move stays 0) → watching", () => {
    const now = T0 + 48 * 60 * 60_000;
    const w = polyWindow("a", Array.from({ length: 6 }, (_, i) => 0.40 + i * 0.10), now, 60, "crypto");
    const d = diagnoseAgent(makeAgent(catGenome("crypto", "breakout", 1)), ctxFrom({ a: w }, now));
    expect(d.status).toBe("watching"); // fires requires inner_strategy === "fade_spike"
    expect(d.label).toContain("crypto/bo");
    expect(d.label).toContain("best=0.0pt");
  });

  it("fade_spike fires when the best in-category move meets the threshold", () => {
    const now = T0 + 48 * 60 * 60_000;
    // 0.20 → 0.80 over the series = 60pt move; lookback_h=24 → lookback bar is older.
    const w = polyWindow("a", Array.from({ length: 30 }, (_, i) => 0.20 + i * (0.60 / 29)), now, 60, "crypto");
    const d = diagnoseAgent(makeAgent(catGenome("crypto", "fade_spike", 5)), ctxFrom({ a: w }, now));
    expect(d.status).toBe("would-enter");
  });
});

// ── poly_short_binary_directional ───────────────────────────────────────────

function binGenome(): Genome {
  return {
    kind: "poly_short_binary_directional",
    params: {
      assets: "BTC,ETH", vel_window_min: 2, vel_entry_pct: 0.001, pre_cutoff_min: 2,
      max_window_min: 8, max_yes_price_for_buy: 0.6, min_yes_price_for_sell: 0.4,
      entry_size_usd: 5, max_positions_per_asset: 1,
    },
  };
}

describe("diagnoseAgent — poly_short_binary_directional", () => {
  it("no-data when ctx holds no '-binary' category markets", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.5, 0.5, 0.5], now, 5, "crypto"); // not a binary category
    const d = diagnoseAgent(makeAgent(binGenome()), ctxFrom({ p1: w }, now));
    expect(d.status).toBe("no-data");
    expect(d.label).toContain("0 binaries in ctx");
  });

  it("watching when at least one '-binary' market is present, and counts them", () => {
    const now = T0 + 60 * 60_000;
    const b1 = polyWindow("b1", [0.5, 0.5, 0.5], now, 5, "btc-up-down-binary");
    const b2 = polyWindow("b2", [0.5, 0.5, 0.5], now, 5, "eth-up-down-binary");
    const skip = polyWindow("s", [0.5, 0.5, 0.5], now, 5, "crypto");
    const d = diagnoseAgent(makeAgent(binGenome()), ctxFrom({ b1, b2, s: skip }, now));
    expect(d.status).toBe("watching");
    expect(d.label).toContain("2 binaries in ctx");
    expect(d.label).toContain("assets=BTC/ETH");
  });
});

// ── cb_momentum_burst (pure early-return only) ──────────────────────────────

describe("diagnoseAgent — cb_momentum_burst (no-data early return, no DB)", () => {
  it("returns no-data before any candle load when the product window is absent", () => {
    const g: Genome = {
      kind: "cb_momentum_burst",
      params: {
        product_id: "BTC-USD", vel_window_min: 5, vel_entry_pct: 0.002, accel_min: 0.0001,
        entry_size_usd: 10, target_pct: 0.01, stop_pct: 0.01, time_stop_min: 30, direction_bias: "long_only",
      },
    };
    // ctx has NO BTC-USD window → the `if (!win)` guard fires before loadRecentCandles().
    const d = diagnoseAgent(makeAgent(g), ctxFrom({ "ETH-USD": cbWindow("ETH-USD", [1, 2, 3], T0 + 60 * 60_000) }));
    expect(d.status).toBe("no-data");
    expect(d.label).toBe("no BTC-USD snaps");
  });
});

// ── multi_strategy aggregation ──────────────────────────────────────────────

describe("diagnoseAgent — multi_strategy aggregation", () => {
  it("surfaces would-enter over watching over no-data, and labels it multi[...]", () => {
    const now = T0 + 60 * 60_000;
    // sub A (random_walk) is watching; sub B (cb_mean_reversion) fires on a crash.
    const prices = [...Array.from({ length: 14 }, () => 100), 90]; // deep negative z
    const w = cbWindow("BTC-USD", prices, now, 1);
    const g: Genome = {
      kind: "multi_strategy",
      params: {
        selection: "priority",
        entry_size_usd: 10,
        subs: [
          { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
          { kind: "cb_mean_reversion", params: { product_id: "BTC-USD", lookback_min: 60, z_entry: 1.0, z_exit: 0, entry_size_usd: 10, stop_pct: 0.01, time_stop_min: 60 } },
        ],
      },
    };
    const d = diagnoseAgent(makeAgent(g), ctxFrom({ "BTC-USD": w }, now));
    expect(d.status).toBe("would-enter"); // best sub (mean reversion) wins over watching
    expect(d.label).toMatch(/^multi\[/);
    // best=<kind with first underscore→space, sliced to 14 chars>
    expect(d.label).toContain("best=cb mean_rev");
  });

  it("is no-data only when every sub is no-data", () => {
    const g: Genome = {
      kind: "multi_strategy",
      params: {
        selection: "priority",
        entry_size_usd: 10,
        subs: [
          { kind: "cb_breakout", params: { product_id: "BTC-USD", lookback_min: 60, breakout_mult: 1.05, entry_size_usd: 10, target_pct: 0.01, stop_pct: 0.01, time_stop_min: 60 } },
          { kind: "poly_breakout", params: { lookback_h: 24, breakout_mult: 1.2, entry_size_usd: 10, target_pts: 5, stop_pts: 5, time_stop_h: 24 } },
        ],
      },
    };
    // empty ctx → cb_breakout no-data (no BTC window), poly_breakout no-data (no poly mkts).
    const d = diagnoseAgent(makeAgent(g), ctxFrom({}));
    expect(d.status).toBe("no-data");
    expect(d.label).toMatch(/^multi\[/);
  });

  it("in-position short-circuits before any sub aggregation", () => {
    const g: Genome = {
      kind: "multi_strategy",
      params: {
        selection: "priority",
        entry_size_usd: 10,
        subs: [
          { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
          { kind: "poly_breakout", params: { lookback_h: 24, breakout_mult: 1.2, entry_size_usd: 10, target_pts: 5, stop_pts: 5, time_stop_h: 24 } },
        ],
      },
    };
    const d = diagnoseAgent(makeAgent(g, { positions: [mkPosition("m1")] }), ctxFrom({}));
    expect(d.status).toBe("in-position");
    expect(d.label).toBe("1 open");
  });
});

// ── determinism + batch + always-valid invariant ────────────────────────────

describe("diagnoseAgent — determinism and structural invariants", () => {
  it("is a pure function: identical inputs yield deeply-equal outputs", () => {
    const now = T0 + 60 * 60_000;
    const w = cbWindow("BTC-USD", [100, 101, 99, 110], now, 1);
    const agent = makeAgent(cbBreakoutGenome(1.05, 60));
    const ctx = ctxFrom({ "BTC-USD": w }, now);
    const a = diagnoseAgent(agent, ctx);
    const b = diagnoseAgent(agent, ctx);
    expect(a).toEqual(b);
  });

  it("returns a structurally-valid diagnostic across a seeded sweep of inputs", () => {
    const rng = lcg(0xC0FFEE);
    for (let i = 0; i < 40; i++) {
      const now = T0 + 60 * 60_000;
      const n = 4 + Math.floor(rng() * 20);
      const prices = Array.from({ length: n }, () => 0.10 + rng() * 0.80);
      const w = polyWindow("p1", prices, now, 5, "crypto");
      const d = diagnoseAgent(makeAgent(polyBreakoutGenome(1.1 + rng() * 0.5, 24)), ctxFrom({ p1: w }, now));
      expect(isValidDiag(d)).toBe(true);
    }
  });

  it("diagnoseAgents keys the map by agent.id and matches per-agent diagnoseAgent", () => {
    const now = T0 + 60 * 60_000;
    const w = polyWindow("p1", [0.40, 0.45, 0.50, 0.80], now, 5);
    const ctx = ctxFrom({ p1: w }, now);
    const a1 = makeAgent(polyBreakoutGenome(1.2, 24), { id: 11 });
    const a2 = makeAgent({ kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } }, { id: 22 });
    const map = diagnoseAgents([a1, a2], ctx);
    expect(map.size).toBe(2);
    expect(map.get(11)).toEqual(diagnoseAgent(a1, ctx));
    expect(map.get(22)).toEqual(diagnoseAgent(a2, ctx));
  });

  it("diagnoseAgents on an empty list returns an empty map", () => {
    const map = diagnoseAgents([], ctxFrom({}));
    expect(map.size).toBe(0);
  });

  it("a later agent.id collision overwrites the earlier entry (Map semantics)", () => {
    const now = T0 + 60 * 60_000;
    const ctx = ctxFrom({}, now);
    const inPos = makeAgent(
      { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
      { id: 7, positions: [mkPosition("m1")] },
    );
    const watching = makeAgent(
      { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
      { id: 7 },
    );
    const map = diagnoseAgents([inPos, watching], ctx);
    expect(map.size).toBe(1);
    expect(map.get(7)!.status).toBe("watching"); // second wins
  });
});
