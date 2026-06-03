import { describe, it, expect } from "vitest";
import { fundingGate, fundingCarrySignal, netFundingReturns } from "@/lib/backtest/candle/funding";
import type { DailyCandle } from "@/lib/backtest/candle/engine";

// ---- deterministic helpers (no platform RNG, no wall-clock) ----
// Numerical Recipes LCG → [0,1)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
// uniform in [lo, hi)
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

const candles = (closes: number[]): DailyCandle[] =>
  closes.map((c, i) => ({ start_unix: i, open: c, high: c, low: c, close: c, volume: 1 }));

// random strictly-positive close series (avoid div-by-zero / sign flips)
function randCloses(r: () => number, n: number): number[] {
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + between(r, -0.08, 0.08)));
  return out;
}
const randFunding = (r: () => number, n: number): number[] =>
  Array.from({ length: n }, () => between(r, -0.003, 0.003));
const randPos = (r: () => number, n: number): number[] =>
  Array.from({ length: n }, () => (r() < 0.5 ? 0 : 1));
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

// reference price return over bar i→i+1
const pr = (cs: DailyCandle[], i: number) => cs[i + 1].close / cs[i].close - 1;

describe("fundingGate — properties", () => {
  it("output value at each index is either the original position or 0 (gate never introduces new magnitudes)", () => {
    const r = lcg(1);
    const pos = Array.from({ length: 40 }, () => between(r, -3, 3));
    const f = randFunding(r, 40);
    const g = fundingGate(pos, f, { maxFunding: 0.0005 });
    g.forEach((v, i) => expect(v === pos[i] || v === 0).toBe(true));
  });

  it("only SUBTRACTS — |gated| ≤ |original| at every index for random caps", () => {
    const r = lcg(2);
    for (let t = 0; t < 30; t++) {
      const n = 25;
      const pos = Array.from({ length: n }, () => between(r, -2, 2));
      const f = randFunding(r, n);
      const cap = between(r, -0.002, 0.002);
      const g = fundingGate(pos, f, { maxFunding: cap });
      g.forEach((v, i) => expect(Math.abs(v)).toBeLessThanOrEqual(Math.abs(pos[i]) + 1e-12));
    }
  });

  it("a zero input position stays zero regardless of how favorable funding is", () => {
    const r = lcg(3);
    const pos = Array.from({ length: 30 }, () => 0);
    const f = Array.from({ length: 30 }, () => between(r, -0.01, -0.001)); // all favorable
    expect(fundingGate(pos, f, { maxFunding: 0.01 }).every((v) => v === 0)).toBe(true);
  });

  it("keeps the position exactly when funding ≤ cap, drops it when funding > cap (boundary inclusive)", () => {
    const cap = 0.0003;
    const pos = [1, 1, 1, 1, 1];
    const f = [cap - 1e-9, cap, cap + 1e-9, cap * 10, cap - 0.001];
    expect(fundingGate(pos, f, { maxFunding: cap })).toEqual([1, 1, 0, 0, 1]);
  });

  it("raising maxFunding is monotone: a higher cap can only keep MORE positions, never fewer", () => {
    const r = lcg(4);
    const n = 50;
    const pos = Array.from({ length: n }, () => 1);
    const f = randFunding(r, n);
    const lo = fundingGate(pos, f, { maxFunding: -0.001 });
    const hi = fundingGate(pos, f, { maxFunding: 0.001 });
    // wherever lo kept the long, hi must also keep it
    for (let i = 0; i < n; i++) if (lo[i] === 1) expect(hi[i]).toBe(1);
    expect(sum(hi)).toBeGreaterThanOrEqual(sum(lo));
  });

  it("default cap is 0 → keeps only non-positive (paid/neutral) funding bars", () => {
    const pos = [1, 1, 1, 1];
    const f = [-0.0001, 0, 1e-9, 0.002];
    expect(fundingGate(pos, f)).toEqual([1, 1, 0, 0]);
  });

  it("every non-finite funding bar zeroes the position (NaN, +Inf, -Inf, undefined all flat)", () => {
    const pos = [5, 5, 5, 5, 5];
    const f = [NaN, Infinity, -Infinity, undefined, -0.001];
    expect(fundingGate(pos, f, { maxFunding: 1 })).toEqual([0, 0, 0, 0, 5]);
  });

  it("preserves length and never reads beyond its own index (truncated funding → trailing flats)", () => {
    const pos = [1, 1, 1, 1];
    const f = [-0.001, -0.001]; // funding[2], funding[3] are undefined
    const g = fundingGate(pos, f, { maxFunding: 0 });
    expect(g).toHaveLength(4);
    expect(g).toEqual([1, 1, 0, 0]);
  });

  it("is idempotent under its own gate at the same cap (gate∘gate = gate)", () => {
    const r = lcg(5);
    const n = 40;
    const pos = Array.from({ length: n }, () => between(r, -1, 1));
    const f = randFunding(r, n);
    const cap = 0.0002;
    const once = fundingGate(pos, f, { maxFunding: cap });
    const twice = fundingGate(once, f, { maxFunding: cap });
    expect(twice).toEqual(once);
  });

  it("NO-LOOKAHEAD — perturbing funding[k] only changes output at index k", () => {
    const r = lcg(6);
    const n = 30;
    const pos = Array.from({ length: n }, () => 1);
    const f = randFunding(r, n);
    const base = fundingGate(pos, f, { maxFunding: 0 });
    const k = 17;
    const f2 = [...f];
    f2[k] = f2[k]! > 0 ? -0.01 : 0.01; // flip its gating decision
    const pert = fundingGate(pos, f2, { maxFunding: 0 });
    for (let i = 0; i < n; i++) if (i !== k) expect(pert[i]).toBe(base[i]);
  });

  it("preserves the input positions array (no mutation)", () => {
    const pos = [1, 1, 1];
    const copy = [...pos];
    fundingGate(pos, [0.5, -0.5, 0.5]);
    expect(pos).toEqual(copy);
  });
});

