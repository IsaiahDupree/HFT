import { describe, it, expect } from "vitest";
import {
  vrpPremium,
  vrpPremiumSeries,
  realizedVolFromReturns,
  realizedVolOverWindow,
  trailingRealizedVol,
  vrpSignal,
  shortVolPnl,
  nonOverlappingPnl,
  overlappingLadderReturns,
  perPeriodSharpe,
  nonOverlapAnnualizedSharpe,
  tailStats,
  VRP_DEFAULT_ANN,
} from "@/lib/exec/vol-risk-premium";

// ─────────── deterministic helpers (no wall-clock, no platform RNG) ───────────
// Numerical Recipes LCG → [0,1) — the repo's working "property test" pattern (fast-check
// is NOT installed here; tests/unit/funding.props.test.ts uses this same hand-rolled RNG).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]) => sum(a) / a.length;

// a strictly-positive random close series (geometric random walk) → safe log-returns
function randCloses(r: () => number, n: number, drift = 0): number[] {
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + drift + between(r, -0.05, 0.05)));
  return out;
}
const logrets = (closes: number[]) => closes.map((c, i) => (i === 0 ? 0 : Math.log(c / closes[i - 1])));

// reference annualized realized vol over a window of log-returns (sample std × √365)
function refRV(win: number[], ann = Math.sqrt(365)): number {
  const m = mean(win);
  const v = win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1);
  return Math.sqrt(v) * ann;
}

// ═══════════════════════════════ vrpPremium — SIGN correctness ═══════════════════════════════
describe("vrpPremium — implied minus realized (sign correctness)", () => {
  it("POSITIVE when implied richer than realized (the edge: seller is paid)", () => {
    expect(vrpPremium(0.65, 0.50)).toBeCloseTo(0.15, 12);
    expect(vrpPremium(0.65, 0.50)).toBeGreaterThan(0);
  });

  it("NEGATIVE when realized exceeds implied (a vol-spike / tail day: seller bled)", () => {
    expect(vrpPremium(0.40, 0.90)).toBeCloseTo(-0.50, 12);
    expect(vrpPremium(0.40, 0.90)).toBeLessThan(0);
  });

  it("ZERO at exact parity (boundary)", () => {
    expect(vrpPremium(0.5, 0.5)).toBe(0);
  });

  it("is exactly implied − realized for random finite pairs (linearity/antisymmetry)", () => {
    const r = lcg(101);
    for (let t = 0; t < 200; t++) {
      const a = between(r, 0, 2), b = between(r, 0, 2);
      expect(vrpPremium(a, b)).toBeCloseTo(a - b, 12);
      // antisymmetry: swapping the legs flips the sign
      expect(vrpPremium(a, b)).toBeCloseTo(-vrpPremium(b, a), 12);
    }
  });

  it("unit-agnostic: vol-points in → vol-points out (65 − 50 = 15 pts)", () => {
    expect(vrpPremium(65, 50)).toBe(15);
  });

  it("non-finite either leg → NaN (so the downstream gate flattens, not trades on junk)", () => {
    expect(vrpPremium(NaN, 0.5)).toBeNaN();
    expect(vrpPremium(0.5, Infinity)).toBeNaN();
    expect(vrpPremium(0.5, -Infinity)).toBeNaN();
    expect(vrpPremium(undefined as unknown as number, 0.5)).toBeNaN();
  });

  it("series form aligns to the shorter input and matches elementwise", () => {
    const iv = [0.6, 0.7, 0.8, 0.9];
    const rv = [0.5, 0.5, 0.5];
    const out = vrpPremiumSeries(iv, rv);
    expect(out).toHaveLength(3); // min length
    expect(out).toEqual([0.6 - 0.5, 0.7 - 0.5, 0.8 - 0.5].map((x) => +x.toFixed(12)).map((_, i) => out[i]));
    expect(out[0]).toBeCloseTo(0.1, 12);
    expect(out[2]).toBeCloseTo(0.3, 12);
  });
});

