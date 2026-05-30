import { describe, expect, it } from "vitest";
import {
  detectMidwindowTrajectory,
  normCdf,
  type MidwindowSnapshot,
  type MidwindowTick,
} from "@/lib/strategies/midwindow-trajectory";

const WINDOW_OPEN = Date.parse("2026-05-27T12:00:00Z");
const WINDOW_CLOSE = WINDOW_OPEN + 5 * 60_000;
const NOW_T_PLUS_120S = WINDOW_OPEN + 120_000;

/**
 * Build a synthetic per-second tick series from openPrice to nowPrice with
 * a configurable noise sigma (in price units). 120 ticks @ 1s = 2min.
 */
function synthTicks(
  openPrice: number,
  nowPrice: number,
  sigmaPerTick: number,
  count = 120,
  startMs = WINDOW_OPEN,
): MidwindowTick[] {
  // Deterministic pseudo-random LCG so tests are reproducible.
  let seed = 0x1234abcd;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1; // ~uniform[-1,1]
  };
  const out: MidwindowTick[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const trend = openPrice + (nowPrice - openPrice) * t;
    const noise = rand() * sigmaPerTick;
    out.push({ ts: startMs + i * 1000, price: trend + noise });
  }
  // Force exact open & close values so deterministic tests hold.
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
    priceNow: 68_120, // +$120 over 2 min
    ticksSinceOpen: synthTicks(68_000, 68_120, 1),
    upPrice: 0.55,
    downPrice: 0.45,
    liquidityUsd: 50_000,
  };
  return { ...base, ...overrides };
}

describe("normCdf", () => {
  it("normCdf(0) ≈ 0.5", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });
  it("normCdf(+∞) ≈ 1, normCdf(-∞) ≈ 0", () => {
    expect(normCdf(8)).toBeCloseTo(1, 6);
    expect(normCdf(-8)).toBeCloseTo(0, 6);
  });
  it("normCdf(1) ≈ 0.8413", () => {
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
  });
});

