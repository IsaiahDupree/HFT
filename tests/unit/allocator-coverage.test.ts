/**
 * allocator-coverage — ADVERSARIAL coverage for the cross-edge allocator, BEYOND
 * tests/unit/edge-allocator.test.ts. Targets the math invariants that make a risk-parity book
 * trustworthy:
 *   - NO-LOOKAHEAD: a sleeve return at index j must NOT change any weight at index < j (interior
 *     perturbation, not just a tail perturbation).
 *   - weights sum to exactly 1 every day (full risk-parity AND warmup).
 *   - zero-vol / constant-return sleeves never produce NaN or Inf weights.
 *   - correlation matrix is symmetric, has unit diagonal, and is bounded to [-1, 1].
 *   - degenerate shapes: single sleeve, empty, ragged.
 *
 * Deterministic only — uses an LCG (matching tests/unit/funding.props.test.ts); no network, no
 * wall-clock, no platform RNG. (fast-check is not resolvable in this repo, so we use the same
 * seeded-random property style the existing suite uses.)
 */
import { describe, it, expect } from "vitest";
import {
  equalWeights,
  inverseVolWeights,
  applyAllocation,
  normalizeWeights,
  correlationMatrix,
} from "@/lib/backtest/edge-allocator";

// Numerical Recipes LCG → [0,1) — deterministic, identical across machines.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
// small mean-zero-ish noisy return series (strictly finite, mixed sign)
const noisy = (r: () => number, n: number, scale = 0.02): number[] =>
  Array.from({ length: n }, () => between(r, -scale, scale));

const allFinite = (m: number[][]) => m.every((row) => row.every((x) => Number.isFinite(x)));

