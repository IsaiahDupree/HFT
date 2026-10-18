/**
 * Tests for the pure calibration math (Phase 13).
 *
 * Covers:
 *   - Empty input → all-empty buckets, weighted_error = 0
 *   - Perfect calibration → weighted_error = 0
 *   - Over-confident: 0.95-bucket decisions win 50% → high error
 *   - Under-confident: 0.55-bucket decisions win 90% → high error
 *   - Bucket-edge handling (score = 1.0 → last bucket; score = 0 → first)
 *   - has_problem_bucket threshold
 *   - bucketVerdict classification
 *   - Invalid bin widths throw
 */
import { describe, expect, it } from "vitest";
import {
  bucketVerdict,
  buildCalibrationReport,
  type LabeledDecision,
} from "@/lib/decision/calibration";

function mk(score: number, won: boolean, over: Partial<LabeledDecision> = {}): LabeledDecision {
  return {
    id: Math.floor(Math.random() * 1e9),
    approval_score: score,
    decision: won ? "APPROVED_FULL" : "APPROVED_REDUCED",
    won,
    ...over,
  };
}

describe("buildCalibrationReport", () => {
  it("returns empty buckets and zero error on no input", () => {
    const r = buildCalibrationReport([]);
    expect(r.buckets).toHaveLength(10);
    expect(r.total_labeled).toBe(0);
    expect(r.weighted_calibration_error).toBe(0);
    expect(r.has_problem_bucket).toBe(false);
  });

  it("perfect calibration: 0.95-bucket wins 100%, 0.05-bucket wins 0%", () => {
    const decisions: LabeledDecision[] = [];
    // 50 decisions in [0.9, 1.0] bucket, all winning (midpoint 0.95)
    for (let i = 0; i < 50; i++) decisions.push(mk(0.95, true));
    // 50 in [0, 0.1] bucket, none winning (midpoint 0.05)
    for (let i = 0; i < 50; i++) decisions.push(mk(0.05, false));

    const r = buildCalibrationReport(decisions);
    expect(r.total_labeled).toBe(100);
    // Both populated buckets should have small calibration error (≤ 0.05)
    const populated = r.buckets.filter((b) => b.n > 0);
    expect(populated).toHaveLength(2);
    for (const b of populated) {
      expect(b.calibration_error!).toBeLessThanOrEqual(0.05);
    }
  });

  it("over-confident: 0.95-bucket decisions win 50% → error ~0.45, problem bucket flag set", () => {
    const decisions: LabeledDecision[] = [];
    for (let i = 0; i < 20; i++) decisions.push(mk(0.95, i % 2 === 0));
    const r = buildCalibrationReport(decisions);
    const lastBucket = r.buckets[r.buckets.length - 1]!;
    expect(lastBucket.n).toBe(20);
    expect(lastBucket.actual_win_rate).toBeCloseTo(0.5, 2);
    expect(lastBucket.calibration_error).toBeCloseTo(0.45, 2);
    expect(r.has_problem_bucket).toBe(true);
  });

  it("under-confident: 0.55-bucket decisions win 90% → high error", () => {
    const decisions: LabeledDecision[] = [];
    for (let i = 0; i < 10; i++) decisions.push(mk(0.55, true));
    for (let i = 0; i < 1; i++) decisions.push(mk(0.55, false));
    const r = buildCalibrationReport(decisions);
    const bucket55 = r.buckets.find((b) => b.lo === 0.5 && b.hi === 0.6)!;
    expect(bucket55.n).toBe(11);
    expect(bucket55.actual_win_rate).toBeCloseTo(10 / 11, 3);
    expect(bucket55.calibration_error).toBeGreaterThan(0.30);
    expect(r.has_problem_bucket).toBe(true);
  });

  it("score = 1.0 belongs to the last bucket (inclusive top edge)", () => {
    const r = buildCalibrationReport([mk(1.0, true)]);
    const last = r.buckets[r.buckets.length - 1]!;
    expect(last.n).toBe(1);
  });

  it("score = 0 belongs to the first bucket", () => {
    const r = buildCalibrationReport([mk(0, false)]);
    expect(r.buckets[0]!.n).toBe(1);
  });

  it("filters out non-finite + out-of-range scores", () => {
    const r = buildCalibrationReport([
      mk(0.95, true),
      mk(NaN, true),
      mk(1.5, false),
      mk(-0.1, true),
    ]);
    expect(r.total_labeled).toBe(1);
  });

  it("respects custom binWidth", () => {
    const r = buildCalibrationReport([mk(0.5, true)], { binWidth: 0.5 });
    expect(r.buckets).toHaveLength(2);
    // [0, 0.5) and [0.5, 1.0]
    expect(r.buckets[1]!.n).toBe(1);
  });

  it("rejects invalid binWidth", () => {
    expect(() => buildCalibrationReport([], { binWidth: 0 })).toThrow();
    expect(() => buildCalibrationReport([], { binWidth: 1.5 })).toThrow();
    expect(() => buildCalibrationReport([], { binWidth: -0.1 })).toThrow();
  });

  it("weighted_calibration_error weights buckets by their share of total", () => {
    // 100 decisions: 90 in well-calibrated bucket (0.05 error), 10 in bad bucket (0.45 error)
    const decisions: LabeledDecision[] = [];
    for (let i = 0; i < 90; i++) decisions.push(mk(0.05, false)); // perfect
    for (let i = 0; i < 5; i++) decisions.push(mk(0.95, true));
    for (let i = 0; i < 5; i++) decisions.push(mk(0.95, false));   // 50% in 0.95 bucket
    const r = buildCalibrationReport(decisions);
    // Expected weighted error: (90/100) × ~0.05 + (10/100) × 0.45 = 0.045 + 0.045 = 0.09
    expect(r.weighted_calibration_error).toBeCloseTo(0.09, 2);
  });
});

describe("bucketVerdict", () => {
  function mkBucket(n: number, wins: number, midpoint: number) {
    return {
      lo: midpoint - 0.05,
      hi: midpoint + 0.05,
      midpoint,
      n,
      wins,
      actual_win_rate: n === 0 ? null : wins / n,
      calibration_error: n === 0 ? null : Math.abs(wins / n - midpoint),
    };
  }

  it("insufficient_data when n < minN", () => {
    expect(bucketVerdict(mkBucket(2, 2, 0.95))).toBe("insufficient_data");
  });

  it("well_calibrated when error within threshold", () => {
    expect(bucketVerdict(mkBucket(10, 9, 0.95))).toBe("well_calibrated");
  });

  it("over_confident when actual_win_rate < midpoint - threshold", () => {
    expect(bucketVerdict(mkBucket(20, 6, 0.95))).toBe("over_confident");
  });

  it("under_confident when actual_win_rate > midpoint + threshold", () => {
    expect(bucketVerdict(mkBucket(20, 18, 0.55))).toBe("under_confident");
  });

  it("custom threshold tightens / loosens the band", () => {
    const b = mkBucket(20, 18, 0.85); // actual 0.9, midpoint 0.85, diff +0.05
    expect(bucketVerdict(b, { threshold: 0.10 })).toBe("well_calibrated");
    expect(bucketVerdict(b, { threshold: 0.02 })).toBe("under_confident");
  });
});
