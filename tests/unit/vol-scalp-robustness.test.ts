/**
 * Robustness / invariant / edge-case tests for the vol-scalp detector.
 *
 * Complementary to `slippage-and-vol-scalp.test.ts` — those cover the basic
 * happy-path + gate filters. This file targets *invariants* of the pure
 * decision math: determinism, monotonicity in vol / time / sensitivity,
 * sign of the premium, fee handling, threshold boundaries, degenerate ticks,
 * and the internal algebraic relationships of the returned opportunity.
 *
 * Everything is constructed from synthetic, fixed inputs. Any pseudo-random
 * noise comes from a small seeded LCG so the whole file is deterministic — no
 * wall-clock, no Math.random.
 */
import { describe, expect, it } from "vitest";
import {
  detectVolScalp,
  type ScalpTick,
  type VolScalpSnapshot,
  type VolScalpOptions,
} from "@/lib/strategies/vol-scalp";

// Fixed reference instant — never read from the system clock.
const NOW = Date.parse("2026-05-28T12:00:00Z");

/**
 * Seeded LCG noise generator. Pure, deterministic, repeatable from the seed.
 * Returns values in [-1, 1).
 */
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

/**
 * Build evenly-spaced ticks (1s apart) around `open` with optional drift and
 * seeded multiplicative noise. `noise` is a fraction of `open` per tick.
 */
function genTicks(
  open: number,
  slope: number,
  n: number,
  noise = 0.01,
  seed = 0x12345,
): ScalpTick[] {
  const rand = makeRand(seed);
  const out: ScalpTick[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ ts: NOW + i * 1000, price: open + slope * i + rand() * noise * open });
  }
  return out;
}

function snap(over: Partial<VolScalpSnapshot> = {}): VolScalpSnapshot {
  return {
    conditionId: "0xCOND",
    asset: "BTC",
    windowCloseMs: NOW + 5 * 60_000,
    nowMs: NOW,
    upBestAsk: 0.51,
    downBestAsk: 0.51,
    recentTicks: genTicks(100, 0, 30, 0.05),
    feeBps: 20,
    ...over,
  };
}

// A high-vol tick series that reliably clears the fire threshold with the
// default snapshot (premium 0.02). 5% per-tick noise on a $100 base.
const HIGH_VOL = () => genTicks(100, 0, 30, 0.05);

// ─── determinism ─────────────────────────────────────────────────────────────