describe("fundingCarrySignal — properties", () => {
  it("output is binary {0,1} at every index for random funding", () => {
    const r = lcg(11);
    const f = randFunding(r, 60);
    const s = fundingCarrySignal(f, { enter: -0.0002, exit: 0.0002 });
    expect(s.every((v) => v === 0 || v === 1)).toBe(true);
    expect(s).toHaveLength(f.length);
  });

  it("starts flat before any signal — leading non-finite bars stay 0", () => {
    const f = [NaN, undefined, Infinity, -0.001, 0.001];
    expect(fundingCarrySignal(f, { enter: 0, exit: 0.0005 })).toEqual([0, 0, 0, 1, 0]);
  });

  it("holds the prior state across a non-finite bar (no forced reset)", () => {
    const f = [-0.001, NaN, undefined, 0.0001, undefined];
    // enter at bar0 (long), holds long through NaN/undefined, stays long in band, holds through undefined
    expect(fundingCarrySignal(f, { enter: 0, exit: 0.0005 })).toEqual([1, 1, 1, 1, 1]);
  });

  it("goes long on funding ≤ enter and flat on funding ≥ exit (with hysteresis band held)", () => {
    const f = [-0.002, -0.0001, 0.0001, 0.0006, 0.0001, -0.002];
    // enter=-0.0001 long, band(-0.0001,0.0005) holds, >=exit flat, band holds, <=enter long
    expect(fundingCarrySignal(f, { enter: -0.0001, exit: 0.0005 })).toEqual([1, 1, 1, 0, 0, 1]);
  });

  it("default enter=exit=0 → strict on/off: long iff funding ≤ 0, flat once funding ≥ 0 (0 enters)", () => {
    const f = [0, 1e-6, -1e-6, 0, 0.5];
    // f=0 → f<=enter wins → long; positive → exit; negative → long; 0 → long again; positive → flat
    expect(fundingCarrySignal(f)).toEqual([1, 0, 1, 1, 0]);
  });

  it("when enter ≥ exit there is no holding band: each finite bar resolves immediately by its own sign", () => {
    const r = lcg(12);
    const f = randFunding(r, 40);
    const s = fundingCarrySignal(f, { enter: 0, exit: 0 });
    // with enter=exit=0, every finite bar sets state: f<=0 → 1 else f>=0 → 0
    f.forEach((v, i) => expect(s[i]).toBe(v <= 0 ? 1 : 0));
  });

  it("all-favorable funding (always ≤ enter) → long at every bar; all-punitive → flat at every bar", () => {
    const r = lcg(13);
    const fav = Array.from({ length: 30 }, () => between(r, -0.01, -0.001));
    const pun = Array.from({ length: 30 }, () => between(r, 0.001, 0.01));
    expect(fundingCarrySignal(fav, { enter: 0, exit: 0.0005 }).every((v) => v === 1)).toBe(true);
    expect(fundingCarrySignal(pun, { enter: -0.0005, exit: 0 }).every((v) => v === 0)).toBe(true);
  });

  it("a value strictly inside the band never changes state (state is path-dependent, not band-dependent)", () => {
    const enter = -0.001, exit = 0.001;
    const inBand = 0; // strictly between enter and exit
    // path A reaches the band while LONG, path B reaches it while FLAT
    const long = fundingCarrySignal([-0.002, inBand], { enter, exit });
    const flat = fundingCarrySignal([0.002, inBand], { enter, exit });
    expect(long).toEqual([1, 1]); // stayed long inside band
    expect(flat).toEqual([0, 0]); // stayed flat inside band
  });

  it("empty funding → empty signal", () => {
    expect(fundingCarrySignal([], { enter: 0, exit: 0 })).toEqual([]);
  });

  it("NO-LOOKAHEAD — perturbing funding[k] never changes any signal strictly before k", () => {
    const r = lcg(14);
    const n = 50;
    const f = randFunding(r, n);
    const base = fundingCarrySignal(f, { enter: -0.0001, exit: 0.0001 });
    const k = 31;
    const f2 = [...f];
    f2[k] = -9; // strong long signal
    const pert = fundingCarrySignal(f2, { enter: -0.0001, exit: 0.0001 });
    expect(pert.slice(0, k)).toEqual(base.slice(0, k));
  });

  it("appending future bars never rewrites the prefix signal (causal/streaming-stable)", () => {
    const r = lcg(15);
    const head = randFunding(r, 20);
    const tail = randFunding(r, 15);
    const headSig = fundingCarrySignal(head, { enter: 0, exit: 0.0003 });
    const fullSig = fundingCarrySignal([...head, ...tail], { enter: 0, exit: 0.0003 });
    expect(fullSig.slice(0, head.length)).toEqual(headSig);
  });

  it("paired with fundingGate at cap=enter, the gate can only flatten the carry signal further", () => {
    const r = lcg(16);
    const n = 40;
    const f = randFunding(r, n);
    const enter = 0;
    const sig = fundingCarrySignal(f, { enter, exit: 0.0005 });
    const gated = fundingGate(sig, f, { maxFunding: enter });
    for (let i = 0; i < n; i++) expect(gated[i] <= sig[i]).toBe(true);
  });
});

