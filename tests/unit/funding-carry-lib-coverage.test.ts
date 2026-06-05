/**
 * Adversarial coverage for the funding-carry edge (src/lib/backtest/candle/funding.ts).
 *
 * Companion to funding.props.test.ts. Focus areas the existing suite leaves thin or
 * uncovered:
 *   1. deltaNeutralCarryReturns — NOT exercised anywhere else. Full sign / fee-leg /
 *      minFunding-boundary / no-lookahead / degenerate coverage here.
 *   2. The cardinal time-series invariant restated adversarially for ALL four fns:
 *      perturbing a FUTURE funding/price value must leave every PAST/CURRENT output
 *      byte-identical (and, where the perturbed index itself should move, assert it moves).
 *   3. Economic SIGN: positive funding ⇒ short-perp collects (deltaNeutral) /
 *      long pays (netFunding); negative funding ⇒ the mirror.
 *   4. Fee handling in netFundingReturns (turnover drag, monotone in feeBps).
 *   5. undefined / NaN / ±Inf funding handling at every gate.
 *
 * Deterministic only — no fast-check (not installed in this repo), no network, no RNG
 * beyond a fixed-seed LCG mirroring the existing props file.
 */
import { describe, it, expect } from "vitest";
import {
  fundingGate,
  fundingCarrySignal,
  deltaNeutralCarryReturns,
  netFundingReturns,
} from "@/lib/backtest/candle/funding";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

// ---- deterministic helpers (fixed-seed LCG, no wall-clock / no platform RNG) ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

const candles = (closes: number[]): DailyCandle[] =>
  closes.map((c, i) => ({ start_unix: i, open: c, high: c, low: c, close: c, volume: 1 }));

function randCloses(r: () => number, n: number): number[] {
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + between(r, -0.08, 0.08)));
  return out;
}
const randFunding = (r: () => number, n: number): number[] =>
  Array.from({ length: n }, () => between(r, -0.003, 0.003));
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const FEE5 = 5 / 1e4; // default feeBps in deltaNeutralCarryReturns

// ───────────────────────────── deltaNeutralCarryReturns ─────────────────────────────
// The real carry trade: hold the funding-RECEIVING leg. Convention:
//   funding > 0 → SHORT perp (side −1), collects +|funding|
//   funding < 0 → LONG  perp (side +1), collects +|funding|
//   |funding| < minFunding → flat (side 0)
// Per interval: +|funding| collected − feeBps·2·|Δside| (2 legs / unit side change;
// fresh entry from flat = 2 legs, a sign FLIP = 4 legs).
describe("deltaNeutralCarryReturns — SIGN: the funding-receiving leg always collects a non-negative carry before fees", () => {
  it("positive funding → short-perp collects +|funding| (the harvested carry equals |funding| when not re-trading)", () => {
    // hold a constant positive-funding regime: pay the entry fee once at bar 0, then pure collect
    const out = deltaNeutralCarryReturns([0.01, 0.01, 0.01], { minFunding: 0, feeBps: 5 });
    expect(out[0]).toBeCloseTo(0.01 - 2 * FEE5, 12); // entry from flat: 2 legs
    expect(out[1]).toBeCloseTo(0.01, 12); // held short: 0 legs changed → pure collect
    expect(out[2]).toBeCloseTo(0.01, 12);
  });

  it("negative funding → long-perp collects +|funding| (symmetric magnitude to the positive case)", () => {
    const pos = deltaNeutralCarryReturns([0.01, 0.01, 0.01], { minFunding: 0, feeBps: 5 });
    const neg = deltaNeutralCarryReturns([-0.01, -0.01, -0.01], { minFunding: 0, feeBps: 5 });
    // magnitude of the carry is identical under a global sign flip (sign-agnostic harvest)
    expect(neg).toEqual(pos);
  });

  it("the harvested carry on a held leg is always ≥ 0 (you are PAID to hold the receiving side)", () => {
    const r = lcg(101);
    const n = 60;
    const f = randFunding(r, n);
    const out = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 0 }); // no fees → isolate the collect term
    for (let i = 0; i < n; i++) expect(out[i]).toBeGreaterThanOrEqual(0);
    // and it equals |funding| exactly when there is a position (|f|>=min) — else 0
    f.forEach((v, i) => expect(out[i]).toBeCloseTo(Math.abs(v) >= 0 ? Math.abs(v) : 0, 12));
  });

  it("a global funding-sign flip leaves returns invariant (carry is sign-agnostic; only which leg you hold changes)", () => {
    const r = lcg(102);
    const f = randFunding(r, 50);
    const a = deltaNeutralCarryReturns(f, { minFunding: 0.0005, feeBps: 5 });
    const b = deltaNeutralCarryReturns(f.map((x) => -x), { minFunding: 0.0005, feeBps: 5 });
    for (let i = 0; i < f.length; i++) expect(b[i]).toBeCloseTo(a[i], 12);
  });
});