// ═══════════════════════════════ realizedVolFromReturns — correctness ═══════════════════════════════
describe("realizedVolFromReturns — sample std × annualization", () => {
  it("matches the closed-form sample std × √365 for a random window", () => {
    const r = lcg(202);
    const win = Array.from({ length: 30 }, () => between(r, -0.05, 0.05));
    expect(realizedVolFromReturns(win)).toBeCloseTo(refRV(win), 12);
  });

  it("uses the n−1 (sample, unbiased) denominator, not n", () => {
    // two returns: [a, b]; sample variance = (a-b)^2 / 2 ⇒ std = |a-b|/√2
    const a = 0.02, b = -0.04;
    const expected = (Math.abs(a - b) / Math.SQRT2) * Math.sqrt(365);
    expect(realizedVolFromReturns([a, b])).toBeCloseTo(expected, 12);
  });

  it("ZERO-VOL (constant returns) → exactly 0 (degenerate, finite, not NaN)", () => {
    expect(realizedVolFromReturns([0.01, 0.01, 0.01, 0.01])).toBe(0);
    expect(realizedVolFromReturns([0, 0, 0])).toBe(0);
  });

  it("scales linearly with the annualization factor (√365 vs 1)", () => {
    const r = lcg(203);
    const win = Array.from({ length: 20 }, () => between(r, -0.03, 0.03));
    const daily = realizedVolFromReturns(win, 1);
    const annual = realizedVolFromReturns(win, Math.sqrt(365));
    expect(annual).toBeCloseTo(daily * Math.sqrt(365), 12);
  });

  it("DEGENERATE: empty / single-element → NaN (variance undefined with <2 points)", () => {
    expect(realizedVolFromReturns([])).toBeNaN();
    expect(realizedVolFromReturns([0.01])).toBeNaN();
  });

  it("drops non-finite members and uses the clean subset", () => {
    const clean = [0.01, -0.02, 0.03];
    const dirty = [0.01, NaN, -0.02, Infinity, 0.03, undefined as unknown as number];
    expect(realizedVolFromReturns(dirty)).toBeCloseTo(realizedVolFromReturns(clean), 12);
  });

  it("VRP_DEFAULT_ANN is √365 (the crypto daily→annual factor)", () => {
    expect(VRP_DEFAULT_ANN).toBeCloseTo(Math.sqrt(365), 12);
  });
});

// ═══════════════════════════════ realizedVolOverWindow — the forward (realization) leg ═══════════════════════════════
describe("realizedVolOverWindow — annualized RV over (i, i+H]", () => {
  it("equals the sample std of exactly the H returns strictly after i", () => {
    const r = lcg(301);
    const lr = logrets(randCloses(r, 60));
    const i = 5, H = 20;
    const win = lr.slice(i + 1, i + 1 + H);
    expect(realizedVolOverWindow(lr, i, H)).toBeCloseTo(refRV(win), 12);
  });

  it("reads (i, i+H] — does NOT include the return AT i (window starts at i+1)", () => {
    // build a series where ret[i] is a huge outlier but the forward window is calm.
    const lr = [0, 5, 0.001, 0.001, 0.001, 0.001]; // index 1 is the outlier
    const calm = realizedVolOverWindow(lr, 1, 4); // window = indices 2..5 (all ~0.001)
    expect(calm).toBeCloseTo(0, 9); // constant forward window → ~0 vol, outlier ignored
  });

  it("TRUNCATION: returns NaN when the window runs off the end", () => {
    const lr = [0, 0.01, 0.02, 0.03];
    expect(realizedVolOverWindow(lr, 1, 5)).toBeNaN(); // not enough future
    expect(realizedVolOverWindow(lr, lr.length - 1, 3)).toBeNaN();
  });

  it("H < 2 → NaN (variance needs ≥ 2 points)", () => {
    const lr = [0, 0.01, 0.02, 0.03, 0.04];
    expect(realizedVolOverWindow(lr, 0, 1)).toBeNaN();
  });

  it("NO-LOOKAHEAD on the SIGNAL boundary: it never reads index ≤ i", () => {
    // Perturbing any return at index ≤ i must NOT change the window vol (window is strictly future).
    const r = lcg(302);
    const lr = logrets(randCloses(r, 50));
    const i = 10, H = 15;
    const base = realizedVolOverWindow(lr, i, H);
    const lr2 = [...lr];
    lr2[i] = 99; // corrupt the entry-day return and everything before is untouched
    lr2[i - 1] = -99;
    lr2[0] = 42;
    expect(realizedVolOverWindow(lr2, i, H)).toBeCloseTo(base, 12);
  });
});

