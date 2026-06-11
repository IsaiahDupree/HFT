import { describe, it, expect } from "vitest";
import { classifyRegime, cumReturn, rollingWindows, walkForwardAnalysis } from "@/lib/exec/walk-forward-copy";

describe("classifyRegime", () => {
  it("tags up / down / flat by the benchmark's move", () => {
    expect(classifyRegime(0.10)).toBe("up");
    expect(classifyRegime(-0.10)).toBe("down");
    expect(classifyRegime(0.01)).toBe("flat");
  });
});

describe("cumReturn + rollingWindows", () => {
  it("compounds period returns", () => {
    expect(cumReturn([0.1, 0.1])).toBeCloseTo(0.21, 9);
    expect(cumReturn([])).toBe(0);
  });
  it("splits into overlapping windows of size, advancing by step", () => {
    const w = rollingWindows([0, 1, 2, 3, 4, 5, 6, 7], 4, 2);
    expect(w[0].items).toEqual([0, 1, 2, 3]);
    expect(w[1].items).toEqual([2, 3, 4, 5]);
    expect(w[w.length - 1].end).toBe(8);
  });
});

describe("walkForwardAnalysis — is the alpha regime-independent edge or a directional bet?", () => {
  // minEffWindows:2 isolates the REGIME logic from the power gate (power gate tested separately below)
  const mk = (copy: number[], bench: number[]) => walkForwardAnalysis(copy, bench, { windowSize: 5, step: 5, flatBand: 0.02, minWindows: 2, minEffWindows: 2 });

  it("THE SHORT-BIAS TRAP: alpha only in down windows, negative in up → 'directional bet'", () => {
    // window 1: market DOWN (bench −5%/period), copy flat → big positive alpha
    // window 2: market UP (bench +5%/period), copy flat → big NEGATIVE alpha
    const copy = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const bench = [-0.05, -0.05, -0.05, -0.05, -0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    const r = mk(copy, bench);
    expect(r.byRegime.down.meanAlpha).toBeGreaterThan(0);
    expect(r.byRegime.up.meanAlpha).toBeLessThan(0);
    expect(r.verdict).toBe("regime-dependent (directional bet)");
  });

  it("REAL EDGE: copy beats bench in BOTH regimes → 'regime-independent edge'", () => {
    // copy earns +1%/period more than bench in every window, up or down
    const bench = [-0.05, -0.05, -0.05, -0.05, -0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    const copy = bench.map((b) => b + 0.01);
    const r = mk(copy, bench);
    expect(r.byRegime.up.meanAlpha).toBeGreaterThan(0);
    expect(r.byRegime.down.meanAlpha).toBeGreaterThan(0);
    expect(r.verdict).toBe("regime-independent edge");
    expect(r.alphaConsistency).toBe(1);
  });

  it("NO EDGE: copy tracks bench → mean alpha ~0 → 'no edge'", () => {
    const bench = [0.01, -0.01, 0.02, -0.02, 0.0, 0.01, -0.01, 0.0, 0.01, -0.01];
    const r = mk([...bench], bench);
    expect(r.meanAlpha).toBeCloseTo(0, 6);
    expect(r.verdict).toBe("no edge");
  });

  it("too few windows → 'insufficient'", () => {
    const r = walkForwardAnalysis([0.01, 0.01], [0.0, 0.0], { windowSize: 2, step: 2, minWindows: 4 });
    expect(r.verdict).toBe("insufficient");
  });
});

describe("walkForwardAnalysis — honest power gating (the fix the verification workflow demanded)", () => {
  it("UNDERPOWERED (effective N below threshold) → 'insufficient', never a confident verdict", () => {
    // 12 overlapping windows but 50% overlap → effectiveN ≈ 6; demand 8 → insufficient
    const copy = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.01 : -0.005));
    const bench = Array.from({ length: 40 }, () => 0);
    const r = walkForwardAnalysis(copy, bench, { windowSize: 14, step: 7, minWindows: 4, minEffWindows: 8 });
    expect(r.effectiveN).toBeCloseTo(r.nWindows * 0.5, 6);
    expect(r.verdict).toBe("insufficient");
  });
  it("a positive but NOT-significant mean alpha (t < min) is 'no edge', not 'edge'", () => {
    // flat market (bench 0); copy alternates big + / big − windows → mean alpha barely positive, huge variance
    const blocks = [0.0192, -0.0194, 0.0192, -0.0194, 0.0192, -0.0192];
    const copy = blocks.flatMap((v) => Array(5).fill(v));
    const bench = Array(30).fill(0);
    const r = walkForwardAnalysis(copy, bench, { windowSize: 5, step: 5, minWindows: 4, minEffWindows: 2, minTStat: 2 });
    expect(r.meanAlpha).toBeGreaterThan(0);            // barely positive
    expect(Math.abs(r.tStat)).toBeLessThan(2);         // but not significant
    expect(r.verdict).toBe("no edge");                 // ⇒ NOT an edge
  });
  it("EXOGENOUS regime tag (BTC) decouples the label from the benchmark numerator", () => {
    // copy/bench are flat; regime is driven by an external BTC series that is clearly up then down
    const copy = Array(20).fill(0.001), bench = Array(20).fill(0.001);
    const btc = [...Array(10).fill(0.03), ...Array(10).fill(-0.03)]; // first half up, second half down
    const r = walkForwardAnalysis(copy, bench, { windowSize: 10, step: 10, minWindows: 2, minEffWindows: 2, regimeReturns: btc });
    const regimes = r.windows.map((w) => w.regime);
    expect(regimes[0]).toBe("up");   // tagged by BTC, not by the flat benchmark
    expect(regimes[1]).toBe("down");
  });
  it("effectiveN halves with 50% overlap vs full with non-overlap", () => {
    const x = Array.from({ length: 50 }, () => 0.001);
    const overlap = walkForwardAnalysis(x, x, { windowSize: 14, step: 7 });
    const noOverlap = walkForwardAnalysis(x, x, { windowSize: 14, step: 14 });
    expect(overlap.effectiveN).toBeCloseTo(overlap.nWindows * 0.5, 6);
    expect(noOverlap.effectiveN).toBeCloseTo(noOverlap.nWindows, 6);
  });
});