// ─────────────────────────────────────────────────────────────────────────────
// inverseVolWeights — NO-LOOKAHEAD (interior perturbation, the cardinal invariant)
// ─────────────────────────────────────────────────────────────────────────────
describe("inverseVolWeights — no-lookahead (interior perturbation)", () => {
  it("perturbing an INTERIOR future return leaves all earlier weights byte-identical", () => {
    const r = lcg(7);
    const A = noisy(r, 24);
    const B = noisy(r, 24);
    const volWin = 4;
    const base = inverseVolWeights([A, B], volWin);

    // Perturb an interior index j (NOT the last bar) — the classic look-ahead trap.
    const j = 12;
    const A2 = [...A];
    A2[j] = 5; // a huge spike at j
    const pert = inverseVolWeights([A2, B], volWin);

    // weight at day i uses vol known BEFORE day i (rollingStd lagged one bar). rollingStd ending at
    // index k includes A[j] only when k ∈ [j, j+volWin-1]; the LAG pushes that into weights at
    // i ∈ [j+1, j+volWin]. So everything at i ≤ j must be untouched.
    for (let e = 0; e < 2; e++) {
      for (let i = 0; i <= j; i++) {
        expect(pert[e][i]).toBe(base[e][i]);
      }
    }
  });

  it("a single future return cannot leak into the very first usable risk-parity weight", () => {
    // With volWin=3, first finite lagged vol is at index 3 (rollingStd finite at 2, lagged to 3).
    const A = [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02];
    const B = [0.03, -0.03, 0.01, -0.01, 0.03, -0.03, 0.01];
    const win = 3;
    const base = inverseVolWeights([A, B], win);
    // bump the final bar
    const A2 = [...A];
    A2[A2.length - 1] = 9;
    const pert = inverseVolWeights([A2, B], win);
    // the entire history up to (length-2) is independent of the last bar
    expect(pert[0].slice(0, A.length - 1)).toEqual(base[0].slice(0, A.length - 1));
    expect(pert[1].slice(0, A.length - 1)).toEqual(base[1].slice(0, A.length - 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inverseVolWeights — columns sum to 1 (risk-parity AND warmup)
// ─────────────────────────────────────────────────────────────────────────────
describe("inverseVolWeights — every column sums to 1, no NaN/Inf", () => {
  it("each day's weights sum to 1 across many random books and windows", () => {
    const r = lcg(101);
    for (let trial = 0; trial < 25; trial++) {
      const E = 2 + Math.floor(r() * 4); // 2..5 sleeves
      const T = 8 + Math.floor(r() * 20);
      const win = 2 + Math.floor(r() * 5);
      const returns = Array.from({ length: E }, () => noisy(r, T, between(r, 0.005, 0.05)));
      const w = inverseVolWeights(returns, win);
      expect(allFinite(w)).toBe(true);
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let e = 0; e < E; e++) s += w[e][t];
        expect(s).toBeCloseTo(1, 9);
      }
    }
  });

  it("warmup days fall back to exactly equal weight (1/E) before any vol is known", () => {
    const A = noisy(lcg(5), 10);
    const B = noisy(lcg(6), 10);
    const win = 4;
    const w = inverseVolWeights([A, B], win);
    // rollingStd is NaN for i < win-1, lagged one bar → first finite lagged vol at index `win`.
    // So columns 0..win-1 are warmup equal-weight.
    for (let t = 0; t < win; t++) {
      expect(w[0][t]).toBeCloseTo(0.5, 12);
      expect(w[1][t]).toBeCloseTo(0.5, 12);
    }
  });

  it("the calmer sleeve gets strictly more weight once both vols are known (sign of risk-parity)", () => {
    const calm = Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.01 : -0.01)); // tiny wiggle
    const wild = Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.08 : -0.08)); // big wiggle
    const w = inverseVolWeights([calm, wild], 4);
    const last = 11;
    expect(w[0][last]).toBeGreaterThan(w[1][last]);
    expect(w[0][last] + w[1][last]).toBeCloseTo(1, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inverseVolWeights — zero-vol & constant-return sleeves (no NaN/Inf)
// ─────────────────────────────────────────────────────────────────────────────
describe("inverseVolWeights — zero-vol / constant sleeve is handled (no NaN, no Inf)", () => {
  it("a flat (zero-vol) sleeve never yields a NaN or Infinity weight; column still sums to 1", () => {
    const flat = new Array(12).fill(0.0); // zero variance → rollingStd 0 → inv = NaN, not Inf
    const live = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, -0.02, 0.04, -0.01, 0.02, -0.03];
    const w = inverseVolWeights([flat, live], 4);
    expect(allFinite(w)).toBe(true);
    for (let t = 0; t < 12; t++) {
      const s = w[0][t] + w[1][t];
      expect(s).toBeCloseTo(1, 9);
      // because a zero-vol sleeve breaks full risk-parity (finite.length !== E),
      // the code must fall back to equal weight on that day — never 1/0 = Inf.
      expect(w[0][t]).toBeCloseTo(0.5, 9);
      expect(w[1][t]).toBeCloseTo(0.5, 9);
    }
  });

  it("a constant-NONZERO sleeve carries tiny float-residual vol → near-100% weight (risk-parity pathology, still finite, still sums to 1)", () => {
    // DISTINCT from the exact-0 sleeve above: repeating a NONZERO value does NOT cancel to an exact
    // 0 std (the (x-mean)^2 sum leaves a ~1e-19 residual), so the sleeve's measured vol is tiny but
    // POSITIVE. Risk parity (w ∝ 1/vol) then hands it essentially the whole book. The invariants we
    // care about hold: every weight is finite (no Inf from 1/0), and each column still sums to 1.
    const constNonzero = new Array(10).fill(0.003); // nonzero mean, ~0 (but not exactly 0) std
    const live = noisy(lcg(42), 10, 0.03);
    const win = 3;
    const w = inverseVolWeights([constNonzero, live], win);
    expect(allFinite(w)).toBe(true);
    for (let t = 0; t < 10; t++) {
      expect(w[0][t] + w[1][t]).toBeCloseTo(1, 9);
    }
    // warmup days (t < win): equal weight; post-warmup: the near-zero-vol sleeve dominates (~1).
    for (let t = 0; t < win; t++) expect(w[0][t]).toBeCloseTo(0.5, 9);
    for (let t = win; t < 10; t++) {
      expect(w[0][t]).toBeGreaterThan(0.999); // calmer (residual-vol) sleeve takes almost all weight
      expect(w[1][t]).toBeGreaterThanOrEqual(0);
    }
  });

  it("ALL sleeves flat → degenerate full equal weight on every day, no NaN", () => {
    const a = new Array(8).fill(0);
    const b = new Array(8).fill(0);
    const w = inverseVolWeights([a, b], 3);
    expect(allFinite(w)).toBe(true);
    w.forEach((col) => col.forEach((x) => expect(x).toBeCloseTo(0.5, 12)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inverseVolWeights / equalWeights — single-sleeve & empty degenerate shapes
// ─────────────────────────────────────────────────────────────────────────────
describe("degenerate shapes — single sleeve and empty book", () => {
  it("single sleeve → weight is 1 every day (it owns the whole book)", () => {
    const A = noisy(lcg(11), 15, 0.04);
    const w = inverseVolWeights([A], 3);
    expect(w.length).toBe(1);
    expect(allFinite(w)).toBe(true);
    w[0].forEach((x) => expect(x).toBeCloseTo(1, 12));
  });

  it("equalWeights single sleeve → all 1s; zero sleeves → empty; nSleeves=0 guard avoids 1/0", () => {
    const one = equalWeights(1, 5);
    expect(one).toEqual([[1, 1, 1, 1, 1]]);
    expect(equalWeights(0, 5)).toEqual([]); // no rows
    // the `nSleeves > 0` guard: with 0 sleeves the fill value path is never division-by-zero
    expect(equalWeights(3, 0)).toEqual([[], [], []]); // T=0 → empty rows
  });

  it("inverseVolWeights with empty returns → empty matrix (no throw)", () => {
    expect(inverseVolWeights([], 3)).toEqual([]);
  });

  it("inverseVolWeights single flat sleeve still resolves to weight 1 (1/E with E=1), never NaN", () => {
    const flat = new Array(9).fill(0);
    const w = inverseVolWeights([flat], 4);
    expect(allFinite(w)).toBe(true);
    w[0].forEach((x) => expect(x).toBeCloseTo(1, 12));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyAllocation — economic identity, ragged guards
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAllocation — weighted-sum identity and ragged guards", () => {
  it("equals Σ_e w[e][t]·r[e][t] for random books", () => {
    const r = lcg(303);
    for (let trial = 0; trial < 20; trial++) {
      const E = 2 + Math.floor(r() * 3);
      const T = 6 + Math.floor(r() * 10);
      const returns = Array.from({ length: E }, () => noisy(r, T, 0.05));
      const weights = inverseVolWeights(returns, 3);
      const port = applyAllocation(returns, weights);
      for (let t = 0; t < T; t++) {
        let expected = 0;
        for (let e = 0; e < E; e++) expected += weights[e][t] * returns[e][t];
        expect(port[t]).toBeCloseTo(expected, 12);
      }
    }
  });

  it("a single-sleeve full-weight book reproduces that sleeve's returns exactly", () => {
    const A = noisy(lcg(9), 12, 0.03);
    const w = inverseVolWeights([A], 3); // all 1s
    const port = applyAllocation([A], w);
    port.forEach((v, i) => expect(v).toBeCloseTo(A[i], 12));
  });

  it("missing weight column entries are treated as 0 (no NaN leaks from ragged input)", () => {
    const returns = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    const weights = [
      [0.5, 0.5], // shorter than T=3 → index 2 is undefined → ?? 0
      [0.5, 0.5, 0.5],
    ];
    const port = applyAllocation(returns, weights);
    expect(port.length).toBe(3);
    expect(port.every(Number.isFinite)).toBe(true);
    // day 2: only sleeve 1 contributes → 0.5*0.6
    expect(port[2]).toBeCloseTo(0.3, 12);
  });

  it("empty book → empty portfolio (no throw)", () => {
    expect(applyAllocation([], [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeWeights — sum-1, floor-negatives, all-zero fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeWeights — sum-1, non-negative, all-zero fallback", () => {
  it("every output column sums to 1 and is non-negative across random (possibly negative) inputs", () => {
    const r = lcg(515);
    for (let trial = 0; trial < 25; trial++) {
      const E = 2 + Math.floor(r() * 4);
      const T = 5 + Math.floor(r() * 8);
      // include negatives and zeros to exercise flooring
      const weights = Array.from({ length: E }, () =>
        Array.from({ length: T }, () => between(r, -0.5, 1)),
      );
      const out = normalizeWeights(weights);
      expect(allFinite(out)).toBe(true);
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let e = 0; e < E; e++) {
          expect(out[e][t]).toBeGreaterThanOrEqual(0); // floored
          s += out[e][t];
        }
        expect(s).toBeCloseTo(1, 9); // an all-negative column floors to 0 then falls back to 1/E
      }
    }
  });

  it("a column where ALL entries are negative → equal weight fallback (sum still 1, no NaN)", () => {
    const out = normalizeWeights([
      [-0.2],
      [-0.7],
    ]);
    expect(out[0][0]).toBeCloseTo(0.5, 12);
    expect(out[1][0]).toBeCloseTo(0.5, 12);
  });

  it("a single positive entry in a column captures the whole column (weight 1); a zero+negative column falls back to equal", () => {
    const out = normalizeWeights([
      [0.0, 2.0],
      [-1.0, 0.0],
    ]);
    // column 0 = [0, -1] → floor negatives → [0, 0] → all-zero → equal-weight fallback (0.5, 0.5)
    expect(out[0][0]).toBeCloseTo(0.5, 12);
    expect(out[1][0]).toBeCloseTo(0.5, 12);
    expect(out[0][0] + out[1][0]).toBeCloseTo(1, 12);
    // column 1 = [2, 0] → sleeve 0 owns the whole column
    expect(out[0][1]).toBeCloseTo(1, 12);
    expect(out[1][1]).toBeCloseTo(0, 12);
  });

  it("NaN/undefined raw weight entries are coerced to 0 (|| 0) and never poison the column", () => {
    const out = normalizeWeights([
      [NaN, 0.5],
      [0.5, 0.5],
    ] as number[][]);
    expect(allFinite(out)).toBe(true);
    // col 0: NaN→0, so only sleeve 1's 0.5 survives → sleeve1 owns column
    expect(out[0][0]).toBeCloseTo(0, 12);
    expect(out[1][0]).toBeCloseTo(1, 12);
    expect(out[0][1] + out[1][1]).toBeCloseTo(1, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// correlationMatrix — symmetric, unit diagonal, bounded [-1, 1]
// ─────────────────────────────────────────────────────────────────────────────
describe("correlationMatrix — symmetric, unit diagonal, bounded", () => {
  it("is symmetric, has 1 on the diagonal, and every entry ∈ [-1, 1] for random books", () => {
    const r = lcg(808);
    for (let trial = 0; trial < 25; trial++) {
      const E = 2 + Math.floor(r() * 4);
      const T = 5 + Math.floor(r() * 30);
      const returns = Array.from({ length: E }, () => noisy(r, T, between(r, 0.005, 0.08)));
      const m = correlationMatrix(returns);
      expect(m.length).toBe(E);
      for (let i = 0; i < E; i++) {
        expect(m[i].length).toBe(E);
        // diagonal — a non-degenerate series correlates perfectly with itself (zero-variance → 0)
        const selfVaries = new Set(returns[i]).size > 1;
        expect(m[i][i]).toBeCloseTo(selfVaries ? 1 : 0, 9);
        for (let j = 0; j < E; j++) {
          expect(m[i][j]).toBeGreaterThanOrEqual(-1 - 1e-9);
          expect(m[i][j]).toBeLessThanOrEqual(1 + 1e-9);
          expect(m[i][j]).toBeCloseTo(m[j][i], 9); // symmetry
        }
      }
    }
  });

  it("detects perfect positive, perfect negative, and (anti)diagonal exactly", () => {
    const A = [1, 2, 3, 4, 5];
    const B = [2, 4, 6, 8, 10]; // +linear scale of A
    const C = [5, 4, 3, 2, 1]; // exact reverse
    const m = correlationMatrix([A, B, C]);
    expect(m[0][1]).toBeCloseTo(1, 9);
    expect(m[0][2]).toBeCloseTo(-1, 9);
    expect(m[1][2]).toBeCloseTo(-1, 9);
    // unit diagonal
    [0, 1, 2].forEach((i) => expect(m[i][i]).toBeCloseTo(1, 9));
  });

  it("a constant (zero-variance) sleeve correlates 0 with everything (no NaN/Inf), still symmetric", () => {
    const flat = [3, 3, 3, 3, 3];
    const live = [0.1, -0.2, 0.3, -0.1, 0.2];
    const m = correlationMatrix([flat, live]);
    expect(allFinite(m)).toBe(true);
    expect(m[0][0]).toBeCloseTo(0, 12); // zero-variance self-corr is defined as 0 here
    expect(m[0][1]).toBeCloseTo(0, 12);
    expect(m[1][0]).toBeCloseTo(0, 12);
    expect(m[1][1]).toBeCloseTo(1, 12);
  });

  it("single-sleeve correlation matrix is a 1×1 with the self-correlation entry", () => {
    const varying = correlationMatrix([[1, 2, 3, 4]]);
    expect(varying).toEqual([[1]]);
    const flat = correlationMatrix([[7, 7, 7]]);
    expect(flat).toEqual([[0]]); // zero variance → 0 by this implementation
  });

  it("a series of length < 2 yields correlation 0 (pearson n<2 guard), no NaN", () => {
    const m = correlationMatrix([[5], [9]]);
    expect(allFinite(m)).toBe(true);
    m.forEach((row) => row.forEach((x) => expect(x).toBe(0)));
  });

  it("empty book → empty matrix", () => {
    expect(correlationMatrix([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// end-to-end: a constant-return sleeve never crashes the full pipeline
// ─────────────────────────────────────────────────────────────────────────────
describe("end-to-end — constant-return sleeve flows through allocate→apply cleanly", () => {
  it("inverseVolWeights → applyAllocation produces a finite portfolio with a constant sleeve", () => {
    const constSleeve = new Array(20).fill(0.001);
    const live = noisy(lcg(1234), 20, 0.04);
    const w = inverseVolWeights([constSleeve, live], 5);
    const port = applyAllocation([constSleeve, live], w);
    expect(port.length).toBe(20);
    expect(port.every(Number.isFinite)).toBe(true);
    // since the const sleeve forces equal weight every day, the portfolio is the simple average
    for (let t = 0; t < 20; t++) {
      expect(port[t]).toBeCloseTo((0.001 + live[t]) / 2, 9);
    }
  });
});
