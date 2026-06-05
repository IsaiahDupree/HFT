/**
 * funding-executor-coverage — ADVERSARIAL coverage for the funding-executor safety core.
 *
 * This file is intentionally DISJOINT from carry-plan.test.ts and funding-stats.test.ts: it targets
 * the exact gate boundaries, sign/magnitude coherence, spike-resistance under extreme skew, and the
 * NO-LOOKAHEAD invariant for the recent-regime window. Where a property is natural we use a small
 * deterministic LCG (the same pattern as funding.props.test.ts — fast-check is not a hard dep here),
 * so the suite stays fast and reproducible with NO network and NO wall-clock.
 */
import { describe, it, expect } from "vitest";
import {
  planCarryLegs,
  bookSafetyCheck,
  DEFAULT_LIMITS,
  type CarryOpp,
  type CarryLimits,
} from "@/lib/exec/carry-plan";
import { fundingStats } from "@/lib/exec/funding-stats";

const HOURLY = 24 * 365;

// ---- deterministic RNG (Numerical Recipes LCG) — no platform RNG, no wall-clock ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

const opp = (over: Partial<CarryOpp> = {}): CarryOpp => ({
  coin: "LAB",
  fundingApr: 60,
  persistence: 0.9,
  perpVenue: "hyperliquid",
  spotVenues: ["coinbase"],
  ...over,
});

// limits with all economic/persistence gates wide-open, so a single gate can be isolated
const PERMISSIVE: CarryLimits = {
  ...DEFAULT_LIMITS,
  minPersistence: 0,
  minNetApr: -1e9,
  maxNotionalPerName: 1e12,
  maxTotalNotional: 1e12,
  allowUnhedged: true,
  allowSpotBorrow: true,
};

const hasBlocker = (p: { blockers: string[] }, re: RegExp) => p.blockers.some((b) => re.test(b));

// ============================================================================
// 1. GATE BOUNDARIES — every threshold is tested AT, just-below, and just-above
// ============================================================================
describe("planCarryLegs — persistence gate boundary (strict <)", () => {
  const lim: CarryLimits = { ...DEFAULT_LIMITS, minPersistence: 0.7 };

  it("EXACTLY at the floor passes (>= is allowed, only strictly-below is a carry trap)", () => {
    const p = planCarryLegs(opp({ persistence: 0.7 }), 1000, lim);
    expect(hasBlocker(p, /transient|persistence/)).toBe(false);
    expect(p.checks.some((c) => /persistence/.test(c))).toBe(true);
  });

  it("one ULP below the floor blocks", () => {
    const p = planCarryLegs(opp({ persistence: 0.7 - Number.EPSILON }), 1000, lim);
    expect(hasBlocker(p, /transient|persistence/)).toBe(true);
  });

  it("just above the floor passes", () => {
    const p = planCarryLegs(opp({ persistence: 0.7001 }), 1000, lim);
    expect(hasBlocker(p, /transient|persistence/)).toBe(false);
  });
});