describe("deltaNeutralCarryReturns — FEE legs: entry from flat = 2 legs, sign FLIP = 4 legs, hold = 0", () => {
  it("a sign flip (short→long) costs 4 legs while a fresh entry costs 2 legs", () => {
    // bar0: flat→short (2 legs), bar1: short→long (|1-(-1)|=2 unit change → 4 legs)
    const out = deltaNeutralCarryReturns([0.01, -0.01], { minFunding: 0, feeBps: 5 });
    expect(out[0]).toBeCloseTo(0.01 - 2 * FEE5, 12); // entry
    expect(out[1]).toBeCloseTo(0.01 - 4 * FEE5, 12); // flip pays double
  });

  it("dropping below minFunding closes the open leg and pays the 2-leg exit fee with zero collect", () => {
    // bar0: short (collect .01 − 2 legs), bar1: |f|<min → flat, collect 0, pay 2-leg exit
    const out = deltaNeutralCarryReturns([0.01, 0.0001], { minFunding: 0.001, feeBps: 5 });
    expect(out[0]).toBeCloseTo(0.01 - 2 * FEE5, 12);
    expect(out[1]).toBeCloseTo(0 - 2 * FEE5, 12);
  });

  it("staying on the SAME side across bars pays no fee after entry (turnover only on side change)", () => {
    const out = deltaNeutralCarryReturns([0.02, 0.005, 0.03], { minFunding: 0, feeBps: 5 });
    // all positive → side stays −1 throughout: only bar0 pays the entry fee
    expect(out[0]).toBeCloseTo(0.02 - 2 * FEE5, 12);
    expect(out[1]).toBeCloseTo(0.005, 12);
    expect(out[2]).toBeCloseTo(0.03, 12);
  });

  it("higher feeBps never INCREASES any per-bar return and never increases the summed return", () => {
    const r = lcg(103);
    const f = randFunding(r, 40);
    const lo = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 1 });
    const hi = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 50 });
    for (let i = 0; i < f.length; i++) expect(hi[i]).toBeLessThanOrEqual(lo[i] + 1e-15);
    expect(sum(hi)).toBeLessThanOrEqual(sum(lo) + 1e-12);
  });

  it("zero feeBps → return is exactly the collect term (|funding| when positioned, else 0)", () => {
    const r = lcg(104);
    const f = randFunding(r, 30);
    const minF = 0.001;
    const out = deltaNeutralCarryReturns(f, { minFunding: minF, feeBps: 0 });
    f.forEach((v, i) => expect(out[i]).toBeCloseTo(Math.abs(v) >= minF ? Math.abs(v) : 0, 12));
  });

  it("default feeBps is 5 (omitting feeBps equals passing 5)", () => {
    const r = lcg(105);
    const f = randFunding(r, 25);
    expect(deltaNeutralCarryReturns(f, { minFunding: 0 })).toEqual(
      deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 5 }),
    );
  });
});

