/**
 * Robustness / invariant tests for the complement-sum arbitrage detector
 * (Phase 12). Complements complement-sum-arb.test.ts — these cover deeper
 * invariants, exact boundary arithmetic, the max-ask depth divisor, fee
 * netting symmetry, determinism, and a fully-seeded (LCG) fuzz harness.
 *
 * All inputs are pure synthetic objects. No IO, no clock reads, no real RNG.
 * Pseudo-randomness comes from a deterministic LCG seeded with fixed values.
 */
import { describe, expect, it } from "vitest";
import {
  detectComplementSumArb,
  type BinaryBookSnapshot,
  type ComplementArbOptions,
  type ComplementArbOpportunity,
} from "@/lib/strategies/complement-sum-arb";

// Fixed epoch anchors — never read from the system clock.
const NOW = Date.parse("2026-05-28T12:00:00Z");
const HOUR_FROM_NOW = NOW + 60 * 60_000;

function snap(over: Partial<BinaryBookSnapshot> = {}): BinaryBookSnapshot {
  return {
    conditionId: "0xCOND",
    title: "BTC Up vs Down 5m",
    asset: "BTC",
    windowCloseMs: HOUR_FROM_NOW,
    nowMs: NOW,
    upBestAsk: 0.48,
    downBestAsk: 0.48,
    upDepthUsd: 100,
    downDepthUsd: 100,
    feeBps: 20,
    ...over,
  };
}

// Deterministic LCG (Numerical Recipes constants), returns float in [0,1).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("detectComplementSumArb — arb detection edge sign", () => {
  it("positive net profit and roi have the same (positive) sign on a real arb", () => {
    const op = detectComplementSumArb(snap())!;
    expect(op.net_profit_per_pair).toBeGreaterThan(0);
    expect(op.roi).toBeGreaterThan(0);
    expect(Math.sign(op.roi)).toBe(Math.sign(op.net_profit_per_pair));
  });

  it("gross profit equals exactly 1 - combined_cost", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.40, downBestAsk: 0.50 }))!;
    expect(op.combined_cost).toBeCloseTo(0.90, 9);
    expect(op.gross_profit_per_pair).toBeCloseTo(1 - op.combined_cost, 9);
  });

  it("net profit is strictly less than gross profit whenever fees are positive", () => {
    const op = detectComplementSumArb(snap(), { feeBps: 20 })!;
    expect(op.net_profit_per_pair).toBeLessThan(op.gross_profit_per_pair);
    expect(op.gross_profit_per_pair - op.net_profit_per_pair).toBeCloseTo(op.fee_adjustment, 9);
  });

  it("net profit equals gross profit exactly when fees are zero", () => {
    const op = detectComplementSumArb(snap(), { feeBps: 0 })!;
    expect(op.fee_adjustment).toBe(0);
    expect(op.net_profit_per_pair).toBeCloseTo(op.gross_profit_per_pair, 9);
  });
});

describe("detectComplementSumArb — no-arb when sum >= 1", () => {
  it("returns null when combined cost is exactly 1.0", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: 0.5, downBestAsk: 0.5 }))).toBeNull();
  });

  it("returns null when combined cost exceeds 1.0", () => {
    expect(detectComplementSumArb(snap({ upBestAsk: 0.6, downBestAsk: 0.55 }))).toBeNull();
  });

  it("never returns an opportunity whose combined_cost is >= 1", () => {
    // Sweep a grid of asks; whenever a result is returned, combined < 1.
    for (let u = 1; u <= 9; u++) {
      for (let d = 1; d <= 9; d++) {
        const up = u / 10;
        const down = d / 10;
        const op = detectComplementSumArb(
          snap({ upBestAsk: up, downBestAsk: down }),
          { maxCombinedCost: 0.999, minProfitPerPair: -1, feeBps: 0 },
        );
        if (op) expect(op.combined_cost).toBeLessThan(1);
      }
    }
  });

  it("even with permissive thresholds, sum at 0.999 with tiny fee can still qualify but sum=1.0 cannot", () => {
    const justUnder = detectComplementSumArb(
      snap({ upBestAsk: 0.5, downBestAsk: 0.499 }),
      { maxCombinedCost: 0.999, minProfitPerPair: -1, feeBps: 0 },
    );
    expect(justUnder).not.toBeNull();
    expect(justUnder!.combined_cost).toBeLessThan(1);
    const atOne = detectComplementSumArb(
      snap({ upBestAsk: 0.5, downBestAsk: 0.5 }),
      { maxCombinedCost: 0.999, minProfitPerPair: -1, feeBps: 0 },
    );
    expect(atOne).toBeNull();
  });
});