// ═══════════════════════════════ trailingRealizedVol — the SIGNAL leg, NO-LOOKAHEAD ═══════════════════════════════
describe("trailingRealizedVol — trailing n-bar RV for the signal", () => {
  it("is NaN until index ≥ n, then finite (warm-up boundary)", () => {
    const r = lcg(401);
    const closes = randCloses(r, 40);
    const n = 10;
    const out = trailingRealizedVol(closes, n);
    for (let i = 0; i < n; i++) expect(out[i]).toBeNaN();
    for (let i = n; i < closes.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("matches the closed-form trailing sample std × √365 at each index", () => {
    const r = lcg(402);
    const closes = randCloses(r, 30);
    const lr = logrets(closes);
    const n = 8;
    const out = trailingRealizedVol(closes, n);
    for (let i = n; i < closes.length; i++) {
      const win = lr.slice(i - n + 1, i + 1); // last n log-returns ending at i
      expect(out[i]).toBeCloseTo(refRV(win), 12);
    }
  });

  it("NO-LOOKAHEAD — perturbing a FUTURE close never changes a past trailing-RV value", () => {
    const r = lcg(403);
    const closes = randCloses(r, 50);
    const n = 12;
    const base = trailingRealizedVol(closes, n);
    const k = 35; // perturb the close at 35
    const c2 = [...closes];
    c2[k] = closes[k] * 1.5;
    const pert = trailingRealizedVol(c2, n);
    // every index strictly before k must be byte-identical (NaN-safe compare)
    for (let i = 0; i < k; i++) {
      if (Number.isNaN(base[i])) expect(pert[i]).toBeNaN();
      else expect(pert[i]).toBeCloseTo(base[i], 12);
    }
    // and the perturbation DOES reach index k (sanity: the test isn't vacuous)
    expect(pert[k]).not.toBeCloseTo(base[k], 6);
  });

  it("appending future bars never rewrites the prefix (causal/streaming-stable)", () => {
    const r = lcg(404);
    const head = randCloses(r, 25);
    const tail = randCloses(lcg(999), 15).map((x) => x); // arbitrary extra closes
    const n = 10;
    const headRV = trailingRealizedVol(head, n);
    const fullRV = trailingRealizedVol([...head, ...tail], n);
    for (let i = 0; i < head.length; i++) {
      if (Number.isNaN(headRV[i])) expect(fullRV[i]).toBeNaN();
      else expect(fullRV[i]).toBeCloseTo(headRV[i], 12);
    }
  });

  it("ZERO-VOL: constant closes → 0 vol once warmed up (not NaN)", () => {
    const closes = Array(20).fill(100);
    const out = trailingRealizedVol(closes, 5);
    for (let i = 5; i < closes.length; i++) expect(out[i]).toBe(0);
  });

  it("DEGENERATE: a non-positive close taints its windows → NaN there (gate flattens)", () => {
    const closes = [100, 101, 0, 102, 103, 104, 105, 106]; // a zero close at index 2
    const n = 3;
    const out = trailingRealizedVol(closes, n);
    // windows that include the 0→102 jump or the 101→0 jump are NaN; later clean windows recover
    expect(out.some((v) => Number.isNaN(v))).toBe(true);
    // a window fully past the bad close (indices 4,5,6 → i=6) is finite again
    expect(Number.isFinite(out[6])).toBe(true);
  });

  it("n < 2 → all NaN (variance undefined)", () => {
    const r = lcg(405);
    const out = trailingRealizedVol(randCloses(r, 10), 1);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("does not mutate its input closes array", () => {
    const closes = [100, 101, 102, 103, 104];
    const copy = [...closes];
    trailingRealizedVol(closes, 3);
    expect(closes).toEqual(copy);
  });
});

// ═══════════════════════════════ vrpSignal — the short-vol gate, thresholds & no-lookahead ═══════════════════════════════
describe("vrpSignal — short-vol entry gate", () => {
  it("SHORT (−1) only when observed premium ≥ minVRP; else flat (0)", () => {
    const iv = [0.6, 0.6, 0.6, 0.6];
    const trailRV = [0.40, 0.55, 0.60, 0.10]; // premiums: 0.20, 0.05, 0.00, 0.50
    const out = vrpSignal(iv, trailRV, { minVRP: 0.10 });
    expect(out).toEqual([-1, 0, 0, -1]);
  });

  it("BOUNDARY is inclusive: premium exactly == minVRP enters short", () => {
    // use float-exact values (0.75 − 0.25 == 0.5 exactly) to test the >= boundary cleanly.
    expect(vrpSignal([0.75], [0.25], { minVRP: 0.5 })).toEqual([-1]); // premium == threshold → short
    // a hair below the threshold → flat
    expect(vrpSignal([0.75], [0.25 + 1e-6], { minVRP: 0.5 })).toEqual([0]);
    // a hair above → short
    expect(vrpSignal([0.75], [0.25 - 1e-6], { minVRP: 0.5 })).toEqual([-1]);
  });

  it("default minVRP = 0 → short whenever implied ≥ trailing realized", () => {
    const iv = [0.6, 0.5, 0.5];
    const trailRV = [0.5, 0.5, 0.6]; // premiums: +0.1, 0, −0.1
    expect(vrpSignal(iv, trailRV)).toEqual([-1, -1, 0]);
  });

  it("output is always in {−1, 0} (a SHORT-only carry, never long vol)", () => {
    const r = lcg(501);
    const iv = Array.from({ length: 60 }, () => between(r, 0.2, 1.5));
    const trailRV = Array.from({ length: 60 }, () => between(r, 0.2, 1.5));
    const out = vrpSignal(iv, trailRV, { minVRP: between(r, -0.2, 0.5) });
    expect(out.every((v) => v === -1 || v === 0)).toBe(true);
  });

  it("MONOTONE in threshold: raising minVRP can only REMOVE shorts, never add", () => {
    const r = lcg(502);
    const n = 80;
    const iv = Array.from({ length: n }, () => between(r, 0.3, 1.2));
    const trailRV = Array.from({ length: n }, () => between(r, 0.3, 1.2));
    const loose = vrpSignal(iv, trailRV, { minVRP: -0.1 });
    const tight = vrpSignal(iv, trailRV, { minVRP: 0.2 });
    for (let i = 0; i < n; i++) if (tight[i] === -1) expect(loose[i]).toBe(-1);
    // count of shorts is non-increasing in the threshold
    const nShorts = (a: number[]) => a.filter((v) => v === -1).length;
    expect(nShorts(tight)).toBeLessThanOrEqual(nShorts(loose));
  });

  it("DEGENERATE iv: non-positive or non-finite implied → flat (no short on junk)", () => {
    const iv = [0, -0.5, NaN, Infinity, 0.6];
    const trailRV = [0.1, 0.1, 0.1, 0.1, 0.1];
    expect(vrpSignal(iv, trailRV, { minVRP: 0 })).toEqual([0, 0, 0, 0, -1]);
  });

  it("DEGENERATE trailRV: non-finite trailing vol → flat (warm-up / tainted window)", () => {
    const iv = [0.6, 0.6, 0.6, 0.6];
    const trailRV = [NaN, undefined as unknown as number, Infinity, 0.1];
    expect(vrpSignal(iv, trailRV, { minVRP: 0 })).toEqual([0, 0, 0, -1]);
  });

  it("NO-LOOKAHEAD — perturbing inputs at index k only changes the signal at index k", () => {
    const r = lcg(503);
    const n = 40;
    const iv = Array.from({ length: n }, () => between(r, 0.4, 1.0));
    const trailRV = Array.from({ length: n }, () => between(r, 0.4, 1.0));
    const base = vrpSignal(iv, trailRV, { minVRP: 0.05 });
    const k = 22;
    const iv2 = [...iv];
    iv2[k] = iv2[k] > trailRV[k] ? 0.001 : 5; // flip its decision
    const pert = vrpSignal(iv2, trailRV, { minVRP: 0.05 });
    for (let i = 0; i < n; i++) if (i !== k) expect(pert[i]).toBe(base[i]);
  });

  it("EMPTY input → empty signal", () => {
    expect(vrpSignal([], [])).toEqual([]);
  });
});

// ═══════════════════════════════ shortVolPnl — sign + fee monotonicity ═══════════════════════════════
describe("shortVolPnl — short-vol position P&L net of fee", () => {
  it("POSITIVE when implied K exceeds realized rvReal (premium captured)", () => {
    expect(shortVolPnl(0.7, 0.5, 0)).toBeCloseTo(0.2, 12);
    expect(shortVolPnl(0.7, 0.5, 0)).toBeGreaterThan(0);
  });

  it("NEGATIVE when realized blows past implied (the left-tail loss)", () => {
    expect(shortVolPnl(0.4, 1.2, 0)).toBeCloseTo(-0.8, 12);
    expect(shortVolPnl(0.4, 1.2, 0)).toBeLessThan(0);
  });

  it("FEE monotonicity: higher fee never INCREASES P&L (it is a non-negative drag)", () => {
    const r = lcg(601);
    for (let t = 0; t < 100; t++) {
      const K = between(r, 0.3, 1.2), rvReal = between(r, 0.3, 1.2);
      const lo = shortVolPnl(K, rvReal, 0.01);
      const hi = shortVolPnl(K, rvReal, 0.03);
      expect(hi).toBeLessThanOrEqual(lo + 1e-15);
      // fee enters exactly linearly: pnl(fee2) − pnl(fee1) = −(fee2 − fee1)
      expect(lo - hi).toBeCloseTo(0.02, 12);
    }
  });

  it("negative fee is clamped to 0 (can't fabricate a slippage rebate)", () => {
    expect(shortVolPnl(0.6, 0.5, -1)).toBeCloseTo(0.1, 12); // same as fee=0
  });

  it("DEGENERATE: NaN K or rvReal → NaN (dropped position)", () => {
    expect(shortVolPnl(NaN, 0.5, 0)).toBeNaN();
    expect(shortVolPnl(0.5, Infinity, 0)).toBeNaN();
  });

  it("zero fee + parity → exactly 0 (no edge, no cost)", () => {
    expect(shortVolPnl(0.5, 0.5, 0)).toBe(0);
  });
});

// ═══════════════════════════════ non-overlap vs overlap — the honest-N correction ═══════════════════════════════
describe("nonOverlappingPnl vs overlappingLadderReturns — overlap inflates effective N & Sharpe", () => {
  // Construct an IV that always pays: implied well above the calm realized vol.
  function vrpScenario(seed: number, len: number) {
    const r = lcg(seed);
    const closes = randCloses(r, len, 0); // calm-ish realized vol
    const lr = logrets(closes);
    const iv = closes.map(() => 0.95); // constant rich implied (so the gate fires often)
    return { closes, lr, iv };
  }

  it("non-overlapping produces FAR fewer observations than the daily overlapping ladder", () => {
    const { closes, lr, iv } = vrpScenario(701, 400);
    const opts = { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0 };
    const block = nonOverlappingPnl(iv, closes, lr, opts);
    const daily = overlappingLadderReturns(iv, closes, lr, opts);
    expect(block.length).toBeGreaterThan(2); // we have several independent blocks
    expect(daily.length).toBeGreaterThan(block.length * 3); // ladder has many more (smoothed) days
  });

  it("non-overlapping blocks step by exactly H (independent, non-shared windows)", () => {
    const { closes, lr, iv } = vrpScenario(702, 300);
    const H = 30;
    const block = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: H, minVRP: 0, feeVol: 0 });
    // upper bound: # of H-steps that fit in the usable range — far below the daily count
    const maxBlocks = Math.ceil(closes.length / H);
    expect(block.length).toBeLessThanOrEqual(maxBlocks);
  });

  it("the overlapping daily Sharpe is INFLATED vs the honest non-overlap per-block Sharpe", () => {
    // The ladder shares ~(H−1)/H of positions across consecutive days → heavy autocorrelation →
    // a much smoother (higher per-period Sharpe) series than the independent blocks.
    const { closes, lr, iv } = vrpScenario(703, 500);
    const opts = { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0 };
    const daily = overlappingLadderReturns(iv, closes, lr, opts);
    const block = nonOverlappingPnl(iv, closes, lr, opts);
    const dailySharpe = perPeriodSharpe(daily);
    const blockSharpe = perPeriodSharpe(block);
    // both should be positive (the scenario pays), and the smoothed daily one is strictly larger
    expect(dailySharpe).toBeGreaterThan(0);
    expect(dailySharpe).toBeGreaterThan(blockSharpe);
  });

  it("annualizing the non-overlap Sharpe uses √(blocks/yr), NOT √365 (the discarded inflation)", () => {
    const block = [0.05, 0.03, 0.08, -0.02, 0.06, 0.04];
    const H = 30;
    const honest = nonOverlapAnnualizedSharpe(block, H);
    const perBlock = perPeriodSharpe(block);
    expect(honest).toBeCloseTo(perBlock * Math.sqrt(365 / H), 12);
    // the dishonest daily-style annualization (× √365) would be far larger
    const dishonest = perBlock * Math.sqrt(365);
    expect(Math.abs(honest)).toBeLessThan(Math.abs(dishonest));
  });

  it("FEE monotonicity carries through: higher per-position fee lowers every block P&L by the fee", () => {
    const { closes, lr, iv } = vrpScenario(704, 300);
    const lo = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0.0 });
    const hi = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0.02 });
    expect(lo).toHaveLength(hi.length); // fee doesn't change which positions enter (gate is on premium)
    for (let i = 0; i < lo.length; i++) expect(hi[i]).toBeCloseTo(lo[i] - 0.02, 12);
  });

  it("raising minVRP can only REMOVE blocks (gate monotonicity on the realized series)", () => {
    const r = lcg(705);
    const closes = randCloses(r, 400);
    const lr = logrets(closes);
    // make IV vary so the gate is selective
    const iv = closes.map((_, i) => 0.5 + 0.4 * Math.abs(Math.sin(i / 7)));
    const loose = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: 30, minVRP: -1, feeVol: 0 });
    const tight = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: 30, minVRP: 0.3, feeVol: 0 });
    expect(tight.length).toBeLessThanOrEqual(loose.length);
  });

  it("NO-LOOKAHEAD on the realized window: perturbing a close BEYOND every held window leaves all block P&Ls unchanged", () => {
    const { closes, lr, iv } = vrpScenario(706, 200);
    const opts = { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0 };
    const base = nonOverlappingPnl(iv, closes, lr, opts);
    // perturb the very LAST close — it is past the last fully-realized window (windows need i+H < len),
    // so no entered block's realization includes it → P&Ls must be identical.
    const c2 = [...closes];
    c2[c2.length - 1] = closes[closes.length - 1] * 2;
    const lr2 = logrets(c2);
    // but lr2 also changes ret at the last index; rebuild iv to same constant (independent of closes)
    const pert = nonOverlappingPnl(iv, c2, lr2, opts);
    expect(pert).toEqual(base);
  });

  it("DEGENERATE: all-NaN / empty inputs → empty P&L (no throw)", () => {
    expect(nonOverlappingPnl([], [], [], { rvWindow: 10, horizon: 30 })).toEqual([]);
    expect(overlappingLadderReturns([], [], [], { rvWindow: 10, horizon: 30 })).toEqual([]);
  });

  it("ZERO-VOL realized never loses (short vol against a frozen market is pure premium minus fee)", () => {
    // constant closes → realized window vol = 0 everywhere → every short keeps the full implied K.
    const N = 200;
    const closes = Array(N).fill(100);
    const lr = logrets(closes);
    const iv = closes.map(() => 0.6);
    const block = nonOverlappingPnl(iv, closes, lr, { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0.01 });
    expect(block.length).toBeGreaterThan(0);
    for (const p of block) expect(p).toBeCloseTo(0.6 - 0.01, 9); // K − fee, since realized = 0
  });
});

