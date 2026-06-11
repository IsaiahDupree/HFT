import { describe, it, expect } from "vitest";
import { pegDeviation, mrPositions, mrReturns, holdReturns, type Bar } from "@/lib/exec/stable-mr";

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ time: i, close: c }));

describe("pegDeviation", () => {
  it("is the signed gap from $1", () => {
    expect(pegDeviation(0.99)).toBeCloseTo(-0.01, 9);
    expect(pegDeviation(1.005)).toBeCloseTo(0.005, 9);
  });
});

describe("mrPositions — no-lookahead fade of the peg", () => {
  const p = { entry: 0.003, exit: 0.001, maxHold: 10 };
  it("goes LONG when the stable drops below the entry band, exits on reconvergence", () => {
    const b = bars([1.0, 0.996, 0.998, 1.0, 1.0]); // drop to −0.4% then recover
    const pos = mrPositions(b, p);
    expect(pos[0]).toBe(0);   // at peg
    expect(pos[1]).toBe(1);   // −0.4% < −0.3% entry → long
    expect(pos[2]).toBe(1);   // −0.2% still beyond −exit(−0.1%) → hold
    expect(pos[3]).toBe(0);   // back to peg → exit
  });
  it("goes SHORT when above the band", () => {
    const pos = mrPositions(bars([1.0, 1.005, 1.0]), p);
    expect(pos[1]).toBe(-1);
    expect(pos[2]).toBe(0);
  });
  it("force-exits after maxHold even if still dislocated", () => {
    const p2 = { entry: 0.003, exit: 0.001, maxHold: 2 };
    const pos = mrPositions(bars([1.0, 0.99, 0.99, 0.99, 0.99]), p2);
    expect(pos[1]).toBe(1);
    expect(pos[2]).toBe(1);
    expect(pos[3]).toBe(0); // held 2 bars (entry at i=1, i=3 is held=2) → flat
  });
  it("is NO-LOOKAHEAD: perturbing a FUTURE bar cannot change an earlier position", () => {
    const base = bars([1.0, 0.996, 0.998, 1.0, 1.0]);
    const perturbed = bars([1.0, 0.996, 0.998, 1.0, 0.5]); // wreck the last bar
    const a = mrPositions(base, p), c = mrPositions(perturbed, p);
    expect(a.slice(0, 4)).toEqual(c.slice(0, 4));
  });
});

describe("mrReturns — the depeg-and-revert payoff, net of fees", () => {
  const p = { entry: 0.003, exit: 0.001, maxHold: 10 };
  it("a clean depeg→revert makes money; the beta baseline (hold) nets ~0", () => {
    const b = bars([1.0, 0.99, 1.0, 1.0]); // −1% depeg then full recovery
    const r = mrReturns(b, p, 0);
    // long entered at i=1 (close 0.99), realized 0.99→1.0 = +1.01% over i=1→2
    expect(r.gross[1]).toBeGreaterThan(0.009);
    expect(r.net.reduce((a, x) => a + x, 0)).toBeGreaterThan(0);
    expect(r.nTrades).toBe(1);
    // hold-the-stable beta nets ~0 (tiny +0.0001 from down-1%/up-1.01% recovery asymmetry) — far below the MR gain
    const hold = holdReturns(b).reduce((a, x) => a + x, 0);
    const mr = r.net.reduce((a, x) => a + x, 0);
    expect(Math.abs(hold)).toBeLessThan(0.001);
    expect(mr).toBeGreaterThan(hold * 10); // MR alpha dwarfs the beta baseline
  });
  it("fees reduce net below gross and are charged on entry+exit turnover", () => {
    const b = bars([1.0, 0.99, 1.0, 1.0]);
    const free = mrReturns(b, p, 0).net.reduce((a, x) => a + x, 0);
    const costed = mrReturns(b, p, 5).net.reduce((a, x) => a + x, 0); // 5bps/side
    expect(costed).toBeLessThan(free);
    expect(mrReturns(b, p, 5).turnover).toBeGreaterThan(0);
  });
  it("flat-at-peg data trades nothing", () => {
    const r = mrReturns(bars([1.0, 1.0, 1.0, 1.0]), p, 5);
    expect(r.nTrades).toBe(0);
    expect(r.net.every((x) => x === 0)).toBe(true);
  });
});