describe("detectComplementSumArb — fee netting", () => {
  it("fee_adjustment scales linearly with feeBps", () => {
    const a = detectComplementSumArb(snap(), { feeBps: 50 })!;
    const b = detectComplementSumArb(snap(), { feeBps: 100 })!;
    const c = detectComplementSumArb(snap(), { feeBps: 150 })!;
    expect(a.fee_adjustment).toBeCloseTo(0.005, 9);
    expect(b.fee_adjustment).toBeCloseTo(0.010, 9);
    expect(c.fee_adjustment).toBeCloseTo(0.015, 9);
    // Equal spacing in bps (50→100→150) → equal spacing in fee_adjustment.
    expect(b.fee_adjustment - a.fee_adjustment).toBeCloseTo(c.fee_adjustment - b.fee_adjustment, 9);
    // And the ratio matches the bps ratio exactly.
    expect(c.fee_adjustment / a.fee_adjustment).toBeCloseTo(150 / 50, 9);
  });

  it("opts.feeBps overrides market.feeBps", () => {
    // market says 20bps, opts says 100bps → opts wins.
    const op = detectComplementSumArb(snap({ feeBps: 20 }), { feeBps: 100 })!;
    expect(op.fee_adjustment).toBeCloseTo(0.01, 9);
  });

  it("market.feeBps is used when opts.feeBps is omitted", () => {
    const op = detectComplementSumArb(snap({ feeBps: 75 }), {})!;
    expect(op.fee_adjustment).toBeCloseTo(0.0075, 9);
  });

  it("falls back to default 20bps when neither opts nor market supply feeBps", () => {
    const s = snap();
    delete (s as Partial<BinaryBookSnapshot>).feeBps;
    const op = detectComplementSumArb(s, {})!;
    expect(op.fee_adjustment).toBeCloseTo(0.002, 9); // 20 / 10000
  });

  it("a large enough fee turns a gross-profitable book into a rejection", () => {
    // gross 0.04; fee 0.041 → net negative < default min profit.
    expect(detectComplementSumArb(snap(), { feeBps: 410 })).toBeNull();
  });

  it("net profit decreases monotonically as fees increase (until it gates out)", () => {
    let prev = Infinity;
    for (const bps of [0, 5, 10, 15]) {
      const op = detectComplementSumArb(snap(), { feeBps: bps, minProfitPerPair: -1 })!;
      expect(op.net_profit_per_pair).toBeLessThanOrEqual(prev);
      prev = op.net_profit_per_pair;
    }
  });
});

describe("detectComplementSumArb — boundary arithmetic", () => {
  it("net profit exactly at the min-profit floor is accepted (>= comparison)", () => {
    // combined 0.96, gross 0.04, fee 0 → net 0.04. Set min exactly to 0.04.
    const op = detectComplementSumArb(snap(), { feeBps: 0, minProfitPerPair: 0.04 });
    expect(op).not.toBeNull();
    expect(op!.net_profit_per_pair).toBeCloseTo(0.04, 9);
  });

  it("net profit a hair below the floor is rejected", () => {
    const op = detectComplementSumArb(snap(), { feeBps: 0, minProfitPerPair: 0.0400001 });
    expect(op).toBeNull();
  });

  it("combined cost exactly at maxCombinedCost is accepted (<= comparison)", () => {
    // upBestAsk 0.45 + downBestAsk 0.45 = 0.90; set maxCombined exactly 0.90.
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.45, downBestAsk: 0.45 }),
      { maxCombinedCost: 0.90 },
    );
    expect(op).not.toBeNull();
  });

  it("combined cost a hair above maxCombinedCost is rejected", () => {
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.45, downBestAsk: 0.4500001 }),
      { maxCombinedCost: 0.90 },
    );
    expect(op).toBeNull();
  });

  it("time exactly at the hold floor is accepted, a hair under is rejected", () => {
    // minHold default 1.0 min = 60_000 ms.
    const atFloor = detectComplementSumArb(snap({ windowCloseMs: NOW + 60_000 }));
    expect(atFloor).not.toBeNull();
    expect(atFloor!.time_to_resolve_min).toBeCloseTo(1.0, 9);
    const underFloor = detectComplementSumArb(snap({ windowCloseMs: NOW + 59_999 }));
    expect(underFloor).toBeNull();
  });
});

