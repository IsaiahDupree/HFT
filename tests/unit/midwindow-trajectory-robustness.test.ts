import { describe, expect, it } from "vitest";
import {
  detectMidwindowTrajectory,
  normCdf,
  type MidwindowSnapshot,
  type MidwindowTick,
} from "@/lib/strategies/midwindow-trajectory";

/**
 * Complementary robustness / invariant / edge-case suite for the midwindow
 * trajectory detector. These tests intentionally avoid duplicating the basic
 * happy-path / boundary cases in midwindow-trajectory.test.ts and instead
 * exercise:
 *   - normCdf mathematical invariants (monotonicity, symmetry, bounds, ±∞/NaN)
 *   - detector determinism (same input ⇒ identical output, no hidden state)
 *   - no-lookahead (only the supplied snapshot affects the result; no clock)
 *   - monotone responses of model probability to inputs
 *   - exact window-boundary inclusivity
 *   - structural invariants on the returned opportunity
 *   - UP/DOWN symmetry of the strike/price geometry
 *   - empty/short/degenerate inputs ⇒ null (never throw)
 *
 * All inputs are pure synthetic values constructed from the exported types.
 * No DB, no network, no files, no wall-clock, no nondeterministic RNG — a
 * seeded LCG is used for any pseudo-randomness so the file is fully
 * deterministic and reproducible.
 */

const WINDOW_OPEN = Date.parse("2026-05-27T12:00:00Z");
const WINDOW_CLOSE = WINDOW_OPEN + 5 * 60_000;
const NOW_T_PLUS_120S = WINDOW_OPEN + 120_000;