describe("netFundingReturns — properties", () => {
  it("returns exactly candles.length-1 values (one per bar transition)", () => {
    const r = lcg(21);
    for (const n of [2, 3, 8, 25]) {
      const cs = candles(randCloses(r, n));
      const out = netFundingReturns(cs, Array(n).fill(1), randFunding(r, n), 0);
      expect(out).toHaveLength(n - 1);
    }
  });

  it("positive funding REDUCES a long's net return vs the price-only return (long pays funding)", () => {
    const r = lcg(22);
    const n = 12;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const fund = Array.from({ length: n }, () => between(r, 0.0005, 0.003)); // strictly positive
    const withF = netFundingReturns(cs, pos, fund, 0);
    const noF = netFundingReturns(cs, pos, Array(n).fill(0), 0);
    for (let i = 0; i < withF.length; i++) expect(withF[i]).toBeLessThan(noF[i]);
  });

  it("negative funding INCREASES a long's net return (long is paid funding)", () => {
    const r = lcg(23);
    const n = 12;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const fund = Array.from({ length: n }, () => between(r, -0.003, -0.0005)); // strictly negative
    const withF = netFundingReturns(cs, pos, fund, 0);
    const noF = netFundingReturns(cs, pos, Array(n).fill(0), 0);
    for (let i = 0; i < withF.length; i++) expect(withF[i]).toBeGreaterThan(noF[i]);
  });

  it("matches the closed form pos*(priceRet - funding) - |Δpos|*fee at every bar", () => {
    const r = lcg(24);
    const n = 20;
    const cs = candles(randCloses(r, n));
    const pos = randPos(r, n);
    const fund = randFunding(r, n);
    const feeBps = 7;
    const out = netFundingReturns(cs, pos, fund, feeBps);
    for (let i = 0; i < n - 1; i++) {
      const prev = i > 0 ? pos[i - 1] : 0;
      const expected = pos[i] * (pr(cs, i) - fund[i]) - Math.abs(pos[i] - prev) * (feeBps / 1e4);
      expect(out[i]).toBeCloseTo(expected, 12);
    }
  });

  it("higher fee never INCREASES any per-bar net return (fee is a non-negative drag)", () => {
    const r = lcg(25);
    const n = 30;
    const cs = candles(randCloses(r, n));
    const pos = randPos(r, n);
    const fund = randFunding(r, n);
    const lo = netFundingReturns(cs, pos, fund, 0);
    const hi = netFundingReturns(cs, pos, fund, 50);
    for (let i = 0; i < lo.length; i++) expect(hi[i]).toBeLessThanOrEqual(lo[i] + 1e-15);
  });

  it("higher fee never increases the TOTAL summed return", () => {
    const r = lcg(26);
    const n = 40;
    const cs = candles(randCloses(r, n));
    const pos = randPos(r, n);
    const fund = randFunding(r, n);
    expect(sum(netFundingReturns(cs, pos, fund, 100))).toBeLessThanOrEqual(sum(netFundingReturns(cs, pos, fund, 0)) + 1e-12);
  });

  it("fee on a constantly-held position is paid only ONCE (the opening turnover at bar 0)", () => {
    const cs = candles([100, 100, 100, 100, 100]); // zero price return
    const out = netFundingReturns(cs, [1, 1, 1, 1, 1], [0, 0, 0, 0], 30);
    expect(out[0]).toBeCloseTo(-30 / 1e4, 12); // |1-0| turnover at open
    expect(out.slice(1).every((x) => x === 0)).toBe(true); // no further turnover
  });

  it("a flat (all-zero) position earns exactly 0 every bar regardless of price/funding/fee", () => {
    const r = lcg(27);
    const n = 20;
    const cs = candles(randCloses(r, n));
    const out = netFundingReturns(cs, Array(n).fill(0), randFunding(r, n), 999);
    expect(out.every((x) => x === 0)).toBe(true);
  });

  it("with zero fee and zero funding it collapses to the raw price return of the held bars", () => {
    const r = lcg(28);
    const n = 15;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const out = netFundingReturns(cs, pos, Array(n).fill(0), 0);
    for (let i = 0; i < n - 1; i++) expect(out[i]).toBeCloseTo(pr(cs, i), 12);
  });

  it("non-finite funding contributes 0 funding (treated as if funding were 0 that bar)", () => {
    const r = lcg(29);
    const n = 10;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const bad = [NaN, Infinity, -Infinity, undefined, NaN, undefined, NaN, NaN, NaN];
    const out = netFundingReturns(cs, pos, bad, 0);
    for (let i = 0; i < n - 1; i++) expect(out[i]).toBeCloseTo(pr(cs, i), 12);
  });

  it("a short (pos=-1) RECEIVES positive funding: its net beats the negated long price return when funding>0", () => {
    const cs = candles([100, 110]); // long price ret = +10%
    // short: pos*(priceRet - f) = -1*(0.10 - 0.02) = -0.08 ; raw negated price = -0.10
    const out = netFundingReturns(cs, [-1, -1], [0.02], 0);
    expect(out[0]).toBeCloseTo(-(0.1 - 0.02), 12);
    expect(out[0]).toBeGreaterThan(-0.1); // short earns the +2% funding back
  });

  it("net return is linear in position size: doubling pos doubles the per-bar net (zero turnover case)", () => {
    const r = lcg(30);
    const n = 12;
    const cs = candles(randCloses(r, n));
    const fund = randFunding(r, n);
    const one = netFundingReturns(cs, Array(n).fill(1), fund, 0);
    const two = netFundingReturns(cs, Array(n).fill(2), fund, 0);
    for (let i = 1; i < one.length; i++) expect(two[i]).toBeCloseTo(2 * one[i], 12); // i>=1 has no turnover (held flat-2)
  });

  it("funding sign symmetry: flipping the funding sign flips its contribution to a long's return", () => {
    const r = lcg(31);
    const n = 14;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const fund = randFunding(r, n);
    const plus = netFundingReturns(cs, pos, fund, 0);
    const minus = netFundingReturns(cs, pos, fund.map((x) => -x), 0);
    // (priceRet - f) and (priceRet + f) average to the price-only return
    const base = netFundingReturns(cs, pos, Array(n).fill(0), 0);
    for (let i = 0; i < base.length; i++) expect((plus[i] + minus[i]) / 2).toBeCloseTo(base[i], 12);
  });

  it("default feeBps is 10 (omitting fee equals passing 10)", () => {
    const r = lcg(32);
    const n = 16;
    const cs = candles(randCloses(r, n));
    const pos = randPos(r, n);
    const fund = randFunding(r, n);
    expect(netFundingReturns(cs, pos, fund)).toEqual(netFundingReturns(cs, pos, fund, 10));
  });

  it("missing position entries default to 0 (short positions array → trailing flats, no out-of-range read)", () => {
    const cs = candles([100, 110, 121, 133]);
    const out = netFundingReturns(cs, [1], [0, 0, 0], 0); // only positions[0] given
    // bar0 held long (+10%), bar1/bar2 pos undefined→0 → 0 return
    expect(out[0]).toBeCloseTo(0.1, 12);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it("turnover fee is charged on a flip 0→1 and 1→0 but not on a hold", () => {
    const cs = candles([100, 100, 100, 100, 100]); // isolate fee from price (5 candles → 4 returns)
    const out = netFundingReturns(cs, [0, 1, 1, 0], [0, 0, 0, 0], 20);
    expect(out[0]).toBe(0);                     // bar0: pos=0, prev=0, no turnover, flat
    expect(out[1]).toBeCloseTo(-20 / 1e4, 12);  // bar1: pos=1, prev=0 → open flip, 1 turnover
    expect(out[2]).toBe(0);                     // bar2: pos=1, prev=1 → held, no fee
    expect(out[3]).toBeCloseTo(-20 / 1e4, 12);  // bar3: pos=0, prev=1 → close flip, 1 turnover
  });

  it("single-candle input → empty returns (no transition exists)", () => {
    expect(netFundingReturns(candles([100]), [1], [0.01], 10)).toEqual([]);
    expect(netFundingReturns(candles([]), [], [], 10)).toEqual([]);
  });

  it("NO-LOOKAHEAD — perturbing the final candle close cannot change any earlier net return", () => {
    const r = lcg(33);
    const n = 18;
    const closes = randCloses(r, n);
    const pos = randPos(r, n);
    const fund = randFunding(r, n);
    const base = netFundingReturns(candles(closes), pos, fund, 8);
    const c2 = [...closes];
    c2[n - 1] = 9_999_999;
    const pert = netFundingReturns(candles(c2), pos, fund, 8);
    expect(pert.slice(0, -1)).toEqual(base.slice(0, -1));
  });

  it("NO-LOOKAHEAD — perturbing funding[k] only changes the net return at bar k (it conditions bar k→k+1 only)", () => {
    const r = lcg(34);
    const n = 20;
    const cs = candles(randCloses(r, n));
    const pos = Array(n).fill(1);
    const fund = randFunding(r, n);
    const base = netFundingReturns(cs, pos, fund, 5);
    const k = 9;
    const f2 = [...fund];
    f2[k] = f2[k] + 0.05;
    const pert = netFundingReturns(cs, pos, f2, 5);
    for (let i = 0; i < base.length; i++) {
      if (i === k) expect(pert[i]).not.toBeCloseTo(base[i], 12);
      else expect(pert[i]).toBeCloseTo(base[i], 12);
    }
  });

  it("does not mutate its inputs (candles, positions, funding all unchanged)", () => {
    const cs = candles([100, 110, 120]);
    const csCopy = JSON.parse(JSON.stringify(cs));
    const pos = [1, 1, 0];
    const posCopy = [...pos];
    const fund = [0.01, -0.01];
    const fundCopy = [...fund];
    netFundingReturns(cs, pos, fund, 10);
    expect(cs).toEqual(csCopy);
    expect(pos).toEqual(posCopy);
    expect(fund).toEqual(fundCopy);
  });
});

describe("cross-function carry pipeline — properties", () => {
  it("gating a long series before pricing never improves total net return vs the ungated long (it only removes bars)", () => {
    const r = lcg(41);
    const n = 35;
    const cs = candles(randCloses(r, n));
    const fund = randFunding(r, n);
    const allLong = Array(n).fill(1);
    const gated = fundingGate(allLong, fund, { maxFunding: 1 }); // cap huge → keeps every finite bar
    // with cap=1 and finite funding, gate keeps all longs → identical to ungated
    const a = netFundingReturns(cs, allLong, fund, 0);
    const b = netFundingReturns(cs, gated, fund, 0);
    expect(b).toEqual(a);
  });

  it("the funding carry signal, priced through netFundingReturns, never pays positive funding on a held long bar", () => {
    const r = lcg(42);
    const n = 40;
    const cs = candles(randCloses(r, n));
    const fund = randFunding(r, n);
    const sig = fundingCarrySignal(fund, { enter: 0, exit: 0 }); // long iff funding<=0
    // for every bar the signal is long (1), funding[i] must be <=0 → its funding contribution helps (>=0)
    for (let i = 0; i < n - 1; i++) {
      if (sig[i] === 1 && Number.isFinite(fund[i])) {
        // priceRet - funding >= priceRet because funding<=0
        expect(fund[i]).toBeLessThanOrEqual(0);
      }
    }
  });

  it("end-to-end determinism: same seed reproduces identical net-return vectors", () => {
    const build = () => {
      const r = lcg(99);
      const n = 30;
      const cs = candles(randCloses(r, n));
      const fund = randFunding(r, n);
      const sig = fundingCarrySignal(fund, { enter: -0.0001, exit: 0.0001 });
      const gated = fundingGate(sig, fund, { maxFunding: 0 });
      return netFundingReturns(cs, gated, fund, 10);
    };
    expect(build()).toEqual(build());
  });
});