describe("detectComplementSumArb — depth gating (max-ask divisor)", () => {
  it("max_pairs uses the LARGER ask as the per-pair divisor on min-side depth", () => {
    // Asymmetric asks: up 0.30, down 0.60 (combined 0.90). Equal depth 90.
    // Implementation divides minSideDepth by max(up,down) = 0.60.
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.30, downBestAsk: 0.60, upDepthUsd: 90, downDepthUsd: 90 }),
      { feeBps: 0 },
    )!;
    expect(op.max_pairs).toBe(Math.floor(90 / 0.60)); // 150
  });

  it("max_pairs is bounded by the shallower side, not the deeper one", () => {
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.45, downBestAsk: 0.45, upDepthUsd: 30, downDepthUsd: 500 }),
      { feeBps: 0 },
    )!;
    expect(op.max_pairs).toBe(Math.floor(30 / 0.45));
  });

  it("returns null when shallow side cannot fund a single pair at the larger ask", () => {
    // depth 0.59 on the binding side, larger ask 0.60 → floor(0.59/0.60)=0 → null.
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.30, downBestAsk: 0.60, upDepthUsd: 0.59, downDepthUsd: 0.59 }),
      { feeBps: 0 },
    );
    expect(op).toBeNull();
  });

  it("exactly one pair of depth is accepted (boundary at maxPairs == 1)", () => {
    // larger ask 0.60, depth exactly 0.60 → floor(0.60/0.60)=1 → accepted.
    const op = detectComplementSumArb(
      snap({ upBestAsk: 0.30, downBestAsk: 0.60, upDepthUsd: 0.60, downDepthUsd: 0.60 }),
      { feeBps: 0 },
    );
    expect(op).not.toBeNull();
    expect(op!.max_pairs).toBe(1);
  });

  it("max_pairs is a non-negative integer", () => {
    const op = detectComplementSumArb(snap({ upDepthUsd: 137, downDepthUsd: 211 }))!;
    expect(Number.isInteger(op.max_pairs)).toBe(true);
    expect(op.max_pairs).toBeGreaterThanOrEqual(1);
  });

  it("deeper books never reduce max_pairs (monotone non-decreasing in min-side depth)", () => {
    let prev = -1;
    for (const depth of [10, 25, 50, 100, 250]) {
      const op = detectComplementSumArb(
        snap({ upDepthUsd: depth, downDepthUsd: depth }),
        { feeBps: 0 },
      );
      // depth 10 may gate out (floor(10/0.48)=20 ≥1 so it survives), all survive here.
      expect(op).not.toBeNull();
      expect(op!.max_pairs).toBeGreaterThanOrEqual(prev);
      prev = op!.max_pairs;
    }
  });
});

describe("detectComplementSumArb — aggregate invariants", () => {
  it("capital_required equals max_pairs * combined_cost", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.44, downBestAsk: 0.46 }))!;
    expect(op.capital_required_usd).toBeCloseTo(op.max_pairs * op.combined_cost, 6);
  });

  it("total_profit equals max_pairs * net_profit_per_pair", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.44, downBestAsk: 0.46 }))!;
    expect(op.total_profit_usd).toBeCloseTo(op.max_pairs * op.net_profit_per_pair, 6);
  });

  it("roi equals net_profit_per_pair / combined_cost", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.40, downBestAsk: 0.50 }), { feeBps: 30 })!;
    expect(op.roi).toBeCloseTo(op.net_profit_per_pair / op.combined_cost, 9);
  });

  it("total_profit / capital_required equals roi (both derive from per-pair values)", () => {
    const op = detectComplementSumArb(snap({ upBestAsk: 0.40, downBestAsk: 0.50 }), { feeBps: 30 })!;
    expect(op.total_profit_usd / op.capital_required_usd).toBeCloseTo(op.roi, 9);
  });

  it("passes through identity fields verbatim", () => {
    const op = detectComplementSumArb(
      snap({ conditionId: "0xABC123", title: "ETH 1h", asset: "ETH" }),
    )!;
    expect(op.conditionId).toBe("0xABC123");
    expect(op.title).toBe("ETH 1h");
    expect(op.asset).toBe("ETH");
  });
});