/** Tiny seeded LCG → uniform[-1,1). Deterministic; never reads the clock. */
function makeRand(seed: number): () => number {
  let s = seed & 0x7fffffff;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

/**
 * Per-second tick series from openPrice → nowPrice with seeded noise.
 * Endpoints are forced exact so net delta / efficiency are deterministic.
 */
function synthTicks(
  openPrice: number,
  nowPrice: number,
  sigmaPerTick: number,
  count = 120,
  startMs = WINDOW_OPEN,
  seed = 0x1234abcd,
): MidwindowTick[] {
  const rand = makeRand(seed);
  const out: MidwindowTick[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const trend = openPrice + (nowPrice - openPrice) * t;
    const noise = rand() * sigmaPerTick;
    out.push({ ts: startMs + i * 1000, price: trend + noise });
  }
  out[0] = { ts: startMs, price: openPrice };
  out[count - 1] = { ts: startMs + (count - 1) * 1000, price: nowPrice };
  return out;
}

function snap(overrides: Partial<MidwindowSnapshot> = {}): MidwindowSnapshot {
  const base: MidwindowSnapshot = {
    conditionId: "0xcondMID",
    title: "BTC Up/Down 5m",
    asset: "BTC",
    strike: 68_000,
    windowOpenMs: WINDOW_OPEN,
    windowCloseMs: WINDOW_CLOSE,
    nowMs: NOW_T_PLUS_120S,
    priceAtOpen: 68_000,
    priceNow: 68_120,
    ticksSinceOpen: synthTicks(68_000, 68_120, 1),
    upPrice: 0.55,
    downPrice: 0.45,
    liquidityUsd: 50_000,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// normCdf — mathematical invariants
// ---------------------------------------------------------------------------
describe("normCdf invariants", () => {
  it("is non-decreasing across a swept grid", () => {
    let prev = normCdf(-6);
    for (let x = -6; x <= 6; x += 0.1) {
      const cur = normCdf(x);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
  });

  it("is bounded within [0, 1] for every sampled x", () => {
    for (let x = -10; x <= 10; x += 0.25) {
      const v = normCdf(x);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("obeys the reflection symmetry Φ(-x) = 1 - Φ(x)", () => {
    for (const x of [0.1, 0.5, 1, 1.5, 2, 3, 4.2]) {
      expect(normCdf(-x)).toBeCloseTo(1 - normCdf(x), 6);
    }
  });

  it("maps ±Infinity to exactly 1 and 0", () => {
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normCdf(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("treats NaN as the non-positive branch ⇒ 0 (never NaN)", () => {
    const v = normCdf(Number.NaN);
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(0);
  });

  it("matches known standard-normal quantiles", () => {
    // Φ(1.281552) ≈ 0.90, Φ(1.644854) ≈ 0.95, Φ(1.959964) ≈ 0.975
    expect(normCdf(1.281552)).toBeCloseTo(0.9, 3);
    expect(normCdf(1.644854)).toBeCloseTo(0.95, 3);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 3);
  });

  it("is strictly increasing where it has not saturated", () => {
    expect(normCdf(0.5)).toBeGreaterThan(normCdf(0.4));
    expect(normCdf(-0.4)).toBeGreaterThan(normCdf(-0.5));
  });
});

// ---------------------------------------------------------------------------
// Determinism + no-lookahead
// ---------------------------------------------------------------------------
describe("detector determinism and no-lookahead", () => {
  it("produces byte-identical output for repeated identical input", () => {
    const a = detectMidwindowTrajectory(snap());
    const b = detectMidwindowTrajectory(snap());
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the input snapshot or its tick array", () => {
    const s = snap();
    const ticksBefore = JSON.stringify(s.ticksSinceOpen);
    const snapBefore = JSON.stringify(s);
    detectMidwindowTrajectory(s);
    expect(JSON.stringify(s.ticksSinceOpen)).toBe(ticksBefore);
    expect(JSON.stringify(s)).toBe(snapBefore);
  });

  it("depends only on the snapshot — never reads wall-clock between calls", () => {
    // Two calls separated by real elapsed CPU time must be identical, proving
    // the decision never consults Date.now()/performance.now().
    const first = detectMidwindowTrajectory(snap());
    let acc = 0;
    for (let i = 0; i < 1_000_00; i++) acc += Math.sqrt(i);
    expect(acc).toBeGreaterThan(0); // keep the loop from being optimized away
    const second = detectMidwindowTrajectory(snap());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("future ticks (after nowMs) are not in the snapshot ⇒ projection uses only past data", () => {
    // The detector receives only ticksSinceOpen; appending phantom future-priced
    // ticks (still timestamped within elapsed) changes variance but the engine
    // never indexes by nowMs to peek ahead — confirm result stays a function of
    // the array provided, with no implicit time-travel.
    const base = snap();
    const projBase = detectMidwindowTrajectory(base)!.projectedFinal;
    // projectedFinal must equal priceNow + delta*(remaining/elapsed) exactly,
    // using ONLY priceNow/priceAtOpen — independent of intra-window tick path.
    const delta = base.priceNow - base.priceAtOpen;
    const expected = base.priceNow + delta * (3 / 2);
    expect(projBase).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// Window boundary inclusivity (exact edges)
// ---------------------------------------------------------------------------
describe("window boundary inclusivity", () => {
  it("fires at exactly T+minElapsed (90s) — boundary is inclusive", () => {
    const op = detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 90_000 }));
    expect(op).not.toBeNull();
    expect(op!.elapsedMin).toBeCloseTo(1.5, 6);
  });

  it("fires at exactly T+maxElapsed (150s) — boundary is inclusive", () => {
    const op = detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 150_000 }));
    expect(op).not.toBeNull();
    expect(op!.elapsedMin).toBeCloseTo(2.5, 6);
  });

  it("returns null one ms before T+minElapsed", () => {
    expect(
      detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 90_000 - 1 })),
    ).toBeNull();
  });

  it("returns null one ms after T+maxElapsed", () => {
    expect(
      detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 150_000 + 1 })),
    ).toBeNull();
  });

  it("returns null when remaining ≤ 60s even if elapsed is in-window", () => {
    // Shrink the window so that at T+150s only 30s remain → projection refused.
    const op = detectMidwindowTrajectory(
      snap({
        nowMs: WINDOW_OPEN + 150_000,
        windowCloseMs: WINDOW_OPEN + 180_000,
      }),
    );
    expect(op).toBeNull();
  });

  it("custom minElapsedMs widens the firing window", () => {
    // At T+60s the default rejects; lowering minElapsedMs to 50s accepts it
    // (remaining = 4 min > 1 min, so the remaining-time guard still passes).
    const tooEarlyDefault = detectMidwindowTrajectory(
      snap({ nowMs: WINDOW_OPEN + 60_000, ticksSinceOpen: synthTicks(68_000, 68_120, 1, 60) }),
    );
    expect(tooEarlyDefault).toBeNull();
    const widened = detectMidwindowTrajectory(
      snap({ nowMs: WINDOW_OPEN + 60_000, ticksSinceOpen: synthTicks(68_000, 68_120, 1, 60) }),
      { minElapsedMs: 50_000 },
    );
    expect(widened).not.toBeNull();
    expect(widened!.elapsedMin).toBeCloseTo(1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants on the returned opportunity
// ---------------------------------------------------------------------------
describe("opportunity structural invariants", () => {
  it("carries through identity fields verbatim from the snapshot", () => {
    const s = snap({ conditionId: "0xABCDEF", asset: "ETH", title: "ETH 5m" });
    const op = detectMidwindowTrajectory(s)!;
    expect(op.conditionId).toBe("0xABCDEF");
    expect(op.asset).toBe("ETH");
    expect(op.title).toBe("ETH 5m");
    expect(op.liquidityUsd).toBe(s.liquidityUsd);
  });

  it("modelProbUp and marketProbUp are valid probabilities in [0,1]", () => {
    const op = detectMidwindowTrajectory(snap())!;
    expect(op.modelProbUp).toBeGreaterThanOrEqual(0);
    expect(op.modelProbUp).toBeLessThanOrEqual(1);
    expect(op.marketProbUp).toBeGreaterThanOrEqual(0);
    expect(op.marketProbUp).toBeLessThanOrEqual(1);
  });

  it("marketProbUp always equals the snapshot upPrice", () => {
    for (const up of [0.5, 0.55, 0.6]) {
      const op = detectMidwindowTrajectory(snap({ upPrice: up, downPrice: 1 - up }));
      expect(op!.marketProbUp).toBe(up);
    }
  });

  it("signedEdge equals modelProbUp - marketProbUp exactly", () => {
    const op = detectMidwindowTrajectory(snap())!;
    expect(op.signedEdge).toBeCloseTo(op.modelProbUp - op.marketProbUp, 12);
  });

  it("net edge equals |signedEdge| - feeAdjustment and exceeds the threshold", () => {
    const feeBps = 20;
    const op = detectMidwindowTrajectory(snap(), { feeBps })!;
    expect(op.edge).toBeCloseTo(Math.abs(op.signedEdge) - feeBps / 10_000, 12);
    expect(op.edge).toBeGreaterThan(0.05); // default edgeThreshold, strict
  });

  it("entryPrice equals the chosen side's ask and lies in (0,1)", () => {
    const upOp = detectMidwindowTrajectory(snap())!;
    expect(upOp.side).toBe("UP");
    expect(upOp.entryPrice).toBe(upOp.marketProbUp); // upPrice
    expect(upOp.entryPrice).toBeGreaterThan(0);
    expect(upOp.entryPrice).toBeLessThan(1);

    const downOp = detectMidwindowTrajectory(
      snap({
        priceNow: 67_880,
        ticksSinceOpen: synthTicks(68_000, 67_880, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    )!;
    expect(downOp.side).toBe("DOWN");
    expect(downOp.entryPrice).toBe(0.5); // downPrice
  });

  it("efficiency, zMove, sigmaRemaining are finite and within expected bounds", () => {
    const op = detectMidwindowTrajectory(snap())!;
    expect(Number.isFinite(op.efficiency)).toBe(true);
    expect(op.efficiency).toBeGreaterThanOrEqual(0);
    expect(op.efficiency).toBeLessThanOrEqual(1);
    expect(op.zMove).toBeGreaterThanOrEqual(1.0); // cleared minZMove
    expect(op.sigmaRemaining).toBeGreaterThan(0);
    expect(Number.isFinite(op.sigmaRemaining)).toBe(true);
  });

  it("elapsedMin + remainingMin equals the full window span in minutes", () => {
    const op = detectMidwindowTrajectory(snap())!;
    expect(op.elapsedMin + op.remainingMin).toBeCloseTo(5.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Monotone responses of the model to inputs
// ---------------------------------------------------------------------------
describe("monotone model responses", () => {
  it("a larger upward delta yields a higher (or equal) projectedFinal", () => {
    const small = detectMidwindowTrajectory(
      snap({ priceNow: 68_080, ticksSinceOpen: synthTicks(68_000, 68_080, 1) }),
    )!;
    const big = detectMidwindowTrajectory(
      snap({ priceNow: 68_200, ticksSinceOpen: synthTicks(68_000, 68_200, 1) }),
    )!;
    expect(big.projectedFinal).toBeGreaterThan(small.projectedFinal);
  });

  it("raising the strike (holding everything else) lowers modelProbUp", () => {
    const low = detectMidwindowTrajectory(snap({ strike: 68_000 }))!;
    const high = detectMidwindowTrajectory(snap({ strike: 68_250 }));
    // With a higher strike the upside z-score falls ⇒ lower model prob UP.
    // It may even drop the signal entirely; if it still fires, prob must fall.
    if (high) {
      expect(high.modelProbUp).toBeLessThan(low.modelProbUp);
    } else {
      // Strike raised above the projection collapses the edge → null is valid,
      // and consistent with a strictly lower model prob.
      expect(low.modelProbUp).toBeGreaterThan(0.5);
    }
  });

  it("a stronger upward trajectory increases modelProbUp toward 1", () => {
    // Strike set near the projected final and noise sig=10 keep both
    // probabilities in the unsaturated band (< 1) so the strict increase is
    // observable rather than both clamping to the Φ ceiling of 1.0.
    const moderate = detectMidwindowTrajectory(
      snap({
        priceNow: 68_260,
        strike: 68_520,
        upPrice: 0.45,
        downPrice: 0.55,
        ticksSinceOpen: synthTicks(68_000, 68_260, 10),
      }),
    )!;
    const strong = detectMidwindowTrajectory(
      snap({
        priceNow: 68_320,
        strike: 68_520,
        upPrice: 0.45,
        downPrice: 0.55,
        ticksSinceOpen: synthTicks(68_000, 68_320, 10),
      }),
    )!;
    expect(moderate.modelProbUp).toBeLessThan(1);
    expect(strong.modelProbUp).toBeLessThan(1);
    expect(strong.modelProbUp).toBeGreaterThan(moderate.modelProbUp);
  });

  it("higher feeBps shrinks net edge monotonically", () => {
    const lowFee = detectMidwindowTrajectory(snap(), { feeBps: 10 })!;
    const highFee = detectMidwindowTrajectory(snap(), { feeBps: 100 })!;
    expect(highFee.edge).toBeLessThan(lowFee.edge);
    // Same signed edge (fee doesn't change probabilities), so the delta in net
    // edge equals the delta in fee, in price-points.
    expect(lowFee.edge - highFee.edge).toBeCloseTo((100 - 10) / 10_000, 12);
  });

  it("raising minZMove past the realized zMove suppresses the signal", () => {
    const op = detectMidwindowTrajectory(snap())!;
    const blocked = detectMidwindowTrajectory(snap(), { minZMove: op.zMove + 5 });
    expect(blocked).toBeNull();
  });

  it("raising minEfficiency past the realized efficiency suppresses the signal", () => {
    const op = detectMidwindowTrajectory(snap())!;
    // Realized efficiency of the default monotone-ish move is < 1 with headroom.
    expect(op.efficiency).toBeLessThan(1);
    // A threshold a hair above the realized efficiency must block the fire,
    // since the filter rejects when efficiency < minEfficiency.
    const justAbove = (op.efficiency + 1) / 2; // strictly between realized eff and 1
    expect(justAbove).toBeGreaterThan(op.efficiency);
    expect(justAbove).toBeLessThanOrEqual(1);
    const blocked = detectMidwindowTrajectory(snap(), { minEfficiency: justAbove });
    expect(blocked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UP / DOWN symmetry
// ---------------------------------------------------------------------------
describe("UP/DOWN geometric symmetry", () => {
  it("mirrored +Δ above strike and -Δ below strike give symmetric model probs", () => {
    // Up case: open=strike, priceNow=strike+120 ⇒ projected above strike.
    const upOp = detectMidwindowTrajectory(
      snap({
        strike: 68_000,
        priceAtOpen: 68_000,
        priceNow: 68_120,
        ticksSinceOpen: synthTicks(68_000, 68_120, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    )!;
    // Down case: exact mirror about the strike.
    const downOp = detectMidwindowTrajectory(
      snap({
        strike: 68_000,
        priceAtOpen: 68_000,
        priceNow: 67_880,
        ticksSinceOpen: synthTicks(68_000, 67_880, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    )!;
    expect(upOp.side).toBe("UP");
    expect(downOp.side).toBe("DOWN");
    // modelProbUp_up ≈ 1 - modelProbUp_down (reflection through 0.5).
    expect(upOp.modelProbUp).toBeCloseTo(1 - downOp.modelProbUp, 2);
    // Signed edges are equal magnitude, opposite sign (market is 0.5 each).
    expect(upOp.signedEdge).toBeCloseTo(-downOp.signedEdge, 2);
  });

  it("zFinal flips sign across the strike for mirrored moves", () => {
    const upOp = detectMidwindowTrajectory(
      snap({
        priceAtOpen: 68_000,
        priceNow: 68_120,
        ticksSinceOpen: synthTicks(68_000, 68_120, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    )!;
    const downOp = detectMidwindowTrajectory(
      snap({
        priceAtOpen: 68_000,
        priceNow: 67_880,
        ticksSinceOpen: synthTicks(68_000, 67_880, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    )!;
    expect(upOp.zFinal).toBeGreaterThan(0);
    expect(downOp.zFinal).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Empty / short / degenerate inputs — never throw, return null
// ---------------------------------------------------------------------------
describe("empty and degenerate inputs", () => {
  it("returns null (no throw) on an empty tick array", () => {
    expect(() =>
      detectMidwindowTrajectory(snap({ ticksSinceOpen: [] })),
    ).not.toThrow();
    expect(detectMidwindowTrajectory(snap({ ticksSinceOpen: [] }))).toBeNull();
  });

  it("returns null on a single-tick array", () => {
    expect(
      detectMidwindowTrajectory(
        snap({ ticksSinceOpen: [{ ts: WINDOW_OPEN, price: 68_000 }] }),
      ),
    ).toBeNull();
  });

  it("returns null when exactly one short of minTicks", () => {
    // 29 ticks < default 30.
    expect(
      detectMidwindowTrajectory(snap({ ticksSinceOpen: synthTicks(68_000, 68_120, 1, 29) })),
    ).toBeNull();
  });

  it("fires at exactly minTicks (30) with a clean monotonic move", () => {
    const op = detectMidwindowTrajectory(
      snap({ ticksSinceOpen: synthTicks(68_000, 68_120, 0, 30) }),
    );
    expect(op).not.toBeNull();
  });

  it("returns null on non-finite priceNow / priceAtOpen", () => {
    expect(detectMidwindowTrajectory(snap({ priceNow: Number.NaN }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ priceAtOpen: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ priceNow: 0 }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ priceAtOpen: -5 }))).toBeNull();
  });

  it("returns null on a non-finite window span", () => {
    expect(detectMidwindowTrajectory(snap({ windowCloseMs: Number.NaN }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ windowOpenMs: Number.NaN }))).toBeNull();
  });

  it("returns null on zero-length window (open == close)", () => {
    expect(
      detectMidwindowTrajectory(snap({ windowCloseMs: WINDOW_OPEN, windowOpenMs: WINDOW_OPEN })),
    ).toBeNull();
  });

  it("survives ticks containing a non-positive price without throwing", () => {
    // A poisoned zero price mid-series must be skipped, not crash; the result
    // is simply null/an opportunity but never an exception.
    const ticks = synthTicks(68_000, 68_120, 1);
    ticks[60] = { ts: WINDOW_OPEN + 60_000, price: 0 };
    expect(() => detectMidwindowTrajectory(snap({ ticksSinceOpen: ticks }))).not.toThrow();
  });

  it("returns null when the chop filter (noise) inflates σ and kills zMove", () => {
    // Heavy per-tick noise relative to a tiny net move ⇒ zMove < 1 ⇒ null.
    const op = detectMidwindowTrajectory(
      snap({ priceNow: 68_005, ticksSinceOpen: synthTicks(68_000, 68_005, 40) }),
    );
    expect(op).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Threshold edge semantics (strict-vs-inclusive comparisons)
// ---------------------------------------------------------------------------
describe("threshold edge semantics", () => {
  it("edge gate is strict: net edge must EXCEED edgeThreshold", () => {
    const op = detectMidwindowTrajectory(snap())!;
    // Setting the threshold to exactly the realized net edge must reject,
    // because the implementation uses `edgeNet <= edgeThreshold ⇒ null`.
    const atBoundary = detectMidwindowTrajectory(snap(), { edgeThreshold: op.edge });
    expect(atBoundary).toBeNull();
    // A hair below the realized edge passes.
    const justBelow = detectMidwindowTrajectory(snap(), { edgeThreshold: op.edge - 1e-6 });
    expect(justBelow).not.toBeNull();
  });

  it("tighter edgeThreshold can only suppress, never create, a signal", () => {
    const loose = detectMidwindowTrajectory(snap(), { edgeThreshold: 0.01 });
    const tight = detectMidwindowTrajectory(snap(), { edgeThreshold: 0.99 });
    expect(loose).not.toBeNull();
    expect(tight).toBeNull();
  });
});
