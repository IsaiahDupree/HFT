import { describe, it, expect } from "vitest";
import { annualizeHourly, hlDeltaBacktest, holdSingleCoin, DEFAULT_ROTATE } from "@/lib/backtest/candle/hl-delta";
import { detectLookahead } from "@/lib/backtest/lookahead-detect";

describe("annualizeHourly", () => {
  it("scales an hourly rate by 24×365", () => {
    expect(annualizeHourly(0.00001)).toBeCloseTo(0.00001 * 8760, 9);
  });
});

describe("hlDeltaBacktest — gate, hold, rotate, exit", () => {
  // two coins, constant hourly funding. A ≈ +0.00002/hr → 17.5% APR (eligible), B ≈ +0.000005/hr → 4.4% APR (below 5% gate)
  const n = 50;
  const rates = { A: Array(n).fill(0.00002), B: Array(n).fill(0.000005) };

  it("holds the eligible coin and collects its realized funding", () => {
    const r = hlDeltaBacktest(["A", "B"], rates, n, DEFAULT_ROTATE, 0);
    expect(r.coinPath[0]).toBe("A");        // A is the only one above the 5% gate
    expect(r.gross[0]).toBeCloseTo(0.00002, 9);
    expect(r.hoursDeployed).toBe(n - 1);
    expect(r.nRotations).toBe(1);           // single entry, no churn
  });

  it("stays FLAT when no coin clears the gate", () => {
    const low = { A: Array(n).fill(0.000001), B: Array(n).fill(0.000001) }; // ~0.9% APR, both below gate
    const r = hlDeltaBacktest(["A", "B"], low, n, DEFAULT_ROTATE, 0);
    expect(r.coinPath.every((c) => c === null)).toBe(true);
    expect(r.hoursDeployed).toBe(0);
  });

  it("rotates only when the better coin clears the hysteresis cost guard", () => {
    // A starts best; halfway, B jumps far above A → should rotate once
    const ra = Array(n).fill(0.00002);
    const rb = Array(n).fill(0.000005).map((v, i) => (i >= 25 ? 0.00005 : v)); // B → 43% APR after i=25
    const r = hlDeltaBacktest(["A", "B"], { A: ra, B: rb }, n, DEFAULT_ROTATE, 0);
    expect(r.coinPath[0]).toBe("A");
    expect(r.coinPath[30]).toBe("B");       // rotated to B
    expect(r.nRotations).toBe(2);           // enter A, rotate to B
  });

  it("does NOT churn on a tiny improvement below the hysteresis band", () => {
    // A is clearly best at entry; B later edges barely above A (gap < 10% APR hysteresis) → must NOT rotate
    const ra = Array(n).fill(0.00002);                                   // 17.5% APR throughout
    const rb = Array(n).fill(0.000018).map((v, i) => (i >= 25 ? 0.0000205 : v)); // 15.8% → 18.0% (gap to A ≈0.4%)
    const r = hlDeltaBacktest(["A", "B"], { A: ra, B: rb }, n, DEFAULT_ROTATE, 0);
    expect(r.coinPath[0]).toBe("A");                                     // A best at entry
    expect(r.coinPath.filter((c) => c === "B").length).toBe(0);          // never rotates for a sub-cost gap
    expect(r.nRotations).toBe(1);
  });

  it("rotation cost reduces net below gross on the rotation bar", () => {
    const ra = Array(n).fill(0.00002);
    const rb = Array(n).fill(0.000005).map((v, i) => (i >= 25 ? 0.00005 : v));
    const r = hlDeltaBacktest(["A", "B"], { A: ra, B: rb }, n, { ...DEFAULT_ROTATE, hysteresisApr: 0.05 }, 5);
    const rotateBar = r.coinPath.findIndex((c, i) => i > 0 && c !== r.coinPath[i - 1]);
    expect(r.net[rotateBar]).toBeLessThan(r.gross[rotateBar]); // charged 5bps on the rotation
  });

  it("is NO-LOOKAHEAD: the coin path is stable when future bars are truncated", () => {
    const ra = Array(n).fill(0.00002);
    const rb = Array(n).fill(0.000005).map((v, i) => (i >= 25 ? 0.00005 : v));
    const pathFn = (slice: readonly number[]) => {
      const m = slice.length;
      const r = hlDeltaBacktest(["A", "B"], { A: ra.slice(0, m), B: rb.slice(0, m) }, m, DEFAULT_ROTATE, 0);
      return r.coinPath.map((c) => (c === "A" ? 1 : c === "B" ? 2 : 0));
    };
    const lk = detectLookahead(pathFn, Array(n).fill(0));
    expect(lk.biased).toBe(false);
  });
});

describe("holdSingleCoin — the beta baseline", () => {
  it("collects every hour's realized funding for the chosen coin", () => {
    const rates = { BTC: [0.0001, 0.0002, 0.0003] };
    expect(holdSingleCoin("BTC", rates, 3)).toEqual([0.0002, 0.0003]);
  });
});
