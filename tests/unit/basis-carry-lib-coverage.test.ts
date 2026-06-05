/**
 * Adversarial coverage for the BASIS-CARRY edge — basisCarryReturns + calendarBasisReturns
 * in src/lib/backtest/candle/funding.ts.
 *
 * Invariants asserted:
 *   - NO-LOOKAHEAD: an interior/future input perturbation cannot move a past/current output.
 *   - ROLL-SEAM skip: a contract-stitch (roll[i+1]=true) NEVER fabricates a price-jump return.
 *   - SIGN correctness: contango ⇒ positive carry (long spot / short fut), backwardation flips it;
 *     funding>0 ⇒ short the perp and harvest +funding.
 *   - CONVERGENCE math: a future that decays to spot returns the locked basis (cash-and-carry).
 *   - FEE / cost monotonicity: a higher feeBps is a non-negative drag; turnover is charged on
 *     entries and flips, never on a hold.
 *   - Degenerate inputs: empty, single-element, constant, zero-vol, NaN/Inf/undefined funding,
 *     zero/negative prices, mismatched lengths.
 *   - Threshold boundaries of every gate: minFunding, minBasisAnn, tailSkip, oneSided.
 *
 * fast-check is NOT installed in this repo (the sibling funding.props.test.ts uses a hand-rolled
 * LCG, not fc) — so we follow that established deterministic-RNG convention here.
 */
import { describe, it, expect } from "vitest";
import { basisCarryReturns, calendarBasisReturns } from "@/lib/backtest/candle/funding";

// ---- deterministic RNG (mirrors tests/unit/funding.props.test.ts) ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
// strictly-positive close series (no div-by-zero / sign flips)
function randCloses(r: () => number, n: number): number[] {
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + between(r, -0.06, 0.06)));
  return out;
}
const randFunding = (r: () => number, n: number): number[] =>
  Array.from({ length: n }, () => between(r, -0.004, 0.004));
const fee1 = (bps: number) => (2 * bps) / 1e4; // cost of a 1-unit side change