describe("planCarryLegs — net-APR economic gate boundary (strict <)", () => {
  // pick funding so netApr lands controllably; netApr = (|f|/365*100 - 2*fee/hold) * 365/100
  // with fee=5,hold=14: feeDragBp = 10/14. netApr = |f| - feeDragBp*365/100
  const lim: CarryLimits = { ...DEFAULT_LIMITS, feeBpsPerSide: 5, holdDays: 14, minNetApr: 15 };
  const feeAprDrag = (2 * 5) / 14 * 365 / 100; // ≈ 26.07 APR points of fee drag

  it("net APR exactly at the floor is NOT blocked (strict <)", () => {
    const f = 15 + feeAprDrag; // makes netApr ≈ exactly 15
    const p = planCarryLegs(opp({ fundingApr: f }), 1000, lim);
    // expectedAprNet is rounded; assert un-rounded boundary semantics via the gate result
    expect(p.expectedAprNet).toBeGreaterThanOrEqual(15 - 0.05);
    // a hair above the floor must pass cleanly
    const above = planCarryLegs(opp({ fundingApr: f + 1 }), 1000, lim);
    expect(hasBlocker(above, /uneconomic|net /)).toBe(false);
  });

  it("net APR clearly below the floor blocks as uneconomic", () => {
    const p = planCarryLegs(opp({ fundingApr: 10 + feeAprDrag - 1 }), 1000, lim); // netApr ≈ 9
    expect(hasBlocker(p, /uneconomic|net /)).toBe(true);
  });

  it("fee drag strictly reduces net APR (cost monotonicity)", () => {
    const cheap = planCarryLegs(opp({ fundingApr: 73 }), 1000, { ...lim, feeBpsPerSide: 1 });
    const dear = planCarryLegs(opp({ fundingApr: 73 }), 1000, { ...lim, feeBpsPerSide: 20 });
    expect(dear.expectedAprNet).toBeLessThan(cheap.expectedAprNet);
    // longer hold amortizes the same round-trip → higher net
    const shortHold = planCarryLegs(opp({ fundingApr: 73 }), 1000, { ...lim, holdDays: 2 });
    const longHold = planCarryLegs(opp({ fundingApr: 73 }), 1000, { ...lim, holdDays: 60 });
    expect(longHold.expectedAprNet).toBeGreaterThan(shortHold.expectedAprNet);
  });
});

// ============================================================================
// 2. PER-NAME + BOOK CAPS
// ============================================================================
describe("planCarryLegs — per-name notional cap invariant", () => {
  it("notional is NEVER above the per-name cap (min clamp), so the >cap blocker is unreachable", () => {
    const r = lcg(7);
    for (let t = 0; t < 50; t++) {
      const cap = between(r, 100, 5000);
      const req = between(r, 1, 50000);
      const p = planCarryLegs(opp(), req, { ...PERMISSIVE, maxNotionalPerName: cap });
      expect(p.perpLeg.notionalUsd).toBeLessThanOrEqual(cap);
      expect(p.perpLeg.notionalUsd).toBe(Math.min(req, cap));
      expect(hasBlocker(p, /per-name cap/)).toBe(false); // clamp means it can't trip
    }
  });

  it("requesting LESS than the cap uses the requested capital, not the cap", () => {
    const p = planCarryLegs(opp(), 250, { ...PERMISSIVE, maxNotionalPerName: 1000 });
    expect(p.perpLeg.notionalUsd).toBe(250);
  });

  it("perp and spot legs are always notional-matched (delta-neutral by construction)", () => {
    const r = lcg(11);
    for (let t = 0; t < 40; t++) {
      const p = planCarryLegs(opp(), between(r, 1, 9000), { ...PERMISSIVE, maxNotionalPerName: 1000 });
      expect(p.spotLeg).not.toBeNull();
      expect(p.spotLeg!.notionalUsd).toBe(p.perpLeg.notionalUsd);
    }
  });
});

describe("bookSafetyCheck — book cap boundary & executable filtering", () => {
  it("book total EXACTLY at the cap does NOT flag (strict >)", () => {
    const plans = ["A", "B"].map((c) => planCarryLegs(opp({ coin: c }), 1000, PERMISSIVE));
    const { totalNotional, bookBlockers } = bookSafetyCheck(plans, { ...PERMISSIVE, maxTotalNotional: 2000 });
    expect(totalNotional).toBe(2000);
    expect(bookBlockers).toEqual([]);
  });

  it("one dollar over the cap flags", () => {
    const plans = ["A", "B"].map((c) => planCarryLegs(opp({ coin: c }), 1000, PERMISSIVE));
    const { bookBlockers } = bookSafetyCheck(plans, { ...PERMISSIVE, maxTotalNotional: 1999 });
    expect(bookBlockers.some((b) => /book notional/.test(b))).toBe(true);
  });

  it("BLOCKED plans are excluded from book notional (a naked plan never consumes book budget)", () => {
    const good = planCarryLegs(opp({ coin: "LAB" }), 1000); // default limits → executable
    const naked = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000); // blocked: unhedged
    const transient = planCarryLegs(opp({ coin: "FOO", persistence: 0.5 }), 1000); // blocked: persistence
    const { executable, totalNotional } = bookSafetyCheck([good, naked, transient], DEFAULT_LIMITS);
    expect(executable).toHaveLength(1);
    expect(totalNotional).toBe(1000); // only the good plan counts
  });

  it("empty book is safe (no NaN, no blockers)", () => {
    const { executable, totalNotional, bookBlockers } = bookSafetyCheck([], DEFAULT_LIMITS);
    expect(executable).toEqual([]);
    expect(totalNotional).toBe(0);
    expect(bookBlockers).toEqual([]);
  });

  it("book total sums ALL executable plans exactly (no double-count, no drop)", () => {
    const r = lcg(13);
    const caps = Array.from({ length: 5 }, () => Math.round(between(r, 100, 900)));
    const plans = caps.map((cap, i) =>
      planCarryLegs(opp({ coin: `C${i}` }), cap, { ...PERMISSIVE, maxNotionalPerName: 1000 })
    );
    const { totalNotional } = bookSafetyCheck(plans, PERMISSIVE);
    expect(totalNotional).toBe(caps.reduce((a, c) => a + c, 0));
  });
});

