import { describe, it, expect } from "vitest";
import { alignVenueCloses, crossVenueAgreement, flagDivergentBars, consolidatedCloses } from "@/lib/data/cross-venue";
import type { VenueCandle } from "@/lib/data/venue-candles";

// ---------------------------------------------------------------------------
// Deterministic helpers. No Math.random / no wall-clock — everything seeded.
// ---------------------------------------------------------------------------

/** A bar with all OHLC pinned to `close` (mirrors the sibling test helper). */
const c = (start_unix: number, close: number): VenueCandle => ({
  start_unix,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** Seeded LCG (numerical recipes constants) → reproducible pseudo-randomness. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

/** Pull a float in [lo, hi) from a generator. */
const rng = (gen: () => number, lo: number, hi: number) => lo + (hi - lo) * gen();

/** The exact divergence formula the module uses (re-stated to assert against). */
const expectedBps = (a: number, b: number) => {
  const mid = (a + b) / 2;
  return mid > 0 ? (Math.abs(a - b) / mid) * 1e4 : 0;
};

/** Build a contiguous series of bars with the given closes starting at t=10 step 10. */
const series = (closes: number[], t0 = 10, step = 10): VenueCandle[] =>
  closes.map((cl, i) => c(t0 + i * step, cl));

// ===========================================================================
describe("alignVenueCloses — properties", () => {
  it("output start_unix is always sorted ascending regardless of input order", () => {
    const a = [c(30, 300), c(10, 100), c(20, 200), c(40, 400)];
    const b = [c(20, 200), c(40, 400), c(10, 100), c(30, 300)];
    const out = alignVenueCloses(a, b);
    const ts = out.map((x) => x.start_unix);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
  });

  it("only keeps timestamps present on BOTH venues (inner join)", () => {
    const a = series([100, 200, 300, 400]); // t = 10,20,30,40
    const b = [c(20, 200), c(40, 400), c(99, 1)];
    const out = alignVenueCloses(a, b);
    expect(out.map((x) => x.start_unix)).toEqual([20, 40]);
  });

  it("carries a's close into field a and b's close into field b", () => {
    const out = alignVenueCloses([c(10, 111)], [c(10, 222)]);
    expect(out[0].a).toBe(111);
    expect(out[0].b).toBe(222);
  });

  it("per-bar bps matches the module's mid-based formula exactly", () => {
    const out = alignVenueCloses([c(10, 200)], [c(10, 201)]);
    expect(out[0].bps).toBeCloseTo(expectedBps(200, 201), 9);
  });

  it("bps is exactly 0 when the two closes are identical", () => {
    const out = alignVenueCloses([c(10, 123.45)], [c(10, 123.45)]);
    expect(out[0].bps).toBe(0);
  });

  it("returns [] when there is no overlapping timestamp", () => {
    expect(alignVenueCloses([c(10, 1)], [c(20, 2)])).toEqual([]);
  });

  it("returns [] when either side is empty", () => {
    expect(alignVenueCloses([], [c(10, 1)])).toEqual([]);
    expect(alignVenueCloses([c(10, 1)], [])).toEqual([]);
  });

  it("overlap count equals the number of shared timestamps over many seeded runs", () => {
    const gen = lcg(42);
    for (let trial = 0; trial < 20; trial++) {
      const aTs = new Set<number>();
      const bTs = new Set<number>();
      const a: VenueCandle[] = [];
      const b: VenueCandle[] = [];
      for (let i = 0; i < 12; i++) {
        const t = Math.floor(rng(gen, 0, 30)) * 10;
        if (!aTs.has(t)) { aTs.add(t); a.push(c(t, rng(gen, 50, 150))); }
        const t2 = Math.floor(rng(gen, 0, 30)) * 10;
        if (!bTs.has(t2)) { bTs.add(t2); b.push(c(t2, rng(gen, 50, 150))); }
      }
      const shared = [...aTs].filter((t) => bTs.has(t)).length;
      expect(alignVenueCloses(a, b)).toHaveLength(shared);
    }
  });

  it("divergence (bps) is symmetric: align(a,b)[i].bps === align(b,a)[i].bps", () => {
    const gen = lcg(7);
    for (let i = 0; i < 30; i++) {
      const t = 10 * i;
      const x = rng(gen, 10, 500);
      const y = rng(gen, 10, 500);
      const fwd = alignVenueCloses([c(t, x)], [c(t, y)])[0].bps;
      const rev = alignVenueCloses([c(t, y)], [c(t, x)])[0].bps;
      expect(fwd).toBeCloseTo(rev, 9);
    }
  });

  it("swapping a and b swaps the a/b fields but leaves bps unchanged", () => {
    const fwd = alignVenueCloses([c(10, 80)], [c(10, 120)])[0];
    const rev = alignVenueCloses([c(10, 120)], [c(10, 80)])[0];
    expect(rev.a).toBe(fwd.b);
    expect(rev.b).toBe(fwd.a);
    expect(rev.bps).toBeCloseTo(fwd.bps, 9);
  });

  it("bps grows monotonically as venue b drifts further from a", () => {
    const gaps = [100, 101, 105, 120, 200];
    const bpsList = gaps.map((g) => alignVenueCloses([c(10, 100)], [c(10, g)])[0].bps);
    for (let i = 1; i < bpsList.length; i++) expect(bpsList[i]).toBeGreaterThan(bpsList[i - 1]);
  });

  it("does not mutate its inputs", () => {
    const a = [c(30, 3), c(10, 1)];
    const b = [c(10, 1), c(30, 3)];
    const aCopy = JSON.parse(JSON.stringify(a));
    const bCopy = JSON.parse(JSON.stringify(b));
    alignVenueCloses(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });

  it("every output bps is finite and non-negative for positive closes", () => {
    const gen = lcg(99);
    const a: VenueCandle[] = [];
    const b: VenueCandle[] = [];
    for (let i = 0; i < 25; i++) {
      const t = 10 * i;
      a.push(c(t, rng(gen, 1, 1000)));
      b.push(c(t, rng(gen, 1, 1000)));
    }
    for (const bar of alignVenueCloses(a, b)) {
      expect(Number.isFinite(bar.bps)).toBe(true);
      expect(bar.bps).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
describe("crossVenueAgreement — properties", () => {
  it("overlap count is symmetric: overlap(a,b) === overlap(b,a)", () => {
    const gen = lcg(123);
    for (let trial = 0; trial < 15; trial++) {
      const a: VenueCandle[] = [];
      const b: VenueCandle[] = [];
      const used = new Set<number>();
      for (let i = 0; i < 10; i++) {
        const t = Math.floor(rng(gen, 0, 20)) * 10;
        if (!used.has(100 + t)) { used.add(100 + t); a.push(c(t, rng(gen, 50, 150))); }
        const t2 = Math.floor(rng(gen, 0, 20)) * 10;
        if (!used.has(200 + t2)) { used.add(200 + t2); b.push(c(t2, rng(gen, 50, 150))); }
      }
      expect(crossVenueAgreement(a, b).overlap).toBe(crossVenueAgreement(b, a).overlap);
    }
  });

  it("onlyA and onlyB swap when a and b swap", () => {
    const a = series([100, 200, 300, 400]); // t 10..40
    const b = [c(10, 100), c(50, 500)];
    const fwd = crossVenueAgreement(a, b);
    const rev = crossVenueAgreement(b, a);
    expect(fwd.onlyA).toBe(rev.onlyB);
    expect(fwd.onlyB).toBe(rev.onlyA);
  });

  it("onlyA + onlyB + overlap = number of distinct timestamps across both venues", () => {
    const a = series([1, 2, 3, 4, 5]); // 10..50
    const b = [c(30, 3), c(40, 4), c(50, 5), c(60, 6), c(70, 7)];
    const rep = crossVenueAgreement(a, b);
    const distinct = new Set([...a, ...b].map((x) => x.start_unix)).size;
    expect(rep.overlap + rep.onlyA + rep.onlyB).toBe(distinct);
  });

  it("verdict is 'agree' when every overlapping bar is identical", () => {
    const a = series([100, 200, 300]);
    const b = series([100, 200, 300]);
    const rep = crossVenueAgreement(a, b);
    expect(rep.verdict).toBe("agree");
    expect(rep.medianBps).toBe(0);
    expect(rep.maxBps).toBe(0);
    expect(rep.divergent).toHaveLength(0);
  });

  it("verdict ordering: identical → 'agree', steady mid-drift → 'minor_drift', one outlier → 'suspect'", () => {
    const base = series([100, 100, 100, 100, 100]);
    const agreeB = series([100, 100, 100, 100, 100]);
    // ~35 bps everywhere (over driftCeil 30, under maxBps 50)
    const driftB = base.map((x) => c(x.start_unix, x.close * 1.0035));
    // one bar blown 20% out → suspect
    const suspectB = series([100, 100, 360, 100, 100]);
    expect(crossVenueAgreement(base, agreeB, { maxBps: 50, driftCeilBps: 30 }).verdict).toBe("agree");
    expect(crossVenueAgreement(base, driftB, { maxBps: 50, driftCeilBps: 30 }).verdict).toBe("minor_drift");
    expect(crossVenueAgreement(base, suspectB, { maxBps: 50, driftCeilBps: 30 }).verdict).toBe("suspect");
  });

  it("suspect takes precedence over minor_drift even when p95 is over the ceiling", () => {
    // most bars drift ~35bps AND one bar is a hard outlier → still 'suspect'
    const a = series([100, 100, 100, 100]);
    const b = [c(10, 100.35), c(20, 100.35), c(30, 100.35), c(40, 999)];
    const rep = crossVenueAgreement(a, b, { maxBps: 50, driftCeilBps: 30 });
    expect(rep.verdict).toBe("suspect");
    expect(rep.divergent.length).toBeGreaterThan(0);
  });

  it("as a single bar's divergence increases, the verdict only ever worsens (agree → minor_drift → suspect)", () => {
    const rank = { agree: 0, minor_drift: 1, suspect: 2 } as const;
    const a = series([100, 100, 100]);
    let prev = -1;
    for (const mult of [1.0, 1.0035, 1.004, 1.006, 1.05, 1.5]) {
      const b = [c(10, 100), c(20, 100), c(30, 100 * mult)];
      const v = crossVenueAgreement(a, b, { maxBps: 50, driftCeilBps: 30 }).verdict;
      expect(rank[v]).toBeGreaterThanOrEqual(prev);
      prev = rank[v];
    }
    expect(prev).toBe(rank.suspect); // ended in the worst state
  });

  it("medianBps <= p95Bps <= maxBps always (quantile ordering)", () => {
    const gen = lcg(555);
    for (let trial = 0; trial < 20; trial++) {
      const a: VenueCandle[] = [];
      const b: VenueCandle[] = [];
      for (let i = 0; i < 15; i++) {
        const t = 10 * i;
        a.push(c(t, 100));
        b.push(c(t, rng(gen, 95, 130)));
      }
      const rep = crossVenueAgreement(a, b);
      expect(rep.medianBps).toBeLessThanOrEqual(rep.p95Bps + 1e-9);
      expect(rep.p95Bps).toBeLessThanOrEqual(rep.maxBps + 1e-9);
    }
  });

  it("maxBps equals the largest per-bar divergence in the overlap", () => {
    const a = series([100, 100, 100]);
    const b = series([100, 110, 105]);
    const rep = crossVenueAgreement(a, b, { maxBps: 1e9 }); // never flag, just measure
    const worst = Math.max(expectedBps(100, 100), expectedBps(100, 110), expectedBps(100, 105));
    expect(rep.maxBps).toBeCloseTo(worst, 6);
  });

  it("divergent is sorted worst-bps-first (descending)", () => {
    const a = series([100, 100, 100, 100]);
    const b = series([100, 200, 150, 400]); // varying degrees of blow-out
    const rep = crossVenueAgreement(a, b, { maxBps: 50 });
    const bpsSeq = rep.divergent.map((x) => x.bps);
    for (let i = 1; i < bpsSeq.length; i++) expect(bpsSeq[i]).toBeLessThanOrEqual(bpsSeq[i - 1]);
  });

  it("every divergent bar exceeds maxBps and every non-divergent overlap bar does not", () => {
    const a = series([100, 100, 100, 100, 100]);
    const b = series([100, 101, 200, 100.2, 300]);
    const maxBps = 50;
    const rep = crossVenueAgreement(a, b, { maxBps });
    const divTs = new Set(rep.divergent.map((x) => x.start_unix));
    for (const bar of rep.divergent) expect(bar.bps).toBeGreaterThan(maxBps);
    for (const bar of alignVenueCloses(a, b)) {
      if (!divTs.has(bar.start_unix)) expect(bar.bps).toBeLessThanOrEqual(maxBps);
    }
  });

  it("divergent count never exceeds overlap", () => {
    const gen = lcg(2024);
    const a: VenueCandle[] = [];
    const b: VenueCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const t = 10 * i;
      a.push(c(t, 100));
      b.push(c(t, rng(gen, 50, 400)));
    }
    const rep = crossVenueAgreement(a, b, { maxBps: 50 });
    expect(rep.divergent.length).toBeLessThanOrEqual(rep.overlap);
  });

  it("a higher maxBps tolerance never produces MORE divergent bars (monotone in tolerance)", () => {
    const a = series([100, 100, 100, 100, 100]);
    const b = series([100, 110, 130, 160, 250]);
    const counts = [10, 50, 200, 1000, 5000].map(
      (m) => crossVenueAgreement(a, b, { maxBps: m }).divergent.length,
    );
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  });

  it("empty overlap → all-zero stats and verdict 'agree' (nothing to contradict)", () => {
    const rep = crossVenueAgreement([c(10, 100)], [c(20, 200)]);
    expect(rep.overlap).toBe(0);
    expect(rep.medianBps).toBe(0);
    expect(rep.p95Bps).toBe(0);
    expect(rep.maxBps).toBe(0);
    expect(rep.divergent).toEqual([]);
    expect(rep.verdict).toBe("agree");
  });

  it("both venues empty → fully-zero report, verdict 'agree'", () => {
    const rep = crossVenueAgreement([], []);
    expect(rep).toMatchObject({ overlap: 0, onlyA: 0, onlyB: 0, medianBps: 0, p95Bps: 0, maxBps: 0, verdict: "agree" });
    expect(rep.divergent).toEqual([]);
  });

  it("driftCeilBps is the agree/minor_drift boundary when no bar breaches maxBps", () => {
    const a = series([100, 100, 100, 100]);
    const b = a.map((x) => c(x.start_unix, x.close * 1.004)); // ~40 bps, under maxBps 50
    // ceiling above the drift → agree; ceiling below → minor_drift
    expect(crossVenueAgreement(a, b, { maxBps: 50, driftCeilBps: 100 }).verdict).toBe("agree");
    expect(crossVenueAgreement(a, b, { maxBps: 50, driftCeilBps: 10 }).verdict).toBe("minor_drift");
  });

  it("uses default maxBps=50 / driftCeilBps=30 when opts omitted", () => {
    const a = series([100, 100, 100]);
    const close = series([100, 100, 100]);
    const drift = a.map((x) => c(x.start_unix, x.close * 1.0035)); // ~35bps > 30 default
    const suspect = series([100, 100, 200]); // > 50bps default
    expect(crossVenueAgreement(a, close).verdict).toBe("agree");
    expect(crossVenueAgreement(a, drift).verdict).toBe("minor_drift");
    expect(crossVenueAgreement(a, suspect).verdict).toBe("suspect");
  });

  it("report shape: every field has the documented type", () => {
    const rep = crossVenueAgreement(series([100, 100]), series([100, 105]));
    expect(typeof rep.overlap).toBe("number");
    expect(typeof rep.onlyA).toBe("number");
    expect(typeof rep.onlyB).toBe("number");
    expect(typeof rep.medianBps).toBe("number");
    expect(typeof rep.p95Bps).toBe("number");
    expect(typeof rep.maxBps).toBe("number");
    expect(Array.isArray(rep.divergent)).toBe(true);
    expect(["agree", "minor_drift", "suspect"]).toContain(rep.verdict);
  });

  it("does not mutate inputs", () => {
    const a = series([100, 200, 300]);
    const b = series([100, 250, 300]);
    const aCopy = JSON.parse(JSON.stringify(a));
    const bCopy = JSON.parse(JSON.stringify(b));
    crossVenueAgreement(a, b, { maxBps: 50 });
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

// ===========================================================================
describe("flagDivergentBars — properties", () => {
  it("result is always a subset of primary (every flagged bar is a primary bar object)", () => {
    const primary = series([100, 250, 300, 999]);
    const reference = series([100, 200, 300, 400]);
    const flagged = flagDivergentBars(primary, reference, { maxBps: 50 });
    for (const f of flagged) expect(primary).toContain(f);
  });

  it("never flags a bar whose timestamp is absent from the reference", () => {
    const primary = [c(10, 100), c(20, 999), c(30, 300)];
    const reference = [c(10, 100)]; // only t=10 is judgeable
    const flagged = flagDivergentBars(primary, reference, { maxBps: 50 });
    const refTs = new Set(reference.map((x) => x.start_unix));
    for (const f of flagged) expect(refTs.has(f.start_unix)).toBe(true);
  });

  it("flags exactly the overlap bars whose divergence exceeds maxBps", () => {
    const primary = series([100, 101, 200, 300]);
    const reference = series([100, 100, 100, 300]);
    const maxBps = 50;
    const flagged = flagDivergentBars(primary, reference, { maxBps }).map((x) => x.start_unix);
    const refMap = new Map(reference.map((x) => [x.start_unix, x.close]));
    const expectedTs = primary
      .filter((p) => refMap.has(p.start_unix) && expectedBps(p.close, refMap.get(p.start_unix)!) > maxBps)
      .map((p) => p.start_unix);
    expect(flagged).toEqual(expectedTs);
  });

  it("flagged bars are exactly crossVenueAgreement(primary, reference).divergent by timestamp", () => {
    const primary = series([100, 250, 300, 800]);
    const reference = series([100, 200, 300, 400]);
    const flagged = new Set(flagDivergentBars(primary, reference, { maxBps: 50 }).map((x) => x.start_unix));
    const divergent = new Set(
      crossVenueAgreement(primary, reference, { maxBps: 50 }).divergent.map((x) => x.start_unix),
    );
    expect(flagged).toEqual(divergent);
  });

  it("identical primary and reference → nothing flagged", () => {
    const s = series([100, 200, 300, 400]);
    expect(flagDivergentBars(s, s, { maxBps: 50 })).toHaveLength(0);
  });

  it("zero tolerance flags every overlapping bar that differs at all", () => {
    const primary = series([100, 201, 300]);
    const reference = series([100, 200, 300]); // only middle bar differs
    const flagged = flagDivergentBars(primary, reference, { maxBps: 0 }).map((x) => x.start_unix);
    expect(flagged).toEqual([20]);
  });

  it("a huge tolerance flags nothing", () => {
    const primary = series([100, 500, 9000]);
    const reference = series([100, 200, 300]);
    expect(flagDivergentBars(primary, reference, { maxBps: 1e9 })).toHaveLength(0);
  });

  it("flag count is monotone non-increasing as tolerance rises", () => {
    const primary = series([100, 110, 130, 160, 250]);
    const reference = series([100, 100, 100, 100, 100]);
    const counts = [0, 50, 200, 1000, 1e6].map(
      (m) => flagDivergentBars(primary, reference, { maxBps: m }).length,
    );
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  });

  it("preserves primary's relative order of flagged bars", () => {
    const primary = series([100, 999, 100, 888, 100]);
    const reference = series([100, 100, 100, 100, 100]);
    const flagged = flagDivergentBars(primary, reference, { maxBps: 50 }).map((x) => x.start_unix);
    expect(flagged).toEqual([20, 40]); // primary order (ascending here)
  });

  it("default maxBps=50 used when opts omitted", () => {
    const primary = [c(10, 100), c(20, 100.4)]; // 20 is ~40bps off (< 50) → not flagged
    const reference = [c(10, 100), c(20, 100)];
    expect(flagDivergentBars(primary, reference)).toHaveLength(0);
    const primary2 = [c(10, 100), c(20, 200)]; // way over → flagged
    expect(flagDivergentBars(primary2, reference)).toHaveLength(1);
  });

  it("empty primary → empty result; empty reference → empty result", () => {
    expect(flagDivergentBars([], series([100]))).toEqual([]);
    expect(flagDivergentBars(series([100]), [])).toEqual([]);
  });

  it("does not mutate inputs", () => {
    const primary = series([100, 250]);
    const reference = series([100, 200]);
    const pCopy = JSON.parse(JSON.stringify(primary));
    const rCopy = JSON.parse(JSON.stringify(reference));
    flagDivergentBars(primary, reference, { maxBps: 50 });
    expect(primary).toEqual(pCopy);
    expect(reference).toEqual(rCopy);
  });

  it("seeded fuzz: flagged set is always a subset of the judgeable overlap", () => {
    const gen = lcg(31337);
    for (let trial = 0; trial < 15; trial++) {
      const primary: VenueCandle[] = [];
      const reference: VenueCandle[] = [];
      for (let i = 0; i < 12; i++) {
        const t = 10 * i;
        primary.push(c(t, rng(gen, 50, 200)));
        if (gen() > 0.3) reference.push(c(t, rng(gen, 50, 200)));
      }
      const refTs = new Set(reference.map((x) => x.start_unix));
      const flagged = flagDivergentBars(primary, reference, { maxBps: 50 });
      for (const f of flagged) {
        expect(primary).toContain(f);
        expect(refTs.has(f.start_unix)).toBe(true);
      }
    }
  });
});

// ===========================================================================
describe("consolidatedCloses — properties", () => {
  it("one row per overlap bar (length === alignVenueCloses length)", () => {
    const a = series([100, 200, 300, 400]);
    const b = [c(10, 100), c(30, 300), c(50, 500)];
    expect(consolidatedCloses(a, b, { maxBps: 50 })).toHaveLength(alignVenueCloses(a, b).length);
  });

  it("when venues agree, the consolidated close is the MEAN and lies strictly between the two closes", () => {
    const out = consolidatedCloses([c(10, 100)], [c(10, 104)], { maxBps: 1000 });
    expect(out[0].agreed).toBe(true);
    expect(out[0].close).toBe(102); // mean
    expect(out[0].close).toBeGreaterThan(100);
    expect(out[0].close).toBeLessThan(104);
  });

  it("consolidated mean is bounded by [min(a,b), max(a,b)] across seeded agreeing bars", () => {
    const gen = lcg(8675309);
    const a: VenueCandle[] = [];
    const b: VenueCandle[] = [];
    for (let i = 0; i < 30; i++) {
      const t = 10 * i;
      const base = rng(gen, 100, 200);
      a.push(c(t, base));
      b.push(c(t, base * (1 + rng(gen, -0.001, 0.001)))); // tiny drift → always agrees at maxBps 50
    }
    const out = consolidatedCloses(a, b, { maxBps: 50 });
    for (const row of out) {
      const idx = (row.start_unix / 10) | 0;
      const lo = Math.min(a[idx].close, b[idx].close);
      const hi = Math.max(a[idx].close, b[idx].close);
      expect(row.agreed).toBe(true);
      expect(row.close).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(row.close).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it("when venues diverge past tolerance, close falls back to the PRIMARY (a) and agreed=false", () => {
    const out = consolidatedCloses([c(10, 100)], [c(10, 200)], { maxBps: 50 });
    expect(out[0].agreed).toBe(false);
    expect(out[0].close).toBe(100); // primary, not the 150 mean
  });

  it("agreed flag is true exactly when bps <= maxBps (boundary inclusive)", () => {
    // construct a pair whose bps is just under / over a chosen tolerance
    const a = c(10, 100);
    const b = c(10, 101); // bps = |1|/100.5*1e4 ≈ 99.5
    const bps = expectedBps(100, 101);
    const justUnder = consolidatedCloses([a], [b], { maxBps: bps + 0.5 })[0];
    const justOver = consolidatedCloses([a], [b], { maxBps: bps - 0.5 })[0];
    expect(justUnder.agreed).toBe(true);
    expect(justUnder.close).toBe(100.5);
    expect(justOver.agreed).toBe(false);
    expect(justOver.close).toBe(100); // primary
  });

  it("exactly-at-tolerance counts as agreed (<=, not <)", () => {
    const bps = expectedBps(100, 101);
    const out = consolidatedCloses([c(10, 100)], [c(10, 101)], { maxBps: bps })[0];
    expect(out.agreed).toBe(true);
    expect(out.close).toBe(100.5);
  });

  it("agreed rows here match the non-divergent overlap bars from crossVenueAgreement", () => {
    const a = series([100, 100, 100, 100]);
    const b = series([100, 101, 300, 100.1]);
    const maxBps = 50;
    const agreedTs = new Set(
      consolidatedCloses(a, b, { maxBps }).filter((r) => r.agreed).map((r) => r.start_unix),
    );
    const divergentTs = new Set(
      crossVenueAgreement(a, b, { maxBps }).divergent.map((r) => r.start_unix),
    );
    // agreed and divergent partitions must be disjoint and cover the overlap
    for (const t of agreedTs) expect(divergentTs.has(t)).toBe(false);
    const overlapTs = alignVenueCloses(a, b).map((x) => x.start_unix);
    for (const t of overlapTs) expect(agreedTs.has(t) || divergentTs.has(t)).toBe(true);
  });

  it("swapping a and b changes only the disagreed-bar fallback value, not the agreed means", () => {
    const a = series([100, 100]);
    const b = series([100.2, 500]); // bar0 agrees, bar1 diverges
    const fwd = consolidatedCloses(a, b, { maxBps: 50 });
    const rev = consolidatedCloses(b, a, { maxBps: 50 });
    // agreed bar: mean is order-independent
    expect(fwd[0].close).toBeCloseTo(rev[0].close, 9);
    expect(fwd[0].agreed).toBe(true);
    expect(rev[0].agreed).toBe(true);
    // diverged bar: fallback is each side's own primary
    expect(fwd[1].close).toBe(100); // a's close
    expect(rev[1].close).toBe(500); // b's close (now primary)
    expect(fwd[1].agreed).toBe(false);
    expect(rev[1].agreed).toBe(false);
  });

  it("output start_unix is sorted ascending (inherits alignVenueCloses order)", () => {
    const a = [c(30, 300), c(10, 100), c(20, 200)];
    const b = [c(20, 200), c(10, 100), c(30, 300)];
    const ts = consolidatedCloses(a, b, { maxBps: 50 }).map((r) => r.start_unix);
    expect(ts).toEqual([10, 20, 30]);
  });

  it("identical venues → every row agreed and close equals that identical price", () => {
    const a = series([100, 200, 300]);
    const out = consolidatedCloses(a, a, { maxBps: 50 });
    expect(out.map((r) => r.agreed)).toEqual([true, true, true]);
    expect(out.map((r) => r.close)).toEqual([100, 200, 300]);
  });

  it("maxBps=0 forces fallback-to-primary on any non-identical bar", () => {
    const a = series([100, 200]);
    const b = series([100, 201]);
    const out = consolidatedCloses(a, b, { maxBps: 0 });
    expect(out[0]).toMatchObject({ close: 100, agreed: true }); // identical → 0 bps <= 0
    expect(out[1]).toMatchObject({ close: 200, agreed: false }); // differs → fallback to a
  });

  it("default maxBps=50 applied when opts omitted", () => {
    const tight = consolidatedCloses([c(10, 100)], [c(10, 100.2)]); // ~20bps < 50 → mean
    expect(tight[0].agreed).toBe(true);
    expect(tight[0].close).toBeCloseTo(100.1, 9);
    const loose = consolidatedCloses([c(10, 100)], [c(10, 200)]); // huge → fallback
    expect(loose[0].agreed).toBe(false);
    expect(loose[0].close).toBe(100);
  });

  it("empty overlap → empty consolidated series", () => {
    expect(consolidatedCloses([c(10, 1)], [c(20, 2)], { maxBps: 50 })).toEqual([]);
    expect(consolidatedCloses([], [], { maxBps: 50 })).toEqual([]);
  });

  it("does not mutate inputs", () => {
    const a = series([100, 200]);
    const b = series([100, 250]);
    const aCopy = JSON.parse(JSON.stringify(a));
    const bCopy = JSON.parse(JSON.stringify(b));
    consolidatedCloses(a, b, { maxBps: 50 });
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });

  it("seeded fuzz: every agreed close is the exact arithmetic mean of the two overlap closes", () => {
    const gen = lcg(13);
    const a: VenueCandle[] = [];
    const b: VenueCandle[] = [];
    for (let i = 0; i < 25; i++) {
      const t = 10 * i;
      a.push(c(t, rng(gen, 50, 500)));
      b.push(c(t, rng(gen, 50, 500)));
    }
    const aligned = alignVenueCloses(a, b);
    const out = consolidatedCloses(a, b, { maxBps: 1e9 }); // force all agreed
    out.forEach((row, i) => {
      expect(row.agreed).toBe(true);
      expect(row.close).toBeCloseTo((aligned[i].a + aligned[i].b) / 2, 9);
    });
  });
});