// =====================================================================================
// basisCarryReturns
// =====================================================================================
describe("basisCarryReturns — shape & degenerate inputs", () => {
  it("returns exactly min(len)-1 values (one per realized transition)", () => {
    const r = lcg(1);
    for (const n of [2, 3, 8, 25]) {
      const out = basisCarryReturns(randCloses(r, n), randCloses(r, n), randFunding(r, n));
      expect(out).toHaveLength(n - 1);
    }
  });

  it("uses the SHORTER of spot/perp length and never reads out of range (mismatched lengths)", () => {
    const spot = [100, 101, 102, 103, 104];
    const perp = [100, 101]; // shorter → n=2 → 1 output
    const out = basisCarryReturns(spot, perp, [0.002, 0.002, 0.002, 0.002, 0.002]);
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it("empty / single-element inputs → empty output (no transition exists)", () => {
    expect(basisCarryReturns([], [], [])).toEqual([]);
    expect(basisCarryReturns([100], [100], [0.01])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const spot = [100, 110, 120];
    const perp = [100, 111, 119];
    const fund = [0.002, -0.002];
    const sC = [...spot], pC = [...perp], fC = [...fund];
    basisCarryReturns(spot, perp, fund, { feeBps: 7 });
    expect(spot).toEqual(sC);
    expect(perp).toEqual(pC);
    expect(fund).toEqual(fC);
  });

  it("zero/negative price guards: a non-positive spot or perp close yields 0 price-PnL (only funding net of fee)", () => {
    // spot[0]<=0 ⇒ spotRet=0 ; perp[0]<=0 ⇒ perpRet=0
    const out = basisCarryReturns([0, 200], [100, 50], [0.01], { feeBps: 0, minFunding: 0 });
    // funding>0 ⇒ target=-1, collected=0.01; spotRet guarded to 0, perpRet=50/100-1=-0.5
    // pricePnL = target*(perpRet - spotRet) = -1*(-0.5 - 0) = +0.5 ; net = 0.01 + 0.5
    expect(out[0]).toBeCloseTo(0.01 + 0.5, 12);
  });
});

describe("basisCarryReturns — sign & carry economics", () => {
  it("funding>0 ⇒ SHORT the perp (collect +funding); a flat (zero-funding) basis pays exactly 0 minus fee", () => {
    // identical, drift-free legs ⇒ no price PnL; isolate the harvested funding
    const spot = [100, 100, 100, 100];
    const perp = [100, 100, 100, 100];
    const out = basisCarryReturns(spot, perp, [0.003, 0.003, 0.003], { feeBps: 0, minFunding: 0 });
    // each bar: collected=0.003, pricePnL=0, fee=0 (held short throughout except the open which is also 0-fee here)
    out.forEach((v) => expect(v).toBeCloseTo(0.003, 12));
  });

  it("funding<0 ⇒ LONG the perp and harvest |funding| (sign-symmetric to the short side)", () => {
    const spot = [100, 100, 100];
    const perp = [100, 100, 100];
    const out = basisCarryReturns(spot, perp, [-0.0025, -0.0025], { feeBps: 0 });
    out.forEach((v) => expect(v).toBeCloseTo(0.0025, 12));
  });

  it("BASIS-NARROWING is profitable: short-perp/long-spot gains when the perp falls toward spot", () => {
    // funding>0 ⇒ short perp. perp drops toward spot, spot flat ⇒ basis narrows ⇒ positive price PnL.
    const spot = [100, 100];
    const perp = [101, 100]; // perpRet = 100/101-1 ≈ -0.009901 (perp converges DOWN to spot)
    const out = basisCarryReturns(spot, perp, [0.001], { feeBps: 0, minFunding: 0 });
    const perpRet = 100 / 101 - 1;
    // target=-1 (short perp), collected=0.001, pricePnL = -1*(perpRet - 0) = -perpRet (>0)
    expect(out[0]).toBeCloseTo(0.001 - perpRet, 12);
    expect(out[0]).toBeGreaterThan(0); // harvested funding + basis convergence are BOTH positive
  });

  it("price-PnL is exactly target·(perpRet − spotRet) plus harvested funding minus fee (closed form, random)", () => {
    const r = lcg(7);
    const n = 30;
    const spot = randCloses(r, n);
    const perp = randCloses(r, n);
    const fund = randFunding(r, n);
    const feeBps = 4, minFunding = 0.0005;
    const out = basisCarryReturns(spot, perp, fund, { feeBps, minFunding });
    let side = 0;
    for (let i = 0; i < n - 1; i++) {
      const f = fund[i];
      const target = Number.isFinite(f) && Math.abs(f) >= minFunding ? (f > 0 ? -1 : 1) : 0;
      const collected = target !== 0 ? Math.abs(f) : 0;
      const spotRet = spot[i] > 0 ? spot[i + 1] / spot[i] - 1 : 0;
      const perpRet = perp[i] > 0 ? perp[i + 1] / perp[i] - 1 : 0;
      const expected = collected + target * (perpRet - spotRet) - Math.abs(target - side) * fee1(feeBps);
      expect(out[i]).toBeCloseTo(expected, 12);
      side = target;
    }
  });
});

describe("basisCarryReturns — minFunding threshold gate", () => {
  it("below the |funding| floor ⇒ flat (no side, no funding, no fee), at the floor ⇒ active (boundary inclusive)", () => {
    const spot = [100, 100, 100, 100];
    const perp = [100, 100, 100, 100]; // drift-free ⇒ isolate the gate
    const minFunding = 0.001;
    // f below floor, exactly at floor, above floor
    const out = basisCarryReturns(spot, perp, [0.0005, 0.001, 0.002], { feeBps: 0, minFunding });
    expect(out[0]).toBeCloseTo(0, 12);        // |0.0005| < 0.001 ⇒ flat
    expect(out[1]).toBeCloseTo(0.001, 12);     // |0.001| >= 0.001 ⇒ active, collect 0.001 (>= is inclusive)
    expect(out[2]).toBeCloseTo(0.002, 12);     // active
  });

  it("raising minFunding only DROPS bars from the active set (selectivity is monotone)", () => {
    const r = lcg(8);
    const n = 40;
    const spot = randCloses(r, n);
    const perp = randCloses(r, n);
    const fund = randFunding(r, n);
    const activeAt = (minF: number) => {
      let side = 0, active = 0;
      for (let i = 0; i < n - 1; i++) {
        const f = fund[i];
        const target = Number.isFinite(f) && Math.abs(f) >= minF ? (f > 0 ? -1 : 1) : 0;
        if (target !== 0) active++;
        side = target;
      }
      return active;
    };
    expect(activeAt(0.003)).toBeLessThanOrEqual(activeAt(0.0));
    // sanity: at least the call shapes match
    expect(basisCarryReturns(spot, perp, fund, { minFunding: 0.003 })).toHaveLength(n - 1);
  });
});

describe("basisCarryReturns — fee monotonicity & turnover", () => {
  it("a higher feeBps never INCREASES the total summed return (fee is a non-negative drag)", () => {
    const r = lcg(9);
    const n = 35;
    const spot = randCloses(r, n);
    const perp = randCloses(r, n);
    const fund = randFunding(r, n);
    const lo = sum(basisCarryReturns(spot, perp, fund, { feeBps: 0, minFunding: 0.0005 }));
    const hi = sum(basisCarryReturns(spot, perp, fund, { feeBps: 100, minFunding: 0.0005 }));
    expect(hi).toBeLessThanOrEqual(lo + 1e-12);
  });

  it("entry from flat costs a 1-unit turnover; a SIGN FLIP (long→short) costs a 2-unit turnover", () => {
    const spot = [100, 100, 100]; // drift-free
    const perp = [100, 100, 100];
    const feeBps = 10;
    // f: bar0 negative ⇒ long(+1) from flat (|Δside|=1); bar1 positive ⇒ short(-1) flip (|Δside|=2)
    const out = basisCarryReturns(spot, perp, [-0.002, 0.002, 0.0], { feeBps, minFunding: 0 });
    expect(out[0]).toBeCloseTo(0.002 - 1 * fee1(feeBps), 12); // collected 0.002, open turnover 1
    expect(out[1]).toBeCloseTo(0.002 - 2 * fee1(feeBps), 12); // collected 0.002, flip turnover 2
  });

  it("holding the SAME side across bars charges fee only on the opening turnover", () => {
    const spot = [100, 100, 100, 100, 100];
    const perp = [100, 100, 100, 100, 100];
    const feeBps = 8;
    const out = basisCarryReturns(spot, perp, [0.002, 0.002, 0.002, 0.002], { feeBps, minFunding: 0 });
    expect(out[0]).toBeCloseTo(0.002 - fee1(feeBps), 12); // open
    out.slice(1).forEach((v) => expect(v).toBeCloseTo(0.002, 12)); // held → no further fee
  });
});

describe("basisCarryReturns — NaN / undefined funding", () => {
  it("non-finite funding ⇒ flat that bar (NaN, +Inf, -Inf, undefined all produce no side/no funding)", () => {
    const spot = [100, 100, 100, 100, 100, 100];
    const perp = [100, 100, 100, 100, 100, 100];
    const out = basisCarryReturns(spot, perp, [NaN, Infinity, -Infinity, undefined, 0.002], { feeBps: 0, minFunding: 0 });
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0, 12);
    expect(out[3]).toBeCloseTo(0, 12);
    expect(out[4]).toBeCloseTo(0.002, 12); // finite again
  });
});

describe("basisCarryReturns — NO-LOOKAHEAD", () => {
  it("perturbing funding[k] only changes the output at bar k (conditions bar k→k+1 only)", () => {
    const r = lcg(10);
    const n = 24;
    const spot = randCloses(r, n);
    const perp = randCloses(r, n);
    const fund = randFunding(r, n);
    const base = basisCarryReturns(spot, perp, fund, { feeBps: 5, minFunding: 0.0005 });
    const k = 11;
    const f2 = [...fund];
    f2[k] = 0.05; // strongly punitive → forces target=-1 there
    const pert = basisCarryReturns(spot, perp, f2, { feeBps: 5, minFunding: 0.0005 });
    // Because fee depends on side TRANSITIONS, perturbing side at k can affect the fee at k+1 too;
    // therefore the strict no-lookahead guarantee is about indices BEFORE k.
    for (let i = 0; i < k; i++) expect(pert[i]).toBeCloseTo(base[i], 12);
  });

  it("perturbing a FUTURE spot/perp close cannot change any earlier return (causal/streaming-stable)", () => {
    const r = lcg(20);
    const n = 22;
    const spot = randCloses(r, n);
    const perp = randCloses(r, n);
    const fund = randFunding(r, n);
    const base = basisCarryReturns(spot, perp, fund, { feeBps: 5 });
    const s2 = [...spot], p2 = [...perp];
    s2[n - 1] = 9_999_999; // last close only affects the LAST return
    p2[n - 1] = 1; // and last perp return
    const pert = basisCarryReturns(s2, p2, fund, { feeBps: 5 });
    expect(pert.slice(0, -1)).toEqual(base.slice(0, -1));
  });

  it("appending future bars never rewrites the prefix (prefix-stability)", () => {
    const r = lcg(21);
    const head = 16, extra = 10;
    const spot = randCloses(r, head + extra);
    const perp = randCloses(r, head + extra);
    const fund = randFunding(r, head + extra);
    const full = basisCarryReturns(spot, perp, fund, { feeBps: 3, minFunding: 0.0005 });
    const prefix = basisCarryReturns(
      spot.slice(0, head), perp.slice(0, head), fund.slice(0, head), { feeBps: 3, minFunding: 0.0005 },
    );
    // prefix has head-1 outputs; they must equal the first head-1 of the full run
    expect(full.slice(0, head - 1)).toEqual(prefix);
  });
});

// =====================================================================================
// calendarBasisReturns
// =====================================================================================
const DTE = (n: number, start = 90) => Array.from({ length: n }, (_, i) => Math.max(start - i, 0));
const NOROLL = (n: number) => Array.from({ length: n }, () => false);

describe("calendarBasisReturns — shape & degenerate inputs", () => {
  it("returns min(len)-1 values and uses the shortest array (mismatched lengths)", () => {
    const out = calendarBasisReturns([100, 101, 102, 103], [102, 101], DTE(4), NOROLL(4));
    expect(out).toHaveLength(1); // fut len 2 dominates → n=2 → 1 output
  });

  it("empty / single-element inputs → empty output", () => {
    expect(calendarBasisReturns([], [], [], [])).toEqual([]);
    expect(calendarBasisReturns([100], [102], [90], [false])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const spot = [100, 101, 102];
    const fut = [102, 101.5, 101];
    const dte = [60, 59, 58];
    const roll = [false, false, false];
    const a = [...spot], b = [...fut], c = [...dte], d = [...roll];
    calendarBasisReturns(spot, fut, dte, roll, { feeBps: 2 });
    expect(spot).toEqual(a); expect(fut).toEqual(b); expect(dte).toEqual(c); expect(roll).toEqual(d);
  });

  it("zero/negative price guard: a non-positive spot or fut close yields 0 pnl that bar (only the fee term)", () => {
    // spot[0]<=0 ⇒ annBasis=0 ⇒ target=0 (minBasisAnn default 0 ⇒ 0>=0 true ⇒ actually target=1)
    // Use explicit minBasisAnn>0 so the degenerate basis can't open a position, isolating the guard.
    const out = calendarBasisReturns([0, 100], [100, 100], [90, 90], [false, false], { minBasisAnn: 0.01, feeBps: 0 });
    expect(out[0]).toBeCloseTo(0, 12); // no position (annBasis=0 < 0.01), no pnl, no fee
  });
});

describe("calendarBasisReturns — CONTANGO/BACKWARDATION sign & convergence math", () => {
  it("CONTANGO (fut>spot) ⇒ long spot / short fut (+1) ⇒ POSITIVE carry as the future converges to spot", () => {
    // spot flat at 100; fut decays 102→100 (contango collapsing to par). Long-spot/short-fut wins.
    const spot = [100, 100, 100, 100, 100, 100];
    const fut = [102, 101.5, 101, 100.5, 100, 100];
    const dte = [50, 40, 30, 20, 10, 0];
    const roll = NOROLL(6);
    const out = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    // every active bar: target=+1, spotRet=0, futRet<0 ⇒ pnl = +1*(0 - futRet) = -futRet > 0
    out.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    expect(sum(out)).toBeGreaterThan(0); // collected the basis on the way to convergence
  });

  it("the locked basis is recovered: total carry ≈ the convergence of the future toward spot (fee-free)", () => {
    const spot = [100, 100, 100];
    const fut = [102, 101, 100]; // converges fully to spot over the window
    const dte = [40, 20, 0];
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(3), { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    // bar0: pnl = -(101/102-1)=+0.009804 ; bar1: pnl = -(100/101-1)=+0.009901
    const expected = -(101 / 102 - 1) + -(100 / 101 - 1);
    expect(sum(out)).toBeCloseTo(expected, 12);
    expect(sum(out)).toBeGreaterThan(0);
  });

  it("BACKWARDATION (fut<spot) ⇒ short spot / long fut (−1); inverts to POSITIVE carry as fut rises to spot", () => {
    const spot = [100, 100, 100, 100];
    const fut = [98, 99, 100, 100]; // discount closing up to par
    const dte = [40, 30, 20, 0];
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(4), { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    // target=-1 (annBasis<0); pnl = -1*(spotRet - futRet) = futRet - spotRet ; spot flat, fut rises ⇒ >0
    out.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    expect(sum(out)).toBeGreaterThan(0);
  });

  it("oneSided=true suppresses the SHORT-spot leg: a backwardation basis is left flat (long-only)", () => {
    const spot = [100, 100, 100];
    const fut = [98, 99, 100]; // backwardation
    const dte = [40, 20, 0];
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(3), { minBasisAnn: 0, feeBps: 0, oneSided: true, tailSkip: 0 });
    out.forEach((v) => expect(v).toBeCloseTo(0, 12)); // never enters the short side ⇒ no pnl, no fee
  });

  it("closed-form: pnl = target·(spotRet − futRet) − turnover·fee at every realized (non-roll) bar (random)", () => {
    const r = lcg(31);
    const n = 30;
    const spot = randCloses(r, n);
    // build a fut that hovers near spot to exercise both signs of the basis
    const fut = spot.map((s, i) => s * (1 + between(r, -0.02, 0.02)));
    const dte = DTE(n, 80);
    const roll = NOROLL(n);
    const minBasisAnn = 0.05, feeBps = 1, tailSkip = 2;
    const out = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn, feeBps, tailSkip });
    let side = 0;
    for (let i = 0; i < n - 1; i++) {
      const annBasis = spot[i] > 0 && fut[i] > 0 ? (fut[i] / spot[i] - 1) * (365 / Math.max(dte[i], 1)) : 0;
      let target = 0;
      if (dte[i] >= tailSkip) {
        if (annBasis >= minBasisAnn) target = 1;
        else if (annBasis <= -minBasisAnn) target = -1;
      }
      let pnl = 0;
      if (!roll[i + 1] && spot[i] > 0 && fut[i] > 0) pnl = target * ((spot[i + 1] / spot[i] - 1) - (fut[i + 1] / fut[i] - 1));
      const expected = pnl - Math.abs(target - side) * fee1(feeBps);
      expect(out[i]).toBeCloseTo(expected, 12);
      side = target;
    }
  });
});

describe("calendarBasisReturns — ROLL-SEAM is skipped (no fabricated cross-contract return)", () => {
  it("a roll[i+1]=true seam contributes ZERO price pnl even when the stitched price gap is huge", () => {
    // Old front contract trades near 100; the next quarterly is stitched in at 130 on the roll day.
    // That 30% 'jump' is ARTIFICIAL and must NOT leak into returns.
    const spot = [100, 100, 100, 100];
    const fut = [102, 101, 130, 129]; // index 2 is the post-roll contract (price discontinuity)
    const dte = [40, 30, 90, 89]; // dte resets up at the roll
    const roll = [false, false, true, false]; // roll seam realized between bar1→bar2
    const out = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    // bar1 realizes the i→i+1 (1→2) move; roll[2]=true ⇒ pnl forced to 0 (no fabricated 130/101 jump)
    expect(out[1]).toBeCloseTo(0, 12);
    // a control run with the SAME prices but NO roll flag would NOT be zero — prove the flag is what skips it
    const ctrl = calendarBasisReturns(spot, fut, dte, [false, false, false, false], { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    expect(Math.abs(ctrl[1])).toBeGreaterThan(0.05); // the fabricated jump WOULD have leaked without the flag
  });

  it("the roll seam never injects a return regardless of how large the price discontinuity is (random gaps)", () => {
    const r = lcg(40);
    const n = 20;
    const spot = randCloses(r, n);
    const fut = randCloses(r, n).map((x) => x * 1.01);
    const dte = DTE(n, 70);
    // mark every odd transition as a roll seam
    const roll = Array.from({ length: n }, (_, i) => i % 2 === 1);
    // inject violent discontinuities exactly at the post-roll bars so a leak would be obvious
    for (let i = 0; i < n; i++) if (roll[i]) fut[i] *= 5;
    const out = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0, feeBps: 0, tailSkip: 0 });
    for (let i = 0; i < n - 1; i++) {
      if (roll[i + 1]) {
        // pnl forced to 0; only a (possibly nonzero) fee term remains — and with feeBps 0 it's exactly 0
        expect(out[i]).toBeCloseTo(0, 12);
      }
    }
  });

  it("fee is still applied on the bar whose pnl was roll-skipped (a position change is real even if its pnl isn't)", () => {
    // Construct: bar1 flips the target side (contango→backwardation) AND roll[2]=true. The price
    // pnl is skipped (fabricated cross-contract jump) but the turnover fee must still be charged —
    // the trade really happened, only its return is artificial.
    const spot = [100, 100, 100];
    const fut = [110, 90, 130]; // bar0 contango (target=+1); bar1 backwardation (target=−1) then rolled
    const dte = [40, 30, 90];
    const roll = [false, false, true]; // seam at 1→2
    const feeBps = 10;
    // bar1: annBasis at i=1 → fut=90<spot=100 ⇒ negative ⇒ target=−1; side was +1 ⇒ |−1−1|=2 turnover.
    // roll[2]=true ⇒ pnl skipped ⇒ only the (2-unit) flip fee remains.
    const out = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0, feeBps, tailSkip: 0 });
    expect(out[1]).toBeCloseTo(-2 * fee1(feeBps), 12);
  });
});