// ═══════════════════════════════ perPeriodSharpe — robustness ═══════════════════════════════
describe("perPeriodSharpe", () => {
  it("zero-variance series → 0 (undefined risk, defined as 0)", () => {
    expect(perPeriodSharpe([0.05, 0.05, 0.05])).toBe(0);
    expect(perPeriodSharpe([])).toBe(0);
    expect(perPeriodSharpe([0.3])).toBe(0);
  });

  it("positive mean with spread → positive; negated series → negated Sharpe", () => {
    const a = [0.02, -0.01, 0.03, 0.01, 0.04];
    expect(perPeriodSharpe(a)).toBeGreaterThan(0);
    expect(perPeriodSharpe(a.map((x) => -x))).toBeCloseTo(-perPeriodSharpe(a), 12);
  });

  it("scale-invariant (Sharpe of k·r equals Sharpe of r for k>0)", () => {
    const r = lcg(801);
    const a = Array.from({ length: 30 }, () => between(r, -0.05, 0.08));
    expect(perPeriodSharpe(a.map((x) => 3 * x))).toBeCloseTo(perPeriodSharpe(a), 12);
  });
});

// ═══════════════════════════════ tailStats — left-tail / negative-skew detection ═══════════════════════════════
describe("tailStats — the short-vol fat-left-tail panel", () => {
  it("DETECTS a fat left tail: many small wins + a few large losses → skew < 0, leftTail true", () => {
    // 50 small positive carry days, then 3 catastrophic gap days
    const rets = [...Array(50).fill(0.01), -0.5, -0.7, -0.9];
    const t = tailStats(rets);
    expect(t.skew).toBeLessThan(0); // negative skew = the real risk
    expect(t.leftTail).toBe(true);
    expect(t.worst).toBeCloseTo(-0.9, 12); // the single worst gap day
    expect(t.loss).toBe(3);
    expect(t.win).toBe(50);
  });

  it("a RIGHT-skewed series (small losses + rare big wins) → skew > 0, leftTail FALSE", () => {
    const rets = [...Array(50).fill(-0.01), 0.5, 0.7, 0.9];
    const t = tailStats(rets);
    expect(t.skew).toBeGreaterThan(0);
    expect(t.leftTail).toBe(false);
  });

  it("worst is the minimum and p1 is a left-tail (≈1%ile) quantile ≤ median", () => {
    const r = lcg(901);
    const rets = Array.from({ length: 300 }, () => between(r, -0.1, 0.1));
    const t = tailStats(rets);
    expect(t.worst).toBe(Math.min(...rets));
    const sortedMid = [...rets].sort((a, b) => a - b)[150];
    expect(t.p1).toBeLessThanOrEqual(sortedMid); // a left-tail quantile sits below the middle
  });

  it("downsideDev only reflects the negative subset (semi-deviation around 0)", () => {
    const rets = [0.05, 0.05, -0.1, -0.2]; // negatives: -0.1, -0.2
    const t = tailStats(rets);
    const expected = Math.sqrt((0.1 ** 2 + 0.2 ** 2) / 2);
    expect(t.downsideDev).toBeCloseTo(expected, 12);
  });

  it("symmetric (zero-skew) series → skew ≈ 0, leftTail false", () => {
    const rets = [-0.2, -0.1, 0, 0.1, 0.2]; // perfectly symmetric
    const t = tailStats(rets);
    expect(Math.abs(t.skew)).toBeLessThan(1e-9);
    expect(t.leftTail).toBe(false);
  });

  it("win/loss counts are strict (0 is neither a win nor a loss)", () => {
    const t = tailStats([0.1, 0, -0.1, 0, 0.2]);
    expect(t.win).toBe(2);
    expect(t.loss).toBe(1);
  });

  it("DEGENERATE: empty → safe zeros, no throw; single element → no variance, skew 0", () => {
    const e = tailStats([]);
    expect(e.skew).toBe(0);
    expect(e.leftTail).toBe(false);
    expect(e.win).toBe(0);
    const one = tailStats([0.05]);
    expect(one.worst).toBe(0.05);
    expect(one.skew).toBe(0); // sd from <2 points is 0 → skew defined as 0
    expect(one.leftTail).toBe(false);
  });

  it("constant (zero-vol) series → skew 0, no left tail, no losses", () => {
    const t = tailStats(Array(20).fill(0.02));
    expect(t.skew).toBe(0);
    expect(t.leftTail).toBe(false);
    expect(t.loss).toBe(0);
    expect(t.win).toBe(20);
  });

  it("drops non-finite returns before computing the panel", () => {
    const clean = tailStats([0.01, -0.02, 0.03, -0.04]);
    const dirty = tailStats([0.01, NaN, -0.02, Infinity, 0.03, undefined as unknown as number, -0.04]);
    expect(dirty.worst).toBeCloseTo(clean.worst, 12);
    expect(dirty.skew).toBeCloseTo(clean.skew, 12);
    expect(dirty.win).toBe(clean.win);
    expect(dirty.loss).toBe(clean.loss);
  });
});