describe("detectVolScalp — determinism", () => {
  it("identical inputs produce a deeply-equal result (no hidden state / clock)", () => {
    const s = snap({ recentTicks: HIGH_VOL() });
    const a = detectVolScalp(s);
    const b = detectVolScalp(s);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("does not mutate the input snapshot or its tick array", () => {
    const ticks = HIGH_VOL();
    const frozenTicks = Object.freeze(ticks.map((t) => Object.freeze({ ...t })));
    const s = snap({ recentTicks: frozenTicks });
    const len = frozenTicks.length;
    const firstPrice = frozenTicks[0]!.price;
    expect(() => detectVolScalp(s)).not.toThrow();
    expect(frozenTicks.length).toBe(len);
    expect(frozenTicks[0]!.price).toBe(firstPrice);
  });
});

// ─── premium sign / algebra ──────────────────────────────────────────────────

describe("detectVolScalp — premium & cost algebra", () => {
  it("entry_premium = combined_cost − 1 exactly", () => {
    const r = detectVolScalp(snap({ upBestAsk: 0.52, downBestAsk: 0.51, recentTicks: HIGH_VOL() }));
    expect(r).not.toBeNull();
    expect(r!.combined_cost).toBeCloseTo(1.03, 10);
    expect(r!.entry_premium).toBeCloseTo(r!.combined_cost - 1, 12);
    expect(r!.entry_premium).toBeCloseTo(0.03, 10);
  });

  it("symmetry: swapping up/down asks leaves combined_cost & premium unchanged", () => {
    const a = detectVolScalp(snap({ upBestAsk: 0.53, downBestAsk: 0.50, recentTicks: HIGH_VOL() }));
    const b = detectVolScalp(snap({ upBestAsk: 0.50, downBestAsk: 0.53, recentTicks: HIGH_VOL() }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.combined_cost).toBeCloseTo(b!.combined_cost, 12);
    expect(a!.entry_premium).toBeCloseTo(b!.entry_premium, 12);
    expect(a!.estimated_payoff_usd).toBeCloseTo(b!.estimated_payoff_usd, 12);
  });
});

// ─── premium gate boundaries ─────────────────────────────────────────────────

describe("detectVolScalp — premium gate boundaries", () => {
  it("fires exactly at the minPremium boundary (inclusive)", () => {
    // premium == minPremium (0.01) should pass the lower gate.
    const r = detectVolScalp(snap({ upBestAsk: 0.505, downBestAsk: 0.505, recentTicks: HIGH_VOL() }));
    expect(r).not.toBeNull();
    expect(r!.entry_premium).toBeCloseTo(0.01, 10);
  });

  it("rejects just below minPremium", () => {
    // premium ≈ 0.005 < 0.01
    const r = detectVolScalp(snap({ upBestAsk: 0.5025, downBestAsk: 0.5025, recentTicks: HIGH_VOL() }));
    expect(r).toBeNull();
  });

  it("rejects just above maxPremium even with huge vol", () => {
    // premium 0.12 > 0.10 default — gate is independent of vol.
    const r = detectVolScalp(snap({ upBestAsk: 0.56, downBestAsk: 0.56, recentTicks: genTicks(100, 0, 30, 0.2) }));
    expect(r).toBeNull();
  });

  it("a custom maxPremium can admit a higher-premium snapshot", () => {
    const s = snap({ upBestAsk: 0.56, downBestAsk: 0.56, recentTicks: genTicks(100, 0, 30, 0.2) });
    const tighter = detectVolScalp(s); // default max 0.10 → null
    const looser = detectVolScalp(s, { maxPremium: 0.2 });
    expect(tighter).toBeNull();
    expect(looser).not.toBeNull();
    expect(looser!.entry_premium).toBeCloseTo(0.12, 10);
  });
});

// ─── time gate boundaries & monotonicity ─────────────────────────────────────

describe("detectVolScalp — time gates & remaining_min", () => {
  it("remaining_min reflects (windowClose − now)/60000 exactly", () => {
    const r = detectVolScalp(snap({ windowCloseMs: NOW + 7 * 60_000, recentTicks: HIGH_VOL() }));
    expect(r).not.toBeNull();
    expect(r!.remaining_min).toBeCloseTo(7, 10);
  });

  it("rejects below minRemainingMin boundary", () => {
    // 1.9 min remaining < 2.0 default min.
    const r = detectVolScalp(snap({ windowCloseMs: NOW + 1.9 * 60_000, recentTicks: HIGH_VOL() }));
    expect(r).toBeNull();
  });

  it("rejects above maxRemainingMin boundary", () => {
    // 31 min remaining > 30 default max.
    const r = detectVolScalp(snap({ windowCloseMs: NOW + 31 * 60_000, recentTicks: HIGH_VOL() }));
    expect(r).toBeNull();
  });

  it("expected move grows with remaining time (longer window ⇒ larger sqrt(t) move)", () => {
    const short = detectVolScalp(snap({ windowCloseMs: NOW + 4 * 60_000, recentTicks: HIGH_VOL() }));
    const long = detectVolScalp(snap({ windowCloseMs: NOW + 16 * 60_000, recentTicks: HIGH_VOL() }));
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(long!.expected_underlying_move_pct).toBeGreaterThan(short!.expected_underlying_move_pct);
    // sqrt scaling: 16min vs 4min ⇒ exactly 2× the expected move (same sigma/min).
    expect(long!.expected_underlying_move_pct / short!.expected_underlying_move_pct).toBeCloseTo(2, 6);
  });
});

// ─── vol monotonicity & no-signal cases ──────────────────────────────────────

describe("detectVolScalp — vol monotonicity", () => {
  it("higher tick noise ⇒ larger expected move (more realized vol)", () => {
    const lo = detectVolScalp(snap({ recentTicks: genTicks(100, 0, 30, 0.04) }));
    const hi = detectVolScalp(snap({ recentTicks: genTicks(100, 0, 30, 0.12) }));
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(hi!.expected_underlying_move_pct).toBeGreaterThan(lo!.expected_underlying_move_pct);
  });

  it("flat ticks (zero realized vol) never fire — payoff cannot beat premium", () => {
    const flat: ScalpTick[] = Array.from({ length: 30 }, (_, i) => ({ ts: NOW + i * 1000, price: 100 }));
    const r = detectVolScalp(snap({ recentTicks: flat }));
    expect(r).toBeNull();
  });

  it("near-zero vol fails the fire condition (payoff < premium × sensitivity)", () => {
    const r = detectVolScalp(snap({ recentTicks: genTicks(100, 0, 30, 0.0005) }));
    expect(r).toBeNull();
  });

});

// ─── sensitivity monotonicity ────────────────────────────────────────────────

describe("detectVolScalp — sensitivity monotonicity", () => {
  it("raising sensitivityFactor makes firing strictly harder", () => {
    const s = snap({ recentTicks: HIGH_VOL() });
    const easy = detectVolScalp(s, { sensitivityFactor: 1.0 });
    const hard = detectVolScalp(s, { sensitivityFactor: 1000 });
    expect(easy).not.toBeNull();
    expect(hard).toBeNull();
  });

  it("the firing invariant payoff ≥ premium × sensitivity holds on every fire", () => {
    for (const sf of [1.0, 1.5, 2.0]) {
      const r = detectVolScalp(snap({ recentTicks: HIGH_VOL() }), { sensitivityFactor: sf });
      if (r !== null) {
        expect(r.estimated_payoff_usd).toBeGreaterThanOrEqual(r.entry_premium * sf - 1e-12);
      }
    }
  });

  it("sensitivityFactor does not alter the computed payoff/move, only the gate", () => {
    const s = snap({ recentTicks: HIGH_VOL() });
    const a = detectVolScalp(s, { sensitivityFactor: 1.0 });
    const b = detectVolScalp(s, { sensitivityFactor: 1.4 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.estimated_payoff_usd).toBeCloseTo(b!.estimated_payoff_usd, 12);
    expect(a!.expected_underlying_move_pct).toBeCloseTo(b!.expected_underlying_move_pct, 12);
    // reason string echoes the sensitivity used.
    expect(a!.reason).toMatch(/x1/);
    expect(b!.reason).toMatch(/x1\.4/);
  });
});

// ─── fee handling ────────────────────────────────────────────────────────────

describe("detectVolScalp — fee handling", () => {
  it("opts.feeBps overrides snap.feeBps; fee_adjustment = feeBps × 2 / 10000", () => {
    const r = detectVolScalp(snap({ feeBps: 999, recentTicks: HIGH_VOL() }), { feeBps: 10 });
    expect(r).not.toBeNull();
    expect(r!.fee_adjustment).toBeCloseTo(0.002, 12);
  });

  it("higher fees lower the estimated payoff (payoff = 0.3×move − fee)", () => {
    const cheap = detectVolScalp(snap({ recentTicks: HIGH_VOL() }), { feeBps: 5 });
    const dear = detectVolScalp(snap({ recentTicks: HIGH_VOL() }), { feeBps: 50 });
    expect(cheap).not.toBeNull();
    expect(dear).not.toBeNull();
    expect(cheap!.estimated_payoff_usd).toBeGreaterThan(dear!.estimated_payoff_usd);
    // The gap equals exactly the fee delta: (50−5)bps × 2 / 10000 = 0.009.
    expect(cheap!.estimated_payoff_usd - dear!.estimated_payoff_usd).toBeCloseTo(0.009, 10);
  });

  it("extreme fees can flip a firing snapshot into a no-signal", () => {
    const base = snap({ recentTicks: HIGH_VOL() });
    expect(detectVolScalp(base, { feeBps: 5 })).not.toBeNull();
    expect(detectVolScalp(base, { feeBps: 5000 })).toBeNull();
  });
});

// ─── payoff / roi internal consistency ───────────────────────────────────────

describe("detectVolScalp — payoff & roi consistency", () => {
  it("estimated_payoff = 0.3 × expected_move − fee_adjustment", () => {
    const r = detectVolScalp(snap({ recentTicks: HIGH_VOL() }), { feeBps: 20 });
    expect(r).not.toBeNull();
    const recomputed = 0.3 * r!.expected_underlying_move_pct - r!.fee_adjustment;
    expect(r!.estimated_payoff_usd).toBeCloseTo(recomputed, 12);
  });

  it("estimated_roi = estimated_payoff / combined_cost", () => {
    const r = detectVolScalp(snap({ recentTicks: HIGH_VOL() }));
    expect(r).not.toBeNull();
    expect(r!.estimated_roi).toBeCloseTo(r!.estimated_payoff_usd / r!.combined_cost, 12);
  });

});

// ─── degenerate / invalid inputs ─────────────────────────────────────────────

describe("detectVolScalp — degenerate inputs", () => {
  it("empty tick array → null (cannot estimate vol)", () => {
    expect(detectVolScalp(snap({ recentTicks: [] }))).toBeNull();
  });

  it("fewer ticks than minTicks → null", () => {
    expect(detectVolScalp(snap({ recentTicks: genTicks(100, 0, 19, 0.05) }))).toBeNull();
  });

  it("zero time-span ticks (all identical timestamps) → null (per-min vol undefined)", () => {
    const sameTs: ScalpTick[] = Array.from({ length: 30 }, (_, i) => ({
      ts: NOW,
      price: 100 + (i % 2 === 0 ? 1 : -1),
    }));
    expect(detectVolScalp(snap({ recentTicks: sameTs }))).toBeNull();
  });

  it("non-positive tick prices are skipped; too few valid returns → null", () => {
    // Alternating valid/zero prices so the log-return loop skips most pairs.
    const ticks: ScalpTick[] = Array.from({ length: 30 }, (_, i) => ({
      ts: NOW + i * 1000,
      price: i % 2 === 0 ? 100 : 0,
    }));
    expect(detectVolScalp(snap({ recentTicks: ticks }))).toBeNull();
  });

  it("invalid prices reject regardless of vol", () => {
    expect(detectVolScalp(snap({ upBestAsk: 0, recentTicks: HIGH_VOL() }))).toBeNull();
    expect(detectVolScalp(snap({ upBestAsk: 1, recentTicks: HIGH_VOL() }))).toBeNull();
    expect(detectVolScalp(snap({ downBestAsk: -0.1, recentTicks: HIGH_VOL() }))).toBeNull();
    expect(detectVolScalp(snap({ downBestAsk: Number.POSITIVE_INFINITY, recentTicks: HIGH_VOL() }))).toBeNull();
  });
});

describe("detectVolScalp — window edge", () => {
  it("non-finite / non-positive remaining window → null", () => {
    expect(detectVolScalp(snap({ windowCloseMs: NOW, recentTicks: HIGH_VOL() }))).toBeNull();
    expect(detectVolScalp(snap({ windowCloseMs: Number.NaN, recentTicks: HIGH_VOL() }))).toBeNull();
  });
});

// ─── option defaults / passthrough identity ──────────────────────────────────

describe("detectVolScalp — option defaults", () => {
  it("passing the documented defaults explicitly equals passing no options", () => {
    const s = snap({ recentTicks: HIGH_VOL() });
    const explicit: VolScalpOptions = {
      minPremium: 0.01,
      maxPremium: 0.1,
      minRemainingMin: 2.0,
      maxRemainingMin: 30.0,
      minTicks: 20,
      sensitivityFactor: 1.5,
    };
    const a = detectVolScalp(s);
    const b = detectVolScalp(s, explicit);
    expect(a).toEqual(b);
  });

  it("a stricter custom minTicks can reject a snapshot the default accepts", () => {
    const s = snap({ recentTicks: genTicks(100, 0, 25, 0.05) }); // 25 ticks
    expect(detectVolScalp(s)).not.toBeNull(); // default minTicks 20
    expect(detectVolScalp(s, { minTicks: 26 })).toBeNull();
  });

  it("identity fields propagate from the snapshot into the opportunity", () => {
    const r = detectVolScalp(snap({ conditionId: "0xABC", asset: "ETH", recentTicks: HIGH_VOL() }));
    expect(r).not.toBeNull();
    expect(r!.conditionId).toBe("0xABC");
    expect(r!.asset).toBe("ETH");
    expect(r!.reason).toContain("ETH");
  });
});