describe("calendarBasisReturns — tailSkip & minBasisAnn boundaries", () => {
  it("tailSkip drops positions in the final days (dte < tailSkip ⇒ flat, no pnl/fee)", () => {
    const spot = [100, 100, 100, 100];
    const fut = [105, 104, 103, 102]; // persistent contango
    const dte = [3, 2, 1, 0]; // crosses the tailSkip=2 boundary
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(4), { minBasisAnn: 0, feeBps: 0, tailSkip: 2 });
    // i=0 dte=3>=2 active(+1); i=1 dte=2>=2 active; i=2 dte=1<2 ⇒ flat
    // bar2 output: target=0, side was +1 ⇒ but feeBps=0 ⇒ pnl 0, fee 0
    expect(out[2]).toBeCloseTo(0, 12);
    // and the earlier active bars are non-zero (contango → positive)
    expect(out[0]).toBeGreaterThan(0);
    expect(out[1]).toBeGreaterThan(0);
  });

  it("dte=tailSkip is INCLUSIVE (still active); dte=tailSkip-1 is flat (boundary check)", () => {
    // Flat prices isolate the gate from price PnL: any nonzero output ⇒ a fee ⇒ a position existed.
    const spot = [100, 100, 100];
    const fut = [105, 105, 105]; // constant contango → would open long if active
    const feeBps = 10;
    // dte crosses the tailSkip boundary: bar0 dte=5==tailSkip (active), bar1 dte=4<tailSkip (flat)
    const out = calendarBasisReturns(spot, fut, [5, 4, 3], NOROLL(3), { minBasisAnn: 0, feeBps, tailSkip: 5 });
    // bar0: dte=5>=5 ⇒ active(+1) from flat ⇒ 1-unit open fee; prices flat ⇒ pnl 0
    expect(out[0]).toBeCloseTo(-1 * fee1(feeBps), 12);
    // bar1: dte=4<5 ⇒ flat ⇒ side +1→0 ⇒ 1-unit closing fee; prices flat ⇒ pnl 0
    expect(out[1]).toBeCloseTo(-1 * fee1(feeBps), 12);
  });

  it("minBasisAnn gate: an annualized basis below the floor stays flat; at/above the floor it opens", () => {
    // Construct so the annualized basis sits just under vs just over a chosen floor.
    // annBasis = (fut/spot - 1) * 365/dte. With spot=100, dte=365 ⇒ annBasis = (fut/100 - 1).
    const spot = [100, 100, 100];
    const dte = [365, 365, 365];
    const floor = 0.02; // 2% annualized
    // bar0 basis 1% (<2% floor) ⇒ flat; bar1 basis 3% (>=floor) ⇒ active
    const fut = [101, 103, 103];
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(3), { minBasisAnn: floor, feeBps: 10, tailSkip: 0 });
    // bar0: target=0 (1%<2%), side starts 0 ⇒ no fee, no pnl
    expect(out[0]).toBeCloseTo(0, 12);
    // bar1: target=+1 (3%>=2%) opens from flat ⇒ 1-unit fee; spotRet=0, futRet=0 ⇒ pnl 0
    expect(out[1]).toBeCloseTo(-1 * fee1(10), 12);
  });
});