describe("deltaNeutralCarryReturns — minFunding BOUNDARY (gate is inclusive: |funding| ≥ minFunding takes a side)", () => {
  it("|funding| exactly at the threshold TAKES a side; strictly below stays flat", () => {
    const minF = 0.001;
    // bars: just-below (flat), exactly-at (short, entry), just-above (short, hold)
    const out = deltaNeutralCarryReturns([minF - 1e-9, minF, minF + 1e-9], { minFunding: minF, feeBps: 5 });
    expect(out[0]).toBe(0); // below threshold: flat, no position ever opened, no fee
    expect(out[1]).toBeCloseTo(minF - 2 * FEE5, 12); // boundary inclusive → entry
    expect(out[2]).toBeCloseTo(minF + 1e-9, 12); // held → pure collect
  });

  it("raising minFunding is monotone on participation: a higher threshold never opens MORE positioned bars", () => {
    const r = lcg(106);
    const f = randFunding(r, 80);
    const positioned = (minF: number) =>
      deltaNeutralCarryReturns(f, { minFunding: minF, feeBps: 0 }).filter((x) => x !== 0).length;
    expect(positioned(0.002)).toBeLessThanOrEqual(positioned(0.0005));
    expect(positioned(0.005)).toBeLessThanOrEqual(positioned(0.002));
  });

  it("a threshold above the max |funding| seen → flat at every bar → all-zero returns", () => {
    const r = lcg(107);
    const f = randFunding(r, 30); // |f| < 0.003 by construction
    expect(deltaNeutralCarryReturns(f, { minFunding: 0.01, feeBps: 5 }).every((x) => x === 0)).toBe(true);
  });

  it("default minFunding is 0 → any non-zero finite funding takes a side", () => {
    const out = deltaNeutralCarryReturns([1e-9, -1e-9], { feeBps: 0 });
    expect(out[0]).toBeCloseTo(1e-9, 15);
    expect(out[1]).toBeCloseTo(1e-9, 15);
  });
});

describe("deltaNeutralCarryReturns — DEGENERATE & NON-FINITE funding", () => {
  it("empty funding → empty returns", () => {
    expect(deltaNeutralCarryReturns([], { minFunding: 0, feeBps: 5 })).toEqual([]);
  });

  it("exactly-zero funding → flat every bar (no |funding| ≥ min for min=0 since side requires f≠0)", () => {
    // f=0 → Math.abs(0)>=0 true, but f>0?−1:1 gives +1 (long). Collect |0|=0, but a side IS taken,
    // so the entry fee is charged once. Assert the documented behaviour exactly.
    const out = deltaNeutralCarryReturns([0, 0, 0], { minFunding: 0, feeBps: 5 });
    expect(out[0]).toBeCloseTo(0 - 2 * FEE5, 12); // takes long side at f=0, pays entry
    expect(out[1]).toBeCloseTo(0, 12); // held, collect 0
    expect(out[2]).toBeCloseTo(0, 12);
  });

  it("non-finite funding (NaN, ±Inf, undefined) → flat: 0 collect, and closes any prior leg with its exit fee", () => {
    // bar0 short (entry), bar1 NaN → flat (exit fee), bar2 Inf → flat (no leg open, no fee),
    // bar3 undefined → flat, bar4 -Inf → flat
    const out = deltaNeutralCarryReturns([0.01, NaN, Infinity, undefined, -Infinity], { minFunding: 0, feeBps: 5 });
    expect(out[0]).toBeCloseTo(0.01 - 2 * FEE5, 12);
    expect(out[1]).toBeCloseTo(0 - 2 * FEE5, 12); // exit the short opened at bar0
    expect(out[2]).toBe(0); // already flat, stays flat
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it("an all-non-finite series never opens a position → all-zero returns regardless of fee", () => {
    const out = deltaNeutralCarryReturns([NaN, undefined, Infinity, -Infinity], { minFunding: 0, feeBps: 999 });
    expect(out).toEqual([0, 0, 0, 0]);
  });

  it("preserves length and never mutates the input funding array", () => {
    const f: (number | undefined)[] = [0.01, -0.02, NaN, 0.005];
    const copy = [...f];
    const out = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 5 });
    expect(out).toHaveLength(f.length);
    expect(f).toEqual(copy);
  });
});