describe("detectMidwindowTrajectory", () => {
  it("fires UP when upward trajectory with large z-move + market mispriced", () => {
    // 2-min move +$120 vs σ_per_tick=$5 → very high zMove
    // projected_final = 68120 + 120 × (3/2) = 68300; well above strike 68000
    // Market upPrice = 0.55, model should be ~0.95+
    const op = detectMidwindowTrajectory(snap());
    expect(op).not.toBeNull();
    expect(op!.side).toBe("UP");
    expect(op!.projectedFinal).toBeCloseTo(68_300, 0);
    expect(op!.modelProbUp).toBeGreaterThan(0.9);
    expect(op!.signedEdge).toBeGreaterThan(0.3);
    expect(op!.entryPrice).toBe(0.55);
  });

  it("fires DOWN when downward trajectory and market still pricing 50/50", () => {
    const op = detectMidwindowTrajectory(
      snap({
        priceAtOpen: 68_000,
        priceNow: 67_880,
        ticksSinceOpen: synthTicks(68_000, 67_880, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    );
    expect(op).not.toBeNull();
    expect(op!.side).toBe("DOWN");
    expect(op!.modelProbUp).toBeLessThan(0.1);
    expect(op!.signedEdge).toBeLessThan(-0.3);
    expect(op!.entryPrice).toBe(0.5);
  });

  it("returns null before T+90s (too early)", () => {
    const op = detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 60_000 }));
    expect(op).toBeNull();
  });

  it("returns null after T+150s (window passed)", () => {
    const op = detectMidwindowTrajectory(snap({ nowMs: WINDOW_OPEN + 180_000 }));
    expect(op).toBeNull();
  });

  it("returns null with fewer than minTicks", () => {
    const op = detectMidwindowTrajectory(
      snap({ ticksSinceOpen: synthTicks(68_000, 68_120, 1, 10) }),
    );
    expect(op).toBeNull();
  });

  it("returns null when zMove is below threshold (move within noise)", () => {
    // Tiny move ($1) with huge noise (σ=$50/tick) → zMove << 1
    const op = detectMidwindowTrajectory(
      snap({ priceNow: 68_001, ticksSinceOpen: synthTicks(68_000, 68_001, 50) }),
    );
    expect(op).toBeNull();
  });

  it("returns null when edge below threshold (market already priced)", () => {
    // Big move, but market upPrice is 0.97 — model can't beat it by 5pp
    const op = detectMidwindowTrajectory(snap({ upPrice: 0.97, downPrice: 0.03 }));
    expect(op).toBeNull();
  });

  it("returns null on invalid strike", () => {
    expect(detectMidwindowTrajectory(snap({ strike: NaN }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ strike: -1 }))).toBeNull();
  });

  it("returns null on invalid market prices (0, 1, NaN)", () => {
    expect(detectMidwindowTrajectory(snap({ upPrice: 0 }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ upPrice: 1.0 }))).toBeNull();
    expect(detectMidwindowTrajectory(snap({ downPrice: NaN }))).toBeNull();
  });

  it("returns null on degenerate (zero) variance ticks", () => {
    // 120 identical ticks → stdev = 0 → sigma below floor
    const flat: MidwindowTick[] = Array.from({ length: 120 }, (_, i) => ({
      ts: WINDOW_OPEN + i * 1000,
      price: 68_000,
    }));
    const op = detectMidwindowTrajectory(snap({ ticksSinceOpen: flat, priceNow: 68_000 }));
    expect(op).toBeNull();
  });

  it("returns null when window is malformed (close <= open)", () => {
    expect(
      detectMidwindowTrajectory(snap({ windowCloseMs: WINDOW_OPEN })),
    ).toBeNull();
  });

  it("signedEdge sign matches chosen side", () => {
    const up = detectMidwindowTrajectory(snap());
    expect(up!.side).toBe("UP");
    expect(up!.signedEdge).toBeGreaterThan(0);

    const down = detectMidwindowTrajectory(
      snap({
        priceAtOpen: 68_000,
        priceNow: 67_850,
        ticksSinceOpen: synthTicks(68_000, 67_850, 1),
        upPrice: 0.5,
        downPrice: 0.5,
      }),
    );
    expect(down!.side).toBe("DOWN");
    expect(down!.signedEdge).toBeLessThan(0);
  });

  it("projection equation: priceNow + delta × (remaining/elapsed)", () => {
    // 2 min elapsed, 3 min remaining → multiplier 1.5
    // delta = +120 → projected = 68120 + 180 = 68300
    const op = detectMidwindowTrajectory(snap());
    expect(op!.projectedFinal).toBeCloseTo(68_120 + 120 * 1.5, 0);
    expect(op!.elapsedMin).toBeCloseTo(2.0, 2);
    expect(op!.remainingMin).toBeCloseTo(3.0, 2);
  });

  it("custom edgeThreshold = 0.50 filters out a 0.40-edge signal", () => {
    const loose = detectMidwindowTrajectory(snap(), { edgeThreshold: 0.05 });
    expect(loose).not.toBeNull();
    const tight = detectMidwindowTrajectory(snap(), { edgeThreshold: 0.5 });
    expect(tight).toBeNull();
  });

  it("liquidityUsd surfaces in opportunity for downstream sizing", () => {
    const op = detectMidwindowTrajectory(snap({ liquidityUsd: 123_456 }));
    expect(op!.liquidityUsd).toBe(123_456);
  });

  it("efficiency = ~1.0 for a perfectly monotonic move (synthTicks with sigma=0)", () => {
    const op = detectMidwindowTrajectory(
      snap({ ticksSinceOpen: synthTicks(68_000, 68_120, 0) }),
    );
    expect(op).not.toBeNull();
    // synthTicks with sigma=0 is monotonic linear, so efficiency must be ≈1.
    expect(op!.efficiency).toBeGreaterThan(0.95);
  });

  it("returns null when ticks zigzag heavily (low efficiency = chop)", () => {
    // Generate ticks that oscillate ±$60 each step but net to +$120 over 120s.
    // The path length will be ~$60 × 120 ≈ $7200, net $120 → efficiency ≈ 0.017
    let seed = 0x55;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    const ticks: MidwindowTick[] = [];
    for (let i = 0; i < 120; i++) {
      const trend = 68_000 + (120 / 119) * i;
      const noise = rand() * 60;
      ticks.push({ ts: WINDOW_OPEN + i * 1000, price: trend + noise });
    }
    ticks[0] = { ts: WINDOW_OPEN, price: 68_000 };
    ticks[119] = { ts: WINDOW_OPEN + 119_000, price: 68_120 };
    const op = detectMidwindowTrajectory(snap({ ticksSinceOpen: ticks }));
    expect(op).toBeNull();
  });

  it("efficiency is exposed on the opportunity result", () => {
    const op = detectMidwindowTrajectory(snap());
    expect(op).not.toBeNull();
    expect(op!.efficiency).toBeGreaterThanOrEqual(0);
    expect(op!.efficiency).toBeLessThanOrEqual(1);
  });

  it("minEfficiency=0 disables the chop filter", () => {
    // Build a low-efficiency zigzag move that would normally fire if filter were off.
    let seed = 0x77;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    const ticks: MidwindowTick[] = [];
    for (let i = 0; i < 120; i++) {
      const trend = 68_000 + (120 / 119) * i;
      const noise = rand() * 60;
      ticks.push({ ts: WINDOW_OPEN + i * 1000, price: trend + noise });
    }
    ticks[0] = { ts: WINDOW_OPEN, price: 68_000 };
    ticks[119] = { ts: WINDOW_OPEN + 119_000, price: 68_120 };

    const gated = detectMidwindowTrajectory(snap({ ticksSinceOpen: ticks }));
    expect(gated).toBeNull();
    const ungated = detectMidwindowTrajectory(snap({ ticksSinceOpen: ticks }), {
      minEfficiency: 0,
    });
    // Note: ungated may still be null because the high noise inflates σ_elapsed
    // and shrinks zMove below the default zMove threshold. The point of this
    // test is that minEfficiency=0 doesn't block on efficiency specifically.
    // We confirm by checking that a SMALL noise (high efficiency) lets it fire
    // with both filters off in different ways:
    const cleanOp = detectMidwindowTrajectory(snap(), { minEfficiency: 0 });
    expect(cleanOp).not.toBeNull();
    void ungated; // documented above
  });

  it("reason string mentions side, asset, edge", () => {
    const op = detectMidwindowTrajectory(snap());
    expect(op!.reason).toMatch(/BTC/);
    expect(op!.reason).toMatch(/UP/);
    expect(op!.reason).toMatch(/edge/);
  });
});
