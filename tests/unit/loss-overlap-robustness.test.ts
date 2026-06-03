/**
 * Robustness / invariant / edge-case tests for the loss-overlap score module.
 *
 * Complementary to tests/unit/portfolio-correlation.test.ts (which covers the
 * basic happy-path scenarios). These tests pin down the harder invariants:
 * bounds, symmetry/self-overlap, determinism, sparse-peer handling, non-finite
 * filtering, the strict `< 0` loss definition, duplicate-date collapsing, and
 * the windowing clip semantics.
 *
 * Pure functions only — no DB, no network, no files, no wall-clock. Any
 * pseudo-randomness comes from a small seeded LCG so the file is fully
 * deterministic.
 */
import { describe, expect, it } from "vitest";
import { lossOverlapScore, type LossOverlapInputs } from "@/lib/portfolio/loss-overlap";
import type { DailyPnlPoint } from "@/lib/portfolio/correlation";

// ─── Deterministic helpers ───────────────────────────────────────────────────

/** Small seeded LCG (Numerical Recipes constants). Fully deterministic. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000; // [0, 1)
  };
}

/** Build a YYYY-MM-DD date string for day index `i` within Jan 2026 padding. */
function day(i: number): string {
  // i is 0-based; produce 2026-01-01 .. 2026-02-.. by simple month rollover.
  const month = 1 + Math.floor(i / 28);
  const dom = 1 + (i % 28);
  return `2026-${String(month).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
}

/** Construct a series from an array of pnl values, dated day(0), day(1), ... */
function seriesFrom(pnls: number[], startIndex = 0): DailyPnlPoint[] {
  return pnls.map((pnl, i) => ({ date: day(startIndex + i), pnl }));
}

// ─── Bounds invariant (randomized but seeded) ────────────────────────────────

describe("lossOverlapScore — bounds invariant", () => {
  it("score and every per-peer overlap stay within [0, 1] across many seeded random portfolios", () => {
    const rand = makeLcg(0xC0FFEE);
    for (let trial = 0; trial < 60; trial++) {
      const nDays = 1 + Math.floor(rand() * 20);
      const nPeers = Math.floor(rand() * 5);
      const targetPnls = Array.from({ length: nDays }, () => rand() * 20 - 10);
      const others = Array.from({ length: nPeers }, (_, p) => ({
        capsuleId: `peer-${p}`,
        series: seriesFrom(Array.from({ length: nDays }, () => rand() * 20 - 10)),
      }));
      const result = lossOverlapScore({ targetSeries: seriesFrom(targetPnls), others });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      for (const peer of result.perPeer) {
        expect(peer.overlap).toBeGreaterThanOrEqual(0);
        expect(peer.overlap).toBeLessThanOrEqual(1);
        expect(peer.samples).toBeGreaterThanOrEqual(0);
        expect(peer.samples).toBeLessThanOrEqual(result.targetLossDays);
      }
    }
  });

  it("score never exceeds the maximum per-peer overlap and never undercuts the minimum (it is a mean)", () => {
    const rand = makeLcg(42);
    for (let trial = 0; trial < 40; trial++) {
      const nDays = 5 + Math.floor(rand() * 10);
      // Force the target to have loss days by making all target pnl negative.
      const targetPnls = Array.from({ length: nDays }, () => -(1 + rand() * 5));
      const others = Array.from({ length: 4 }, (_, p) => ({
        capsuleId: `peer-${p}`,
        // Fully overlapping dates so every peer is "observed" on loss days.
        series: seriesFrom(Array.from({ length: nDays }, () => rand() * 20 - 10)),
      }));
      const result = lossOverlapScore({ targetSeries: seriesFrom(targetPnls), others });
      const counted = result.perPeer.filter((p) => p.samples > 0).map((p) => p.overlap);
      if (counted.length > 0) {
        expect(result.score).toBeLessThanOrEqual(Math.max(...counted) + 1e-12);
        expect(result.score).toBeGreaterThanOrEqual(Math.min(...counted) - 1e-12);
      }
    }
  });
});

// ─── Self-overlap = 1, no-overlap = 0 ────────────────────────────────────────

describe("lossOverlapScore — self-overlap and no-overlap extremes", () => {
  it("self-overlap is exactly 1 (target measured against an identical-dated copy of itself)", () => {
    const targetPnls = [-1, 2, -3, 4, -5, -6];
    const target = seriesFrom(targetPnls);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "self", series: target.map((p) => ({ ...p })) }],
    });
    expect(result.score).toBe(1);
    expect(result.perPeer[0]!.overlap).toBe(1);
    // The copy is observed on every one of the target's loss days.
    expect(result.perPeer[0]!.samples).toBe(result.targetLossDays);
  });

  it("a peer that is the strict sign-inverse of the target has overlap exactly 0 on observed loss days", () => {
    const targetPnls = [-1, -2, -3, -4];
    const inverse = targetPnls.map((v) => -v); // strictly positive where target lost
    const result = lossOverlapScore({
      targetSeries: seriesFrom(targetPnls),
      others: [{ capsuleId: "inverse", series: seriesFrom(inverse) }],
    });
    expect(result.score).toBe(0);
    expect(result.perPeer[0]!.overlap).toBe(0);
    expect(result.perPeer[0]!.samples).toBe(4);
  });

  it("two peers, one self-copy (overlap 1) one inverse (overlap 0) → mean is exactly 0.5", () => {
    const targetPnls = [-1, -2, -3];
    const target = seriesFrom(targetPnls);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "self", series: target.map((p) => ({ ...p })) },
        { capsuleId: "inverse", series: seriesFrom(targetPnls.map((v) => -v)) },
      ],
    });
    expect(result.score).toBeCloseTo(0.5, 12);
  });
});

// ─── Loss definition is strictly `pnl < 0` ───────────────────────────────────

describe("lossOverlapScore — strict negative loss definition", () => {
  it("a target pnl of exactly 0 is NOT a loss day", () => {
    const result = lossOverlapScore({
      targetSeries: seriesFrom([0, 0, 0]),
      others: [{ capsuleId: "B", series: seriesFrom([-5, -5, -5]) }],
    });
    expect(result.targetLossDays).toBe(0);
    expect(result.score).toBe(0);
  });

  it("a peer pnl of exactly 0 on a target loss day does NOT count as a co-loss", () => {
    // Target loses on all 3 days; peer is exactly 0 each day (break-even, not a loss).
    const result = lossOverlapScore({
      targetSeries: seriesFrom([-1, -1, -1]),
      others: [{ capsuleId: "B", series: seriesFrom([0, 0, 0]) }],
    });
    // Peer is observed on all 3 loss days but never strictly negative → overlap 0.
    expect(result.perPeer[0]!.samples).toBe(3);
    expect(result.perPeer[0]!.overlap).toBe(0);
    expect(result.score).toBe(0);
  });

  it("only strictly-negative target days form the loss-day denominator", () => {
    // pnl: -1 (loss), 0 (not), +1 (not), -2 (loss) → 2 loss days.
    const result = lossOverlapScore({
      targetSeries: seriesFrom([-1, 0, 1, -2]),
      others: [{ capsuleId: "B", series: seriesFrom([-9, -9, -9, -9]) }],
    });
    expect(result.targetLossDays).toBe(2);
    // Peer lost on both loss days → overlap 1.
    expect(result.perPeer[0]!.overlap).toBe(1);
    expect(result.perPeer[0]!.samples).toBe(2);
  });
});

// ─── Non-finite filtering ────────────────────────────────────────────────────

describe("lossOverlapScore — non-finite values are filtered", () => {
  it("NaN / Infinity in the target are ignored when detecting loss days", () => {
    // Only the -1 is a finite loss; NaN/-Infinity are not finite → skipped.
    const target: DailyPnlPoint[] = [
      { date: day(0), pnl: Number.NaN },
      { date: day(1), pnl: Number.NEGATIVE_INFINITY },
      { date: day(2), pnl: -1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: seriesFrom([-5, -5, -5]) }],
    });
    expect(result.targetLossDays).toBe(1);
    expect(result.perPeer[0]!.overlap).toBe(1);
    expect(result.perPeer[0]!.samples).toBe(1);
  });

  it("a non-finite peer value on a target loss day makes that day unobserved for the peer", () => {
    const target = seriesFrom([-1, -1]);
    const peer: DailyPnlPoint[] = [
      { date: day(0), pnl: Number.NaN }, // not stored in peerMap → unobserved
      { date: day(1), pnl: -3 }, // observed co-loss
    ];
    const result = lossOverlapScore({ targetSeries: target, others: [{ capsuleId: "B", series: peer }] });
    // Only day(1) is observed for the peer, and it is a co-loss → overlap 1, samples 1.
    expect(result.perPeer[0]!.samples).toBe(1);
    expect(result.perPeer[0]!.overlap).toBe(1);
    expect(result.score).toBe(1);
  });

  it("a peer that is entirely non-finite contributes overlap 0 and is excluded from the mean", () => {
    const target = seriesFrom([-1, -1, -1]);
    const ghostPeer: DailyPnlPoint[] = target.map((p) => ({ date: p.date, pnl: Number.NaN }));
    const realPeer = seriesFrom([-2, -2, -2]);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "ghost", series: ghostPeer },
        { capsuleId: "real", series: realPeer },
      ],
    });
    const ghost = result.perPeer.find((p) => p.capsuleId === "ghost")!;
    expect(ghost.samples).toBe(0);
    expect(ghost.overlap).toBe(0);
    // Mean excludes the unobserved ghost peer, so the score is the real peer's 1.0.
    expect(result.score).toBe(1);
  });
});

// ─── Sparse / disjoint peers ─────────────────────────────────────────────────

describe("lossOverlapScore — sparse and disjoint peers", () => {
  it("a peer with NO overlapping dates contributes {overlap:0, samples:0} and is excluded from the mean", () => {
    const target = seriesFrom([-1, -1, -1], 0); // day(0..2)
    const disjointPeer = seriesFrom([-9, -9, -9], 50); // day(50..52), no overlap
    const coLoser = seriesFrom([-2, -2, -2], 0);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "disjoint", series: disjointPeer },
        { capsuleId: "coLoser", series: coLoser },
      ],
    });
    const disjoint = result.perPeer.find((p) => p.capsuleId === "disjoint")!;
    expect(disjoint.samples).toBe(0);
    expect(disjoint.overlap).toBe(0);
    // Only the coLoser is averaged → score 1.
    expect(result.score).toBe(1);
  });

  it("score is 0 (not NaN) when EVERY peer is disjoint from the target's loss days", () => {
    const target = seriesFrom([-1, -1], 0);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "p1", series: seriesFrom([-9, -9], 50) },
        { capsuleId: "p2", series: seriesFrom([-9, -9], 70) },
      ],
    });
    expect(result.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.targetLossDays).toBe(2);
  });

  it("partial peer overlap divides by observed loss days, not total loss days", () => {
    // Target loses on day0,1,2. Peer only has data on day0 (co-loss) and day1 (win).
    const target = seriesFrom([-1, -1, -1], 0);
    const peer: DailyPnlPoint[] = [
      { date: day(0), pnl: -5 }, // co-loss
      { date: day(1), pnl: +5 }, // observed, not a loss
    ];
    const result = lossOverlapScore({ targetSeries: target, others: [{ capsuleId: "B", series: peer }] });
    expect(result.targetLossDays).toBe(3);
    expect(result.perPeer[0]!.samples).toBe(2); // day0 + day1 observed
    expect(result.perPeer[0]!.overlap).toBeCloseTo(0.5, 12); // 1 co-loss / 2 observed
    expect(result.score).toBeCloseTo(0.5, 12);
  });
});

// ─── Empty inputs ────────────────────────────────────────────────────────────

describe("lossOverlapScore — empty / degenerate inputs", () => {
  it("empty target series → score 0, targetLossDays 0, targetSampleDays 0", () => {
    const result = lossOverlapScore({
      targetSeries: [],
      others: [{ capsuleId: "B", series: seriesFrom([-1, -1]) }],
    });
    expect(result.score).toBe(0);
    expect(result.targetLossDays).toBe(0);
    expect(result.targetSampleDays).toBe(0);
    // Early-return path still emits a per-peer stub for each peer.
    expect(result.perPeer).toHaveLength(1);
    expect(result.perPeer[0]!).toEqual({ capsuleId: "B", overlap: 0, samples: 0 });
  });

  it("empty others list → score 0, perPeer empty, but target loss accounting still computed", () => {
    const result = lossOverlapScore({ targetSeries: seriesFrom([-1, -2, 3]), others: [] });
    expect(result.score).toBe(0);
    expect(result.perPeer).toEqual([]);
    expect(result.targetLossDays).toBe(2);
    expect(result.targetSampleDays).toBe(3);
  });

  it("no-loss target with multiple peers returns a zero stub for each peer", () => {
    const result = lossOverlapScore({
      targetSeries: seriesFrom([1, 2, 3]),
      others: [
        { capsuleId: "X", series: seriesFrom([-1, -1, -1]) },
        { capsuleId: "Y", series: seriesFrom([-1, -1, -1]) },
      ],
    });
    expect(result.score).toBe(0);
    expect(result.targetLossDays).toBe(0);
    expect(result.perPeer.map((p) => p.capsuleId)).toEqual(["X", "Y"]);
    for (const peer of result.perPeer) {
      expect(peer).toEqual({ capsuleId: peer.capsuleId, overlap: 0, samples: 0 });
    }
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("lossOverlapScore — determinism", () => {
  it("identical inputs yield deeply-equal results across repeated calls", () => {
    const rand = makeLcg(7);
    const targetPnls = Array.from({ length: 15 }, () => rand() * 20 - 10);
    const others = Array.from({ length: 3 }, (_, p) => ({
      capsuleId: `peer-${p}`,
      series: seriesFrom(Array.from({ length: 15 }, () => rand() * 20 - 10)),
    }));
    const inputs: LossOverlapInputs = { targetSeries: seriesFrom(targetPnls), others };
    const r1 = lossOverlapScore(inputs);
    const r2 = lossOverlapScore(inputs);
    expect(r2).toEqual(r1);
  });

  it("does not mutate the caller's input series", () => {
    const target = seriesFrom([-1, 2, -3]);
    const targetSnapshot = JSON.parse(JSON.stringify(target));
    const peer = seriesFrom([-9, -9, -9]);
    const peerSnapshot = JSON.parse(JSON.stringify(peer));
    lossOverlapScore({ targetSeries: target, others: [{ capsuleId: "B", series: peer }] });
    expect(target).toEqual(targetSnapshot);
    expect(peer).toEqual(peerSnapshot);
  });

  it("per-peer ordering matches the input `others` ordering", () => {
    const target = seriesFrom([-1, -1]);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "zeta", series: seriesFrom([-1, -1]) },
        { capsuleId: "alpha", series: seriesFrom([1, 1]) },
        { capsuleId: "mid", series: seriesFrom([-1, 1]) },
      ],
    });
    expect(result.perPeer.map((p) => p.capsuleId)).toEqual(["zeta", "alpha", "mid"]);
  });
});

// ─── Windowing semantics ─────────────────────────────────────────────────────

describe("lossOverlapScore — windowDays clipping", () => {
  it("default window is 30 days (most recent 30 retained)", () => {
    // 40 days: first 10 are wins, last 30 are losses. Default window keeps the
    // last 30 → all losses.
    const pnls = Array.from({ length: 40 }, (_, i) => (i < 10 ? +1 : -1));
    const target = seriesFrom(pnls);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: target.map((p) => ({ ...p })) }],
    });
    expect(result.targetSampleDays).toBe(30);
    expect(result.targetLossDays).toBe(30);
    expect(result.score).toBe(1);
  });

  it("clips by date DESC, retaining the most recent window even when input is shuffled", () => {
    // Build 20 days where the EARLIEST 10 are losses and the LATEST 10 are wins.
    const ordered = Array.from({ length: 20 }, (_, i) => ({
      date: day(i),
      pnl: i < 10 ? -1 : +1,
    }));
    // Shuffle deterministically with the seeded LCG (Fisher-Yates).
    const rand = makeLcg(99);
    const shuffled = [...ordered];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const result = lossOverlapScore({
      targetSeries: shuffled,
      others: [{ capsuleId: "B", series: shuffled.map((p) => ({ ...p })) }],
      windowDays: 10,
    });
    // Most recent 10 days (day10..day19) are all wins → zero loss days.
    expect(result.targetSampleDays).toBe(10);
    expect(result.targetLossDays).toBe(0);
    expect(result.score).toBe(0);
  });

  it("windowDays >= series length keeps the entire series unchanged", () => {
    const target = seriesFrom([-1, 2, -3, 4]);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: seriesFrom([-1, -1, -1, -1]) }],
      windowDays: 1000,
    });
    expect(result.targetSampleDays).toBe(4);
    expect(result.targetLossDays).toBe(2);
  });

  it("windowDays=1 keeps only the most recent day", () => {
    // day0 loss, day1 win → most recent (day1) is a win.
    const target = seriesFrom([-1, +1]);
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: seriesFrom([-1, -1]) }],
      windowDays: 1,
    });
    expect(result.targetSampleDays).toBe(1);
    expect(result.targetLossDays).toBe(0);
    expect(result.score).toBe(0);
  });
});

// ─── Duplicate dates collapse ────────────────────────────────────────────────

describe("lossOverlapScore — duplicate dates", () => {
  it("duplicate loss-day dates in the target collapse (loss-day denominator is by distinct date)", () => {
    // Three rows but only two distinct dates; the duplicate loss day collapses.
    const target: DailyPnlPoint[] = [
      { date: day(0), pnl: -1 },
      { date: day(0), pnl: -1 }, // duplicate date
      { date: day(1), pnl: -1 },
    ];
    const result = lossOverlapScore({
      targetSeries: target,
      others: [{ capsuleId: "B", series: seriesFrom([-5, -5]) }],
    });
    expect(result.targetLossDays).toBe(2); // distinct dates, not 3 rows
  });
});

// ─── Monotonicity-style property ─────────────────────────────────────────────

describe("lossOverlapScore — monotonicity under added co-losing peer", () => {
  it("adding a peer that always co-loses cannot decrease the score below the prior mean of co-losers", () => {
    const target = seriesFrom([-1, -1, -1, -1]);
    // Baseline: one peer with 0.5 overlap (co-loses on half the days).
    const half = seriesFrom([-1, +1, -1, +1]);
    const baseline = lossOverlapScore({ targetSeries: target, others: [{ capsuleId: "half", series: half }] });
    expect(baseline.score).toBeCloseTo(0.5, 12);

    // Add a perfect co-loser (overlap 1). Mean of {0.5, 1} = 0.75 ≥ 0.5.
    const withCoLoser = lossOverlapScore({
      targetSeries: target,
      others: [
        { capsuleId: "half", series: half },
        { capsuleId: "perfect", series: seriesFrom([-2, -2, -2, -2]) },
      ],
    });
    expect(withCoLoser.score).toBeCloseTo(0.75, 12);
    expect(withCoLoser.score).toBeGreaterThan(baseline.score);
  });
});