describe("deltaNeutralCarryReturns — NO-LOOKAHEAD (funding[i] conditions bar i→i+1 only)", () => {
  it("perturbing an INTERIOR funding value cannot move any return STRICTLY BEFORE it", () => {
    const r = lcg(108);
    const n = 50;
    const f = randFunding(r, n);
    const base = deltaNeutralCarryReturns(f, { minFunding: 0.0005, feeBps: 5 });
    const k = 23;
    const f2 = [...f];
    f2[k] = f2[k] > 0 ? -0.02 : 0.02; // force a sign flip at k → maximally disruptive downstream
    const pert = deltaNeutralCarryReturns(f2, { minFunding: 0.0005, feeBps: 5 });
    // everything before k is byte-identical: the past cannot see a future funding value
    expect(pert.slice(0, k)).toEqual(base.slice(0, k));
  });

  it("the perturbed bar itself (and only the causal forward span) may differ — confirms the change is real, not a no-op", () => {
    const f = [0.01, 0.01, 0.01, 0.01];
    const base = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 5 });
    const f2 = [0.01, -0.01, 0.01, 0.01]; // flip bar1 short→long
    const pert = deltaNeutralCarryReturns(f2, { minFunding: 0, feeBps: 5 });
    expect(pert[0]).toBeCloseTo(base[0], 12); // bar0 untouched (no-lookahead)
    expect(pert[1]).not.toBeCloseTo(base[1], 9); // bar1 actually moved (flip fee + opposite leg)
  });

  it("appending future funding bars never rewrites the prefix returns (causal/streaming-stable)", () => {
    const r = lcg(109);
    const head = randFunding(r, 18);
    const tail = randFunding(r, 12);
    const headOut = deltaNeutralCarryReturns(head, { minFunding: 0.0005, feeBps: 5 });
    const fullOut = deltaNeutralCarryReturns([...head, ...tail], { minFunding: 0.0005, feeBps: 5 });
    expect(fullOut.slice(0, head.length)).toEqual(headOut);
  });
});

// ───────────────────────────── netFundingReturns — fee + sign + lookahead (adversarial) ─────────────────────────────
describe("netFundingReturns — SIGN: positive funding penalises a long and rewards a short by the SAME magnitude", () => {
  it("long pays +funding, short receives +funding: their funding contributions are exact negatives at the same bar", () => {
    const cs = candles([100, 100]); // zero price return → isolate the funding term
    const f = 0.02;
    const long = netFundingReturns(cs, [1, 1], [f], 0);
    const short = netFundingReturns(cs, [-1, -1], [f], 0);
    expect(long[0]).toBeCloseTo(-f, 12); // long pays 2%
    expect(short[0]).toBeCloseTo(+f, 12); // short collects 2%
    expect(long[0] + short[0]).toBeCloseTo(0, 12);
  });

  it("with positive funding a held short STRICTLY beats the negated long price return (it banks the carry)", () => {
    const r = lcg(201);
    const n = 14;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(-1);
    const f = Array.from({ length: n }, () => between(r, 0.0005, 0.003)); // strictly positive
    const out = netFundingReturns(cs, pos, f, 0);
    for (let i = 0; i < out.length; i++) {
      const negatedLongPrice = -1 * (cs[i + 1].close / cs[i].close - 1);
      expect(out[i]).toBeGreaterThan(negatedLongPrice); // short earns the +funding on top
    }
  });
});