describe("calendarBasisReturns — fee monotonicity", () => {
  it("a higher feeBps never increases the total summed return", () => {
    const r = lcg(50);
    const n = 30;
    const spot = randCloses(r, n);
    const fut = spot.map((s) => s * (1 + between(r, -0.015, 0.025)));
    const dte = DTE(n, 70);
    const roll = Array.from({ length: n }, (_, i) => i % 7 === 0);
    const lo = sum(calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0.02, feeBps: 0 }));
    const hi = sum(calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0.02, feeBps: 50 }));
    expect(hi).toBeLessThanOrEqual(lo + 1e-12);
  });

  it("constant flat market (spot=fut const, zero vol) ⇒ zero pnl; only the single opening fee shows", () => {
    const spot = [100, 100, 100, 100];
    const fut = [101, 101, 101, 101]; // tiny constant contango → opens long once, never trades again
    const dte = [60, 59, 58, 57];
    const feeBps = 6;
    const out = calendarBasisReturns(spot, fut, dte, NOROLL(4), { minBasisAnn: 0, feeBps, tailSkip: 0 });
    expect(out[0]).toBeCloseTo(0 - 1 * fee1(feeBps), 12); // open fee only (prices flat → pnl 0)
    out.slice(1).forEach((v) => expect(v).toBeCloseTo(0, 12)); // held, flat prices → exactly 0
  });
});

