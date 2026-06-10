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
  const mk = (copy: number[], bench: number[]) => walkForwardAnalysis(copy, bench, { windowSize: 5, step: 5, flatBand: 0.02, minWindows: 2 });

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