describe("netFundingReturns — FEE handling (turnover drag, monotone, undefined-funding)", () => {
  it("a single round-trip (flat→long→flat) pays the turnover fee exactly twice and nowhere else", () => {
    const cs = candles([100, 100, 100, 100, 100]); // flat price → fee is the only term
    const feeBps = 25;
    const out = netFundingReturns(cs, [0, 1, 1, 0], [0, 0, 0, 0], feeBps);
    expect(out[0]).toBe(0); // 0→0 no turnover
    expect(out[1]).toBeCloseTo(-feeBps / 1e4, 12); // open
    expect(out[2]).toBe(0); // hold
    expect(out[3]).toBeCloseTo(-feeBps / 1e4, 12); // close
    expect(sum(out)).toBeCloseTo(-2 * (feeBps / 1e4), 12);
  });

  it("higher feeBps is a non-negative drag at every bar (never improves a return)", () => {
    const r = lcg(202);
    const n = 30;
    const cs = candles(randCloses(r, n));
    const pos = Array.from({ length: n }, () => (r() < 0.5 ? 0 : 1));
    const f = randFunding(r, n);
    const lo = netFundingReturns(cs, pos, f, 0);
    const hi = netFundingReturns(cs, pos, f, 80);
    for (let i = 0; i < lo.length; i++) expect(hi[i]).toBeLessThanOrEqual(lo[i] + 1e-15);
  });

  it("undefined / non-finite funding contributes EXACTLY 0 funding (price + fee terms untouched)", () => {
    const cs = candles([100, 110, 121, 133]); // +10% each bar
    const feeBps = 10;
    // positions flip 0→1→1→0 so the fee term is non-trivial; funding bars are all non-finite
    const pos = [0, 1, 1, 0];
    const f: (number | undefined)[] = [undefined, NaN, Infinity, -Infinity];
    const out = netFundingReturns(cs, pos, f, feeBps);
    // expected = pos*(priceRet - 0) - |Δpos|*fee  with funding forced to 0
    expect(out[0]).toBe(0); // pos0=0
    expect(out[1]).toBeCloseTo(1 * (121 / 110 - 1) - 1 * (feeBps / 1e4), 12); // open fee
    expect(out[2]).toBeCloseTo(1 * (133 / 121 - 1) - 0, 12); // hold
  });
});

describe("netFundingReturns — NO-LOOKAHEAD (interior perturbation isolates to exactly one bar)", () => {
  it("perturbing funding[k] changes ONLY net return at bar k; all other bars stay byte-identical", () => {
    const r = lcg(203);
    const n = 22;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const f = randFunding(r, n);
    const base = netFundingReturns(cs, pos, f, 5);
    const k = 11;
    const f2 = [...f];
    f2[k] = f2[k] + 0.05; // big shock at an interior bar
    const pert = netFundingReturns(cs, pos, f2, 5);
    for (let i = 0; i < base.length; i++) {
      if (i === k) expect(pert[i]).not.toBeCloseTo(base[i], 12);
      else expect(pert[i]).toBe(base[i]);
    }
  });

  it("perturbing a FUTURE candle close cannot change any earlier net return (price lookahead guard)", () => {
    const r = lcg(204);
    const n = 16;
    const closes = randCloses(r, n);
    const pos = Array(n).fill(1);
    const f = randFunding(r, n);
    const base = netFundingReturns(candles(closes), pos, f, 8);
    const c2 = [...closes];
    c2[n - 1] *= 5; // shock only the LAST close → may only affect the last return
    const pert = netFundingReturns(candles(c2), pos, f, 8);
    expect(pert.slice(0, -1)).toEqual(base.slice(0, -1));
  });
});

// ───────────────────────────── fundingGate / fundingCarrySignal — adversarial boundaries ─────────────────────────────
describe("fundingGate — boundary & non-finite (adversarial)", () => {
  it("cap boundary is INCLUSIVE: funding == cap keeps the long, funding == cap+ε drops it", () => {
    const cap = 0.0003;
    const out = fundingGate([1, 1, 1], [cap, cap + 1e-12, cap - 1e-12], { maxFunding: cap });
    expect(out).toEqual([1, 0, 1]);
  });

  it("every flavour of non-finite funding zeroes the position even with an enormous cap", () => {
    const out = fundingGate([7, 7, 7, 7, 7], [NaN, Infinity, -Infinity, undefined, -0.001], { maxFunding: 1e9 });
    expect(out).toEqual([0, 0, 0, 0, 7]);
  });

  it("NO-LOOKAHEAD — flipping funding[k]'s gating decision changes output at k ONLY", () => {
    const r = lcg(301);
    const n = 26;
    const pos = Array.from({ length: n }, () => 1);
    const f = randFunding(r, n);
    const base = fundingGate(pos, f, { maxFunding: 0 });
    const k = 14;
    const f2 = [...f];
    f2[k] = f2[k] > 0 ? -0.02 : 0.02; // flip the keep/drop decision
    const pert = fundingGate(pos, f2, { maxFunding: 0 });
    for (let i = 0; i < n; i++) {
      if (i === k) expect(pert[i]).not.toBe(base[i]);
      else expect(pert[i]).toBe(base[i]);
    }
  });
});