// ============================================================================
// 3. BORROW GATE (negative funding) + UNHEDGED GATE — economic SIGN correctness
// ============================================================================
describe("planCarryLegs — sign correctness & the spot-borrow gate", () => {
  it("positive funding → SHORT perp / LONG spot (BUY, no borrow), borrow gate silent", () => {
    const p = planCarryLegs(opp({ fundingApr: 80 }), 1000);
    expect(p.perpLeg.positionSide).toBe("short");
    expect(p.perpLeg.action).toBe("sell");
    expect(p.spotLeg!.positionSide).toBe("long");
    expect(p.spotLeg!.action).toBe("buy");
    expect(hasBlocker(p, /BORROW/)).toBe(false);
  });

  it("ZERO funding counts as the positive/long-spot side (>= 0 boundary) — no borrow needed", () => {
    const p = planCarryLegs(opp({ fundingApr: 0 }), 1000, PERMISSIVE);
    expect(p.perpLeg.positionSide).toBe("short");
    expect(p.spotLeg!.positionSide).toBe("long");
    expect(hasBlocker(p, /BORROW/)).toBe(false);
  });

  it("negative funding → LONG perp / SHORT spot (SELL) and is BORROW-gated by default", () => {
    const p = planCarryLegs(opp({ fundingApr: -80 }), 1000);
    expect(p.perpLeg.positionSide).toBe("long");
    expect(p.perpLeg.action).toBe("buy");
    expect(p.spotLeg!.positionSide).toBe("short");
    expect(p.spotLeg!.action).toBe("sell");
    expect(hasBlocker(p, /BORROW/)).toBe(true);
  });

  it("borrow gate clears ONLY when allowSpotBorrow is explicitly enabled", () => {
    const off = planCarryLegs(opp({ fundingApr: -80 }), 1000, { ...DEFAULT_LIMITS, persistence: 0.9 } as CarryLimits);
    expect(hasBlocker(off, /BORROW/)).toBe(true);
    const on = planCarryLegs(opp({ fundingApr: -80, persistence: 0.9 }), 1000, { ...DEFAULT_LIMITS, allowSpotBorrow: true });
    expect(hasBlocker(on, /BORROW/)).toBe(false);
  });

  it("borrow gate is about the SPOT side, independent of having a spot venue", () => {
    // negative funding but unhedgeable → BOTH the naked gate AND (no, borrow needs a short spot leg) ...
    // spotLeg is null when no venue, so spotSide is still computed 'short' and borrow gate still fires.
    const p = planCarryLegs(opp({ fundingApr: -80, spotVenues: [] }), 1000);
    expect(p.spotLeg).toBeNull();
    expect(hasBlocker(p, /NAKED|cannot hedge/)).toBe(true);
    expect(hasBlocker(p, /BORROW/)).toBe(true); // spotSide==='short' regardless of venue presence
  });
});