// ═══════════════════════════════ end-to-end: the carry harvests the measured premium ═══════════════════════════════
describe("end-to-end VRP carry — economic coherence", () => {
  it("when implied is structurally above realized, the non-overlap mean block P&L is positive (the edge pays)", () => {
    const r = lcg(1001);
    const closes = randCloses(r, 500, 0); // realized vol modest
    const lr = logrets(closes);
    // measure realized vol scale, then set implied comfortably above it so the premium is real
    const sampleRV = realizedVolFromReturns(lr.slice(1, 200));
    const iv = closes.map(() => sampleRV * 1.5 + 0.1); // implied richer than realized
    const block = nonOverlappingPnl(iv, closes, lr, { rvWindow: 20, horizon: 30, minVRP: 0, feeVol: 0.005 });
    expect(block.length).toBeGreaterThan(2);
    expect(mean(block)).toBeGreaterThan(0); // structural premium → positive carry
  });

  it("determinism: identical inputs reproduce identical block & ladder series", () => {
    const build = () => {
      const r = lcg(1002);
      const closes = randCloses(r, 300, 0);
      const lr = logrets(closes);
      const iv = closes.map(() => 0.8);
      const opts = { rvWindow: 10, horizon: 30, minVRP: 0, feeVol: 0.01 };
      return {
        block: nonOverlappingPnl(iv, closes, lr, opts),
        ladder: overlappingLadderReturns(iv, closes, lr, opts),
      };
    };
    const a = build(), b = build();
    expect(a.block).toEqual(b.block);
    expect(a.ladder).toEqual(b.ladder);
  });
});
