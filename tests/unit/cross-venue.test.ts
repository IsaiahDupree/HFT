import { describe, it, expect } from "vitest";
import { alignVenueCloses, crossVenueAgreement, flagDivergentBars, consolidatedCloses } from "@/lib/data/cross-venue";
import type { VenueCandle } from "@/lib/data/venue-candles";

const c = (start_unix: number, close: number): VenueCandle => ({ start_unix, open: close, high: close, low: close, close, volume: 1 });

describe("alignVenueCloses", () => {
  it("inner-joins by timestamp and computes per-bar divergence in bps", () => {
    const a = [c(10, 100), c(20, 200), c(30, 300)];
    const b = [c(10, 100), c(20, 201)]; // no bar at 30
    const out = alignVenueCloses(a, b);
    expect(out.map((x) => x.start_unix)).toEqual([10, 20]);
    expect(out[0].bps).toBeCloseTo(0, 9);
    expect(out[1].bps).toBeCloseTo(Math.abs(200 - 201) / 200.5 * 1e4, 6); // ~49.9bps
  });
});

describe("crossVenueAgreement", () => {
  const a = [c(10, 100), c(20, 200), c(30, 300), c(40, 400)];

  it("verdict 'agree' when both venues track closely", () => {
    const b = [c(10, 100), c(20, 200.1), c(30, 300), c(40, 400)];
    const rep = crossVenueAgreement(a, b);
    expect(rep.overlap).toBe(4);
    expect(rep.verdict).toBe("agree");
    expect(rep.divergent).toHaveLength(0);
  });

  it("verdict 'suspect' and flags the bad bar when one venue has an outlier tick", () => {
    const b = [c(10, 100), c(20, 200), c(30, 360), c(40, 400)]; // 30 is 20% off → ~2000bps
    const rep = crossVenueAgreement(a, b, { maxBps: 50 });
    expect(rep.verdict).toBe("suspect");
    expect(rep.divergent[0].start_unix).toBe(30);
    expect(rep.maxBps).toBeGreaterThan(1000);
  });

  it("verdict 'minor_drift' when p95 exceeds the drift ceiling but nothing breaches maxBps", () => {
    const b = a.map((x) => c(x.start_unix, x.close * 1.0035)); // ~35bps everywhere
    const rep = crossVenueAgreement(b, a, { maxBps: 50, driftCeilBps: 30 });
    expect(rep.verdict).toBe("minor_drift");
    expect(rep.divergent).toHaveLength(0);
  });

  it("counts venue-exclusive bars", () => {
    const b = [c(10, 100), c(20, 200), c(50, 500)];
    const rep = crossVenueAgreement(a, b);
    expect(rep.overlap).toBe(2);
    expect(rep.onlyA).toBe(2); // 30, 40
    expect(rep.onlyB).toBe(1); // 50
  });

  it("empty overlap → zeros, verdict 'agree' (nothing to contradict)", () => {
    const rep = crossVenueAgreement([c(10, 100)], [c(20, 200)]);
    expect(rep.overlap).toBe(0);
    expect(rep.verdict).toBe("agree");
  });
});

describe("flagDivergentBars", () => {
  it("returns primary bars that diverge from the reference past maxBps", () => {
    const primary = [c(10, 100), c(20, 250)];   // 20 is way off
    const reference = [c(10, 100), c(20, 200)];
    const flagged = flagDivergentBars(primary, reference, { maxBps: 50 });
    expect(flagged.map((x) => x.start_unix)).toEqual([20]);
  });
  it("does NOT flag bars absent from the reference (can't judge them)", () => {
    expect(flagDivergentBars([c(99, 100)], [c(10, 100)], { maxBps: 50 })).toHaveLength(0);
  });
});

describe("consolidatedCloses", () => {
  it("averages the two closes where venues agree", () => {
    const out = consolidatedCloses([c(10, 100)], [c(10, 102)], { maxBps: 300 });
    expect(out[0]).toEqual({ start_unix: 10, close: 101, agreed: true });
  });
  it("falls back to the primary close and marks unagreed where they diverge", () => {
    const out = consolidatedCloses([c(10, 100)], [c(10, 200)], { maxBps: 50 });
    expect(out[0].close).toBe(100);
    expect(out[0].agreed).toBe(false);
  });
});