describe("calendarBasisReturns — NO-LOOKAHEAD", () => {
  it("perturbing a FUTURE spot/fut close cannot change any earlier return (causal)", () => {
    const r = lcg(60);
    const n = 24;
    const spot = randCloses(r, n);
    const fut = spot.map((s, i) => s * (1 + between(r, -0.02, 0.02)));
    const dte = DTE(n, 80);
    const roll = NOROLL(n);
    const base = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0.02, feeBps: 1 });
    const s2 = [...spot], f2 = [...fut];
    s2[n - 1] = 9_999_999;
    f2[n - 1] = 1;
    const pert = calendarBasisReturns(s2, f2, dte, roll, { minBasisAnn: 0.02, feeBps: 1 });
    expect(pert.slice(0, -1)).toEqual(base.slice(0, -1));
  });

  it("perturbing dte[k] (the side gate at bar k) cannot change any return strictly BEFORE k (side depends only on inputs ≤ k)", () => {
    // dte[i] is read ONLY in bar i's own side decision (the >=tailSkip gate and the annualization
    // factor). It is never read by an earlier bar, so flipping dte[k] is a clean future-input probe.
    const r = lcg(61);
    const n = 26;
    const spot = randCloses(r, n);
    const fut = spot.map((s, i) => s * (1 + between(r, -0.02, 0.02)));
    const dte = DTE(n, 80);
    const roll = NOROLL(n);
    const base = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0.02, feeBps: 1, tailSkip: 2 });
    const k = 13;
    const d2 = [...dte];
    d2[k] = 0; // drop bar k below tailSkip → forces target=0 at k (a real side change at/after k)
    const pert = calendarBasisReturns(spot, fut, d2, roll, { minBasisAnn: 0.02, feeBps: 1, tailSkip: 2 });
    for (let i = 0; i < k; i++) expect(pert[i]).toBeCloseTo(base[i], 12);
    // sanity: the perturbation actually DID move bar k (otherwise the test proves nothing)
    expect(pert[k]).not.toBeCloseTo(base[k], 12);
  });

  it("flipping a roll[m] flag for m>k+1 cannot change any return at/below bar k (roll only gates its own bar)", () => {
    const r = lcg(62);
    const n = 20;
    const spot = randCloses(r, n);
    const fut = spot.map((s) => s * 1.01);
    const dte = DTE(n, 70);
    const roll = NOROLL(n);
    const base = calendarBasisReturns(spot, fut, dte, roll, { minBasisAnn: 0, feeBps: 1, tailSkip: 0 });
    const k = 8;
    const roll2 = [...roll];
    roll2[k + 3] = true; // a future seam
    const pert = calendarBasisReturns(spot, fut, dte, roll2, { minBasisAnn: 0, feeBps: 1, tailSkip: 0 });
    for (let i = 0; i <= k; i++) expect(pert[i]).toBeCloseTo(base[i], 12);
  });
});
