import { describe, it, expect } from "vitest";
import { forwardConfirmed, type ForwardRecord } from "@/lib/exec/forward-confirm";

const mk = (n: number, realized: number, expected = realized): ForwardRecord[] => Array.from({ length: n }, () => ({ expected, realized }));

describe("forwardConfirmed — the deploy gate (stay paper until the forward track holds)", () => {
  it("NOT confirmed without enough data, even if positive", () => {
    expect(forwardConfirmed(mk(5, 0.01), { minN: 20 }).confirmed).toBe(false);
  });
  it("CONFIRMS a steady positive, calibrated track over enough periods", () => {
    // realized tracks expected (corr 1), positive mean with small variance → high Sharpe, hit 100%
    const recs = Array.from({ length: 25 }, (_, i) => ({ expected: 0.01 + (i % 3) * 0.001, realized: 0.01 + (i % 3) * 0.001 }));
    const f = forwardConfirmed(recs, { minN: 20 });
    expect(f.confirmed).toBe(true);
    expect(f.corr).toBeGreaterThan(0.9);
    expect(f.hitRate).toBe(1);
  });
  it("REJECTS when realized does NOT track expected (uncalibrated — corr too low)", () => {
    // realized alternates sign (low Sharpe) and is uncorrelated with a constant expected
    const recs = Array.from({ length: 25 }, (_, i) => ({ expected: 0.01, realized: i % 2 ? 0.05 : -0.05 }));
    const f = forwardConfirmed(recs, { minN: 20 });
    expect(f.confirmed).toBe(false);
    expect(f.reason).toMatch(/sharpe|hit|corr/);
  });
  it("REJECTS a losing track", () => {
    expect(forwardConfirmed(mk(25, -0.01), { minN: 20 }).confirmed).toBe(false);
  });
  it("empty track is safe and unconfirmed", () => {
    expect(forwardConfirmed([])).toMatchObject({ n: 0, confirmed: false });
  });
});
