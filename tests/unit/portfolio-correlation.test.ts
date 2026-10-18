/**
 * Tests for the portfolio correlation math + loss-overlap modules.
 * Pure functions only — no DB, no fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  alignSeries,
  classifyVerdict,
  computePairStats,
  DEFAULT_THRESHOLDS,
  jaccard,
  jointLossFraction,
  pearson,
  type DailyPnlPoint,
} from "@/lib/portfolio/correlation";
import { lossOverlapScore } from "@/lib/portfolio/loss-overlap";

describe("pearson", () => {
  it("returns 1 for perfectly correlated series", () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
  });

  it("returns -1 for perfectly anti-correlated series", () => {
    expect(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it("returns ~0 for uncorrelated series", () => {
    // Symmetric pairing that nets to zero correlation
    const r = pearson([1, -1, 1, -1], [1, 1, -1, -1]);
    expect(r).not.toBeNull();
    expect(Math.abs(r!)).toBeLessThan(0.01);
  });

  it("returns null on length < 2", () => {
    expect(pearson([], [])).toBeNull();
    expect(pearson([1], [2])).toBeNull();
  });

  it("returns null on zero variance (all values equal)", () => {
    expect(pearson([3, 3, 3, 3], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("aligns by min length when lengths mismatch", () => {
    const r = pearson([1, 2, 3, 4, 5, 6], [2, 4, 6]);
    expect(r).toBeCloseTo(1, 6);
  });

  it("clamps result to [-1, 1] (defensive against FP error)", () => {
    const r = pearson([1, 2], [3, 4]);
    expect(r).not.toBeNull();
    expect(r!).toBeLessThanOrEqual(1);
    expect(r!).toBeGreaterThanOrEqual(-1);
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(["BTC", "ETH"], ["BTC", "ETH"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(["BTC"], ["ETH"])).toBe(0);
    expect(jaccard(["AAPL", "MSFT"], ["BTC", "ETH"])).toBe(0);
  });

  it("computes overlap for partial intersection", () => {
    // {BTC, ETH, SOL} ∩ {BTC, ETH, XRP} = {BTC, ETH} (size 2)
    // union = {BTC, ETH, SOL, XRP} (size 4)
    // jaccard = 2/4 = 0.5
    expect(jaccard(["BTC", "ETH", "SOL"], ["BTC", "ETH", "XRP"])).toBe(0.5);
  });

  it("returns 0 for empty inputs (no information)", () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard([], ["BTC"])).toBe(0);
  });

  it("accepts Set or array inputs interchangeably", () => {
    expect(jaccard(new Set(["A", "B"]), ["A", "B"])).toBe(1);
    expect(jaccard(["A", "B"], new Set(["B", "C"]))).toBe(1 / 3);
  });
});

describe("jointLossFraction", () => {
  it("returns 1 when both series always negative", () => {
    expect(jointLossFraction([-1, -2, -3], [-1, -1, -1])).toBe(1);
  });

  it("returns 0 when no joint losses", () => {
    expect(jointLossFraction([1, 2, 3], [-1, -1, -1])).toBe(0);
    expect(jointLossFraction([-1, -2, -3], [1, 2, 3])).toBe(0);
  });

  it("counts only joint-negative days", () => {
    // joint negatives at indices 1 and 2 (3 of 4) — wait, recompute:
    // [-1, +1, -1, +1] vs [-2, +1, -1, -1]
    // i=0: a<0, b<0 → joint ✓
    // i=1: a≥0    → not joint
    // i=2: a<0, b<0 → joint ✓
    // i=3: a≥0    → not joint
    // 2 / 4 = 0.5
    expect(jointLossFraction([-1, 1, -1, 1], [-2, 1, -1, -1])).toBe(0.5);
  });

  it("returns 0 on empty input", () => {
    expect(jointLossFraction([], [])).toBe(0);
  });

  it("aligns by min length", () => {
    expect(jointLossFraction([-1, -1, -1], [-1, -1])).toBe(1);
  });
});

describe("alignSeries", () => {
  it("inner-joins on shared dates", () => {
    const a: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: 1 },
      { date: "2026-05-26", pnl: 2 },
      { date: "2026-05-27", pnl: 3 },
    ];
    const b: DailyPnlPoint[] = [
      { date: "2026-05-26", pnl: 20 },
      { date: "2026-05-27", pnl: 30 },
      { date: "2026-05-28", pnl: 40 },
    ];
    const aligned = alignSeries(a, b);
    expect(aligned.dates).toEqual(["2026-05-26", "2026-05-27"]);
    expect(aligned.a).toEqual([2, 3]);
    expect(aligned.b).toEqual([20, 30]);
  });

  it("filters non-finite pnl values", () => {
    const a: DailyPnlPoint[] = [
      { date: "2026-05-26", pnl: Number.NaN },
      { date: "2026-05-27", pnl: 3 },
    ];
    const b: DailyPnlPoint[] = [
      { date: "2026-05-26", pnl: 1 },
      { date: "2026-05-27", pnl: 4 },
    ];
    const aligned = alignSeries(a, b);
    expect(aligned.dates).toEqual(["2026-05-27"]);
  });

  it("returns empty when no overlap", () => {
    const a: DailyPnlPoint[] = [{ date: "2026-05-01", pnl: 1 }];
    const b: DailyPnlPoint[] = [{ date: "2026-06-01", pnl: 1 }];
    const aligned = alignSeries(a, b);
    expect(aligned.dates).toEqual([]);
  });
});

describe("classifyVerdict", () => {
  it("returns 'too_similar' when BOTH thresholds exceeded", () => {
    expect(classifyVerdict(0.80, 0.85)).toBe("too_similar");
  });

  it("returns 'correlated_safe' when one threshold exceeded", () => {
    expect(classifyVerdict(0.80, 0.10)).toBe("correlated_safe");
    expect(classifyVerdict(0.10, 0.85)).toBe("correlated_safe");
  });

  it("returns 'diversified' when neither threshold exceeded", () => {
    expect(classifyVerdict(0.30, 0.10)).toBe("diversified");
    expect(classifyVerdict(0.0, 0.0)).toBe("diversified");
  });

  it("null pnl_corr falls back to asset-overlap-only check", () => {
    expect(classifyVerdict(null, 0.85)).toBe("correlated_safe");
    expect(classifyVerdict(null, 0.10)).toBe("diversified");
  });

  it("custom thresholds override defaults", () => {
    expect(classifyVerdict(0.50, 0.50, { pnlCorrTooSimilar: 0.4, assetOverlapTooSimilar: 0.4, minConfidentSamples: 7 })).toBe("too_similar");
  });
});

describe("computePairStats integration", () => {
  it("matches today's 3-live-capsules-same-family scenario as 'too_similar'", () => {
    // Synthetic: three days where both capsules lose together AND their daily
    // PnL covaries (correlated loss magnitudes). Values varied so neither
    // series has zero variance — required for Pearson to be computable.
    const seriesA: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -3 },
      { date: "2026-05-26", pnl: -5 },
      { date: "2026-05-27", pnl: -4 },
    ];
    const seriesB: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -2 },
      { date: "2026-05-26", pnl: -6 },
      { date: "2026-05-27", pnl: -4 },
    ];
    const stats = computePairStats({
      capsule_a: "A",
      capsule_b: "B",
      seriesA,
      seriesB,
      allowedAssetsA: ["BTC", "ETH"],
      allowedAssetsB: ["BTC", "ETH"],
      strategyFamilyA: "directional",
      strategyFamilyB: "directional",
    });
    expect(stats.pnl_corr).not.toBeNull();
    expect(stats.asset_overlap).toBe(1);
    expect(stats.strategy_family_match).toBe(1);
    expect(stats.loss_overlap).toBe(1);
    expect(stats.verdict).toBe("too_similar");
    expect(stats.sample_days).toBe(3);
    expect(stats.low_confidence).toBe(true); // <7 days
  });

  it("uncorrelated capsules with disjoint assets are 'diversified'", () => {
    const seriesA: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: 1 },
      { date: "2026-05-26", pnl: -1 },
      { date: "2026-05-27", pnl: 1 },
      { date: "2026-05-28", pnl: -1 },
    ];
    const seriesB: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: 1 },
      { date: "2026-05-26", pnl: 1 },
      { date: "2026-05-27", pnl: -1 },
      { date: "2026-05-28", pnl: -1 },
    ];
    const stats = computePairStats({
      capsule_a: "A",
      capsule_b: "B",
      seriesA,
      seriesB,
      allowedAssetsA: ["BTC"],
      allowedAssetsB: ["AAPL"],
      strategyFamilyA: "directional",
      strategyFamilyB: "mean_reversion",
    });
    expect(stats.asset_overlap).toBe(0);
    expect(stats.strategy_family_match).toBe(0);
    expect(stats.verdict).toBe("diversified");
  });

  it("marks low_confidence when sample_days < 7", () => {
    const seriesA: DailyPnlPoint[] = [{ date: "2026-05-27", pnl: 1 }];
    const seriesB: DailyPnlPoint[] = [{ date: "2026-05-27", pnl: 1 }];
    const stats = computePairStats({
      capsule_a: "A",
      capsule_b: "B",
      seriesA,
      seriesB,
      allowedAssetsA: [],
      allowedAssetsB: [],
      strategyFamilyA: null,
      strategyFamilyB: null,
    });
    expect(stats.low_confidence).toBe(true);
    expect(stats.sample_days).toBe(1);
  });

  it("computePairStats returns pnl_corr=null when no overlap", () => {
    const seriesA: DailyPnlPoint[] = [{ date: "2026-01-01", pnl: 1 }];
    const seriesB: DailyPnlPoint[] = [{ date: "2026-12-31", pnl: 1 }];
    const stats = computePairStats({
      capsule_a: "A",
      capsule_b: "B",
      seriesA,
      seriesB,
      allowedAssetsA: [],
      allowedAssetsB: [],
      strategyFamilyA: null,
      strategyFamilyB: null,
    });
    expect(stats.pnl_corr).toBeNull();
    expect(stats.sample_days).toBe(0);
  });
});

describe("lossOverlapScore", () => {
  it("returns 1.0 when target always loses with peers also always losing", () => {
    const target: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -1 },
      { date: "2026-05-26", pnl: -1 },
      { date: "2026-05-27", pnl: -1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "B", series: [
          { date: "2026-05-25", pnl: -2 },
          { date: "2026-05-26", pnl: -2 },
          { date: "2026-05-27", pnl: -2 },
        ]},
        { capsuleId: "C", series: [
          { date: "2026-05-25", pnl: -3 },
          { date: "2026-05-26", pnl: -3 },
          { date: "2026-05-27", pnl: -3 },
        ]},
      ],
    });
    expect(result.score).toBe(1);
    expect(result.targetLossDays).toBe(3);
    expect(result.perPeer).toHaveLength(2);
    expect(result.perPeer[0]!.overlap).toBe(1);
  });

  it("returns 0 when target loses but no peer ever loses with it", () => {
    const target: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -1 },
      { date: "2026-05-26", pnl: -1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "B", series: [
          { date: "2026-05-25", pnl: 5 },
          { date: "2026-05-26", pnl: 5 },
        ]},
      ],
    });
    expect(result.score).toBe(0);
    expect(result.perPeer[0]!.overlap).toBe(0);
  });

  it("returns 0 + targetLossDays=0 when target has no loss days", () => {
    const target: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: 1 },
      { date: "2026-05-26", pnl: 1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "B", series: [
          { date: "2026-05-25", pnl: -5 },
          { date: "2026-05-26", pnl: -5 },
        ]},
      ],
    });
    expect(result.score).toBe(0);
    expect(result.targetLossDays).toBe(0);
  });

  it("clips to windowDays = most recent N days", () => {
    const target: DailyPnlPoint[] = Array.from({ length: 60 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, "0")}`,
      pnl: i < 30 ? +1 : -1, // first 30 days positive, last 30 days negative
    }));
    // With windowDays=30, only the last 30 days (all losses) should count.
    const peer: DailyPnlPoint[] = target.map((p) => ({ ...p, pnl: p.pnl })); // same series
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: peer }],
      windowDays: 30,
    });
    expect(result.targetSampleDays).toBe(30);
    expect(result.targetLossDays).toBe(30);
    expect(result.score).toBe(1);
  });

  it("ignores days where peer has no observation (sparse peer)", () => {
    const target: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -1 },
      { date: "2026-05-26", pnl: -1 },
      { date: "2026-05-27", pnl: -1 },
    ];
    // Peer only has data for 2026-05-25 (lost). Overlap for that single
    // observed day = 1/1 = 1.0
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: [{ date: "2026-05-25", pnl: -2 }] }],
    });
    expect(result.score).toBe(1);
    expect(result.perPeer[0]!.samples).toBe(1);
  });

  it("averages across peers (one peer always co-loses, one peer never co-loses)", () => {
    const target: DailyPnlPoint[] = [
      { date: "2026-05-25", pnl: -1 },
      { date: "2026-05-26", pnl: -1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "co-loser", series: [
          { date: "2026-05-25", pnl: -2 },
          { date: "2026-05-26", pnl: -2 },
        ]},
        { capsuleId: "uncorrelated", series: [
          { date: "2026-05-25", pnl: 5 },
          { date: "2026-05-26", pnl: 5 },
        ]},
      ],
    });
    expect(result.score).toBeCloseTo(0.5, 6);
  });

  it("score is in [0, 1]", () => {
    const result = lossOverlapScore({
      targetSeries: [{ date: "2026-05-25", pnl: -1 }],
      others: [{ capsuleId: "B", series: [{ date: "2026-05-25", pnl: -1 }] }],
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