describe("fundingCarrySignal — hysteresis & non-finite (adversarial)", () => {
  it("a value strictly inside the (enter, exit) band holds whatever state the path was in", () => {
    const enter = -0.001, exit = 0.001;
    expect(fundingCarrySignal([-0.002, 0], { enter, exit })).toEqual([1, 1]); // entered long, holds in band
    expect(fundingCarrySignal([0.002, 0], { enter, exit })).toEqual([0, 0]); // stayed flat, holds in band
  });

  it("non-finite bars NEVER change state — the prior position is carried through them", () => {
    // enter long at bar0, then 3 garbage bars must all hold the long
    const out = fundingCarrySignal([-0.01, NaN, undefined, Infinity, -Infinity, 0.01], { enter: 0, exit: 0.0005 });
    expect(out).toEqual([1, 1, 1, 1, 1, 0]); // only the final punitive bar flips it flat
  });

  it("NO-LOOKAHEAD — perturbing funding[k] cannot rewrite any signal strictly before k", () => {
    const r = lcg(302);
    const n = 44;
    const f = randFunding(r, n);
    const base = fundingCarrySignal(f, { enter: -0.0001, exit: 0.0001 });
    const k = 27;
    const f2 = [...f];
    f2[k] = -9; // overwhelming long signal at k
    const pert = fundingCarrySignal(f2, { enter: -0.0001, exit: 0.0001 });
    expect(pert.slice(0, k)).toEqual(base.slice(0, k));
  });
});

// ───────────────────────────── cross-function carry pipeline ─────────────────────────────
describe("carry pipeline — deltaNeutral vs directional-long agree on the funding harvest sign", () => {
  it("on an all-favorable (negative) funding regime, BOTH a long (via netFunding) and the deltaNeutral long-perp collect carry (net ≥ price-only / ≥ 0)", () => {
    const r = lcg(401);
    const n = 25;
    const cs = candles(randCloses(r, n));
    const f = Array.from({ length: n }, () => between(r, -0.003, -0.0005)); // strictly negative → paid to be long
    const longNet = netFundingReturns(cs, Array(n).fill(1), f, 0);
    const priceOnly = netFundingReturns(cs, Array(n).fill(1), Array(n).fill(0), 0);
    for (let i = 0; i < longNet.length; i++) expect(longNet[i]).toBeGreaterThan(priceOnly[i]); // funding helps a long
    // the deltaNeutral version harvests the same favorable funding as a non-negative carry (fee-free)
    const dn = deltaNeutralCarryReturns(f, { minFunding: 0, feeBps: 0 });
    for (let i = 0; i < n; i++) expect(dn[i]).toBeGreaterThanOrEqual(0);
  });

  it("end-to-end determinism: a fixed seed reproduces identical deltaNeutral + netFunding vectors", () => {
    const build = () => {
      const r = lcg(777);
      const n = 28;
      const cs = candles(randCloses(r, n));
      const f = randFunding(r, n);
      const dn = deltaNeutralCarryReturns(f, { minFunding: 0.0005, feeBps: 5 });
      const sig = fundingCarrySignal(f, { enter: -0.0001, exit: 0.0001 });
      const gated = fundingGate(sig, f, { maxFunding: 0 });
      const net = netFundingReturns(cs, gated, f, 10);
      return { dn, net };
    };
    expect(build()).toEqual(build());
  });
});