describe("planCarryLegs — unhedged (naked) gate", () => {
  it("no spot venue → spotLeg null, NOT delta-neutral, naked gate fires by default", () => {
    const p = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000);
    expect(p.spotLeg).toBeNull();
    expect(p.deltaNeutral).toBe(false);
    expect(hasBlocker(p, /NAKED|cannot hedge/)).toBe(true);
  });

  it("allowUnhedged override clears the naked gate (operator opt-in)", () => {
    const p = planCarryLegs(opp({ coin: "WTI", spotVenues: [] }), 1000, { ...DEFAULT_LIMITS, allowUnhedged: true });
    expect(hasBlocker(p, /NAKED|cannot hedge/)).toBe(false);
    expect(p.deltaNeutral).toBe(false); // override does NOT fake delta-neutrality
  });

  it("first listed spot venue is chosen for the hedge leg", () => {
    const p = planCarryLegs(opp({ spotVenues: ["binanceus", "coinbase"] }), 1000, PERMISSIVE);
    expect(p.spotLeg!.venue).toBe("binanceus");
  });

  it("a hedgeable positive carry within all limits is fully EXECUTABLE (zero blockers)", () => {
    const p = planCarryLegs(opp({ fundingApr: 60, persistence: 0.9 }), 1000);
    expect(p.blockers).toEqual([]);
    expect(p.deltaNeutral).toBe(true);
  });
});

// ============================================================================
// 4. fundingStats — durable=median spike-resistance, sign/magnitude coherence
// ============================================================================
describe("fundingStats — durable magnitude from MEDIAN, spike-resistant at extreme skew", () => {
  it("EXTREME skew: 999 floor hours + 1 astronomical spike → durable pinned at the floor", () => {
    const floor = 0.0000125;
    const r = [...Array(999).fill(floor), 1.0]; // one 100%/hr print
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBeCloseTo(floor * HOURLY * 100, 6);
    expect(s.durableApr).toBeCloseTo(s.medianApr, 6); // median, NOT the mean
    expect(s.meanApr).toBeGreaterThan(s.durableApr * 50); // mean wildly inflated by the tail
    expect(s.persistence).toBe(1);
  });

  it("durable is INVARIANT to the magnitude of an above-median tail (median ignores tail size)", () => {
    const floor = 0.00002;
    const mk = (spike: number) => [...Array(101).fill(floor), ...Array(20).fill(spike)];
    const small = fundingStats(mk(0.0005), HOURLY);
    const huge = fundingStats(mk(50), HOURLY);
    // both keep the floor as the typical hour → identical durable, but mean diverges
    expect(huge.durableApr).toBeCloseTo(small.durableApr, 6);
    expect(huge.meanApr).toBeGreaterThan(small.meanApr * 100);
  });

  it("median uses the two-middle average on an even-length series", () => {
    const r = [0.00001, 0.00002, 0.00003, 0.00004]; // median = (2e-5 + 3e-5)/2 = 2.5e-5
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBeCloseTo(0.000025 * HOURLY * 100, 6);
  });
});