describe("detectComplementSumArb — symmetry & determinism", () => {
  it("is symmetric under swapping up/down asks and their depths", () => {
    const a = detectComplementSumArb(
      snap({ upBestAsk: 0.30, downBestAsk: 0.60, upDepthUsd: 80, downDepthUsd: 120 }),
      { feeBps: 25 },
    )!;
    const b = detectComplementSumArb(
      snap({ upBestAsk: 0.60, downBestAsk: 0.30, upDepthUsd: 120, downDepthUsd: 80 }),
      { feeBps: 25 },
    )!;
    expect(b.combined_cost).toBeCloseTo(a.combined_cost, 9);
    expect(b.net_profit_per_pair).toBeCloseTo(a.net_profit_per_pair, 9);
    expect(b.roi).toBeCloseTo(a.roi, 9);
    expect(b.max_pairs).toBe(a.max_pairs);
    expect(b.total_profit_usd).toBeCloseTo(a.total_profit_usd, 9);
  });

  it("is deterministic: identical inputs produce identical numeric outputs", () => {
    const input = snap({ upBestAsk: 0.41, downBestAsk: 0.52, upDepthUsd: 73, downDepthUsd: 64 });
    const r1 = detectComplementSumArb(input, { feeBps: 17 })!;
    const r2 = detectComplementSumArb(input, { feeBps: 17 })!;
    expect(r2.combined_cost).toBe(r1.combined_cost);
    expect(r2.net_profit_per_pair).toBe(r1.net_profit_per_pair);
    expect(r2.roi).toBe(r1.roi);
    expect(r2.max_pairs).toBe(r1.max_pairs);
    expect(r2.total_profit_usd).toBe(r1.total_profit_usd);
    expect(r2.reason).toBe(r1.reason);
  });

  it("does not mutate the input snapshot", () => {
    const input = snap({ upBestAsk: 0.41, downBestAsk: 0.52 });
    const before = JSON.stringify(input);
    detectComplementSumArb(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("detectComplementSumArb — seeded fuzz invariants", () => {
  it("over 400 deterministic random books, every returned op satisfies all core invariants", () => {
    const rnd = lcg(0xC0FFEE);
    let returned = 0;
    let nulls = 0;
    for (let i = 0; i < 400; i++) {
      // Construct asks in (0,1) with combined possibly above or below 1.
      const up = 0.05 + rnd() * 0.9; // (0.05, 0.95)
      const down = 0.05 + rnd() * 0.9;
      const upDepth = 1 + rnd() * 500;
      const downDepth = 1 + rnd() * 500;
      const feeBps = Math.floor(rnd() * 60); // 0..59 bps
      const minutes = 2 + rnd() * 600; // always >= minHold
      const market = snap({
        upBestAsk: up,
        downBestAsk: down,
        upDepthUsd: upDepth,
        downDepthUsd: downDepth,
        windowCloseMs: NOW + minutes * 60_000,
      });
      const op = detectComplementSumArb(market, { feeBps, minProfitPerPair: 0 });
      if (!op) {
        nulls++;
        continue;
      }
      returned++;
      // Core invariants that must ALWAYS hold for a returned opportunity.
      expect(op.combined_cost).toBeLessThan(1);
      expect(op.combined_cost).toBeCloseTo(up + down, 9);
      expect(op.gross_profit_per_pair).toBeCloseTo(1 - op.combined_cost, 9);
      expect(op.fee_adjustment).toBeCloseTo(feeBps / 10_000, 9);
      expect(op.net_profit_per_pair).toBeCloseTo(op.gross_profit_per_pair - op.fee_adjustment, 9);
      expect(op.net_profit_per_pair).toBeGreaterThanOrEqual(0); // minProfit floor was 0
      expect(op.roi).toBeCloseTo(op.net_profit_per_pair / op.combined_cost, 9);
      expect(Number.isInteger(op.max_pairs)).toBe(true);
      expect(op.max_pairs).toBeGreaterThanOrEqual(1);
      expect(op.capital_required_usd).toBeCloseTo(op.max_pairs * op.combined_cost, 6);
      expect(op.total_profit_usd).toBeCloseTo(op.max_pairs * op.net_profit_per_pair, 6);
      expect(op.time_to_resolve_min).toBeGreaterThanOrEqual(1.0);
    }
    // The fuzz space should exercise both branches (sanity on the harness).
    expect(returned).toBeGreaterThan(0);
    expect(nulls).toBeGreaterThan(0);
  });

  it("fuzz is reproducible: the same seed yields the same returned/null split", () => {
    function run(seed: number): { returned: number; nulls: number } {
      const rnd = lcg(seed);
      let returned = 0;
      let nulls = 0;
      for (let i = 0; i < 200; i++) {
        const up = 0.05 + rnd() * 0.9;
        const down = 0.05 + rnd() * 0.9;
        const op = detectComplementSumArb(
          snap({ upBestAsk: up, downBestAsk: down }),
          { minProfitPerPair: 0, feeBps: 10 },
        );
        if (op) returned++;
        else nulls++;
      }
      return { returned, nulls };
    }
    const a = run(42);
    const b = run(42);
    expect(b).toEqual(a);
  });
});

describe("detectComplementSumArb — option/typing sanity", () => {
  it("accepts a fully-specified ComplementArbOptions object", () => {
    const opts: ComplementArbOptions = {
      maxCombinedCost: 0.95,
      minProfitPerPair: 0.01,
      minHoldMinutes: 2,
      feeBps: 10,
    };
    const op: ComplementArbOpportunity | null = detectComplementSumArb(
      snap({ upBestAsk: 0.46, downBestAsk: 0.46, windowCloseMs: NOW + 10 * 60_000 }),
      opts,
    );
    expect(op).not.toBeNull();
    expect(op!.combined_cost).toBeCloseTo(0.92, 9);
  });

  it("custom minHoldMinutes can reject an otherwise-valid book", () => {
    // 5 minutes remaining but require 10.
    const op = detectComplementSumArb(
      snap({ windowCloseMs: NOW + 5 * 60_000 }),
      { minHoldMinutes: 10 },
    );
    expect(op).toBeNull();
  });
});
