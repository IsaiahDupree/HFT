import { describe, it, expect } from "vitest";
import { basisBps, referenceSignal, consensusReference, isStaleByAge, ewma } from "@/lib/data/reference-price";

describe("basisBps", () => {
  it("is the signed follower-vs-leader basis in bps", () => {
    expect(basisBps(100, 101)).toBeCloseTo(100, 6);   // follower 1% rich → +100bps
    expect(basisBps(100, 99.5)).toBeCloseTo(-50, 6);  // 0.5% cheap → −50bps
    expect(basisBps(100, 100)).toBe(0);
  });
  it("is 0 on a non-positive leader price", () => {
    expect(basisBps(0, 100)).toBe(0);
  });
});

describe("referenceSignal — leader leads, follower converges", () => {
  it("aligned inside the band → not actionable", () => {
    const s = referenceSignal(100, 100.03, { alignBps: 5 }); // +3bps
    expect(s.state).toBe("aligned");
    expect(s.actionable).toBe(false);
    expect(s.expectedFollowerMove).toBe("none");
  });
  it("follower RICH (above leader) → expected to move DOWN, actionable", () => {
    const s = referenceSignal(100, 100.3, { alignBps: 5, staleBps: 100 }); // +30bps
    expect(s.state).toBe("follower_rich");
    expect(s.expectedFollowerMove).toBe("down");
    expect(s.actionable).toBe(true);
  });
  it("follower CHEAP (below leader) → expected to move UP, actionable", () => {
    const s = referenceSignal(100, 99.7, { alignBps: 5 }); // −30bps
    expect(s.state).toBe("follower_cheap");
    expect(s.expectedFollowerMove).toBe("up");
    expect(s.actionable).toBe(true);
  });
  it("a PERSISTENT structural basis at the baseline is NOT actionable (the USDT/USD basis fix)", () => {
    // follower sits ~13bps cheap, but that IS its normal level → deviation 0 → aligned
    const s = referenceSignal(100, 99.87, { alignBps: 5, baselineBps: -13 });
    expect(s.state).toBe("aligned");
    expect(s.actionable).toBe(false);
  });
  it("flags a DEVIATION away from the baseline as actionable", () => {
    // normal basis −13bps; now −30bps → 17bps cheaper than usual → expect convergence UP
    const s = referenceSignal(100, 99.70, { alignBps: 5, baselineBps: -13 });
    expect(s.state).toBe("follower_cheap");
    expect(s.expectedFollowerMove).toBe("up");
    expect(s.actionable).toBe(true);
  });

  it("a HUGE divergence is treated as a STALE feed, NOT a tradeable mispricing", () => {
    const s = referenceSignal(100, 113, { staleBps: 100 }); // +1300bps → stale
    expect(s.state).toBe("stale");
    expect(s.actionable).toBe(false);
  });
  it("a non-finite follower price → stale, not actionable", () => {
    expect(referenceSignal(100, NaN).state).toBe("stale");
    expect(referenceSignal(100, NaN).actionable).toBe(false);
  });
  it("is symmetric in magnitude (rich +b mirrors cheap −b)", () => {
    const rich = referenceSignal(100, 100.4), cheap = referenceSignal(100, 99.6);
    expect(rich.basisBps).toBeCloseTo(-cheap.basisBps, 4);
    expect(rich.expectedFollowerMove).toBe("down");
    expect(cheap.expectedFollowerMove).toBe("up");
  });
});

describe("consensusReference — trust the leader when they disagree", () => {
  it("means the two when aligned within tolerance", () => {
    const r = consensusReference(100, 100.1, { maxDivBps: 25 });
    expect(r.source).toBe("mean");
    expect(r.price).toBeCloseTo(100.05, 9);
  });
  it("takes the LEADER price when they diverge past tolerance", () => {
    const r = consensusReference(100, 101, { maxDivBps: 25 }); // +100bps > 25
    expect(r.source).toBe("leader");
    expect(r.price).toBe(100);
  });
});

describe("ewma — rolling basis baseline", () => {
  it("seeds with the first value, then tracks toward new values", () => {
    expect(ewma(NaN, -13, 0.1)).toBe(-13);
    expect(ewma(-13, -13, 0.1)).toBeCloseTo(-13, 9);          // stable at the level
    expect(ewma(-13, -23, 0.1)).toBeCloseTo(-14, 9);          // moves 10% toward -23
  });
  it("converges to a constant input over many steps", () => {
    let m = NaN;
    for (let i = 0; i < 500; i++) m = ewma(m, -8, 0.05);
    expect(m).toBeCloseTo(-8, 6);
  });
});

describe("isStaleByAge", () => {
  it("flags a print older than maxAge", () => {
    expect(isStaleByAge(1000, 5000, 3000)).toBe(true);
    expect(isStaleByAge(1000, 2000, 3000)).toBe(false);
    expect(isStaleByAge(NaN, 2000, 3000)).toBe(true);
  });
});