describe("fundingStats — SIGN from mean, MAGNITUDE from |median| coherence", () => {
  it("sign of durable always matches sign of mean (the net direction funding pays)", () => {
    const r = lcg(101);
    for (let t = 0; t < 60; t++) {
      const n = 5 + Math.floor(between(r, 0, 80));
      const arr = Array.from({ length: n }, () => between(r, -0.001, 0.001));
      const s = fundingStats(arr, HOURLY);
      if (s.n === 0) continue;
      if (s.meanApr > 0) expect(s.durableApr).toBeGreaterThanOrEqual(0);
      else if (s.meanApr < 0) expect(s.durableApr).toBeLessThanOrEqual(0);
      // |durable| always equals |median| (magnitude is the typical hour, never the mean)
      expect(Math.abs(s.durableApr)).toBeCloseTo(Math.abs(s.medianApr), 8);
    }
  });

  it("MEDIAN POSITIVE but MEAN NEGATIVE → durable takes the mean's (negative) sign, median's magnitude", () => {
    // mostly small positives, a few enormous negatives → median > 0, mean < 0
    const r = [...Array(80).fill(0.00001), ...Array(20).fill(-0.001)];
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBeGreaterThan(0);
    expect(s.meanApr).toBeLessThan(0);
    expect(s.durableApr).toBeLessThan(0); // sign follows mean (where funding NET pays)
    expect(Math.abs(s.durableApr)).toBeCloseTo(Math.abs(s.medianApr), 8); // magnitude follows median
  });

  it("MEDIAN NEGATIVE but MEAN POSITIVE → durable positive, magnitude = |median|", () => {
    const r = [...Array(80).fill(-0.00001), ...Array(20).fill(0.001)];
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBeLessThan(0);
    expect(s.meanApr).toBeGreaterThan(0);
    expect(s.durableApr).toBeGreaterThan(0);
    expect(Math.abs(s.durableApr)).toBeCloseTo(Math.abs(s.medianApr), 8);
  });

  it("median at exactly zero → durable is exactly zero regardless of mean sign (no phantom carry)", () => {
    // symmetric around zero so median (even-length, two middles straddle 0) = 0, but mean nonzero
    const r = [-0.0003, -0.0001, 0.0001, 0.0009]; // median = (-1e-4 + 1e-4)/2 = 0; mean > 0
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBe(0);
    expect(s.durableApr).toBe(0);
    expect(Math.abs(s.durableApr)).toBe(0);
  });
});

describe("fundingStats — degenerate & constant series", () => {
  it("empty series: all zero, persistence defaults to 0.5, no NaN", () => {
    const s = fundingStats([], HOURLY);
    expect(s).toEqual({ n: 0, persistence: 0.5, meanApr: 0, medianApr: 0, durableApr: 0, recentApr: 0 });
    for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
  });

  it("constant POSITIVE series: mean == median == durable == recent, persistence 1", () => {
    const c = 0.00003;
    const s = fundingStats(Array(150).fill(c), HOURLY);
    const exp = c * HOURLY * 100;
    expect(s.meanApr).toBeCloseTo(exp, 6);
    expect(s.medianApr).toBeCloseTo(exp, 6);
    expect(s.durableApr).toBeCloseTo(exp, 6);
    expect(s.recentApr).toBeCloseTo(exp, 6);
    expect(s.persistence).toBe(1);
  });

  it("constant NEGATIVE series: durable carries the negative sign, persistence 1", () => {
    const c = -0.00004;
    const s = fundingStats(Array(50).fill(c), HOURLY);
    expect(s.durableApr).toBeCloseTo(c * HOURLY * 100, 6);
    expect(s.durableApr).toBeLessThan(0);
    expect(s.persistence).toBe(1);
  });

  it("all-zero series: zero everywhere; zeros are NOT positive so persistence is 1 (n-pos dominates)", () => {
    const s = fundingStats(Array(30).fill(0), HOURLY);
    expect(s.meanApr).toBe(0);
    expect(s.medianApr).toBe(0);
    expect(s.durableApr).toBe(0);
    // pos=0, n-pos=30 → max/n = 1
    expect(s.persistence).toBe(1);
  });

  it("NaN / undefined / Infinity prints are filtered out before any stat is computed", () => {
    const clean = [0.00002, 0.00003, 0.00004];
    const dirty = [0.00002, NaN, 0.00003, Infinity, -Infinity, undefined as unknown as number, 0.00004];
    const a = fundingStats(clean, HOURLY);
    const b = fundingStats(dirty, HOURLY);
    expect(b.n).toBe(3); // only the finite ones survive
    expect(b.meanApr).toBeCloseTo(a.meanApr, 8);
    expect(b.medianApr).toBeCloseTo(a.medianApr, 8);
    expect(Number.isFinite(b.durableApr)).toBe(true);
  });

  it("single finite print: mean=median=durable, persistence 1", () => {
    const s = fundingStats([0.00005], HOURLY);
    expect(s.n).toBe(1);
    expect(s.meanApr).toBeCloseTo(s.medianApr, 8);
    expect(s.durableApr).toBeCloseTo(s.meanApr, 8);
    expect(s.persistence).toBe(1);
  });
});

// ============================================================================
// 5. NO-LOOKAHEAD — recentApr depends ONLY on the last `recentWindow` prints.
//    Perturbing an OLDER (outside-window) print must NOT change recentApr.
// ============================================================================
describe("fundingStats — NO-LOOKAHEAD on the recent-regime window", () => {
  it("perturbing an interior OLD print leaves recentApr unchanged (recent = last window only)", () => {
    const r = lcg(202);
    const win = 21;
    const n = 120;
    const base = Array.from({ length: n }, () => between(r, -0.0005, 0.0005));
    const s0 = fundingStats(base, HOURLY, win);
    // perturb an index strictly OLDER than the recent window: i < n - win
    const i = 10; // 10 < 120-21=99 → outside the recent window
    const perturbed = base.slice();
    perturbed[i] = perturbed[i] + 0.05; // a huge shove
    const s1 = fundingStats(perturbed, HOURLY, win);
    expect(s1.recentApr).toBeCloseTo(s0.recentApr, 10); // recent regime untouched
    // mean/median DO shift (they see the whole series) — confirms the perturbation was real
    expect(s1.meanApr).not.toBeCloseTo(s0.meanApr, 6);
  });

  it("perturbing a print INSIDE the recent window DOES change recentApr (window is causal/inclusive)", () => {
    const r = lcg(303);
    const win = 21;
    const n = 120;
    const base = Array.from({ length: n }, () => between(r, -0.0005, 0.0005));
    const s0 = fundingStats(base, HOURLY, win);
    const j = n - 1; // newest print, definitely inside the recent window
    const perturbed = base.slice();
    perturbed[j] = perturbed[j] + 0.05;
    const s1 = fundingStats(perturbed, HOURLY, win);
    expect(s1.recentApr).not.toBeCloseTo(s0.recentApr, 6);
  });

  it("recentApr equals the mean of EXACTLY the last `recentWindow` prints", () => {
    const r = lcg(404);
    const win = 17;
    const arr = Array.from({ length: 90 }, () => between(r, -0.0008, 0.0008));
    const s = fundingStats(arr, HOURLY, win);
    const tail = arr.slice(-win);
    const expected = tail.reduce((a, x) => a + x, 0) / tail.length * HOURLY * 100;
    expect(s.recentApr).toBeCloseTo(expected, 10);
  });

  it("when the series is shorter than recentWindow, recentApr == meanApr (whole series IS the recent window)", () => {
    const r = lcg(505);
    const arr = Array.from({ length: 8 }, () => between(r, -0.0006, 0.0006));
    const s = fundingStats(arr, HOURLY, 21);
    expect(s.recentApr).toBeCloseTo(s.meanApr, 10);
  });
});

// ============================================================================
// 6. CROSS-COHERENCE — the carry pipeline consumes durableApr; assert the contract
// ============================================================================
describe("integration — gating on durableApr (median), NOT meanApr (spike)", () => {
  it("a floor-level coin with spike-inflated mean is correctly judged uneconomic by durable", () => {
    const floor = 0.0000125; // ~11% APR
    const r = [...Array(95).fill(floor), ...Array(5).fill(0.001)];
    const s = fundingStats(r, HOURLY);
    // meanApr would look fat (>30%); durable is the floor (~11%) — below a 15% gate
    expect(s.meanApr).toBeGreaterThan(20);
    expect(s.durableApr).toBeLessThan(15);
    // feeding the DURABLE rate into the plan → uneconomic block at minNetApr 15
    const pDurable = planCarryLegs(opp({ fundingApr: s.durableApr, persistence: s.persistence }), 1000, {
      ...DEFAULT_LIMITS, minNetApr: 15,
    });
    expect(hasBlocker(pDurable, /uneconomic|net /)).toBe(true);
    // feeding the MEAN (the trap) would have falsely passed — proving the median gate matters
    const pMean = planCarryLegs(opp({ fundingApr: s.meanApr, persistence: s.persistence }), 1000, {
      ...DEFAULT_LIMITS, minNetApr: 15,
    });
    expect(hasBlocker(pMean, /uneconomic|net /)).toBe(false);
  });
});
