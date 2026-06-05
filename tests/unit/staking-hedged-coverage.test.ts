import { describe, it, expect } from "vitest";
import {
  stakingHedgedReturns,
  plainFundingReturns,
  annualizedApr,
  feeRobustness,
  totalRiskHaircutYr,
  type StakingHedgedParams,
  type RiskHaircut,
} from "@/lib/exec/staking-hedged";

// ---- deterministic helpers (no platform RNG, no wall-clock) ----
// Numerical Recipes LCG → [0,1)
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
// per-day funding the short collects (positive = short receives), realistic magnitude
const randFunding = (r: () => number, n: number): number[] =>
  Array.from({ length: n }, () => between(r, -0.001, 0.002));
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const PERIODS = 365;
const ETH = 0.032, SOL = 0.07;

// closed-form per-period net (mirrors the lib) for arithmetic cross-checks
function expectedNet(f: number, i: number, p: Required<Pick<StakingHedgedParams, "stakeApy">> & StakingHedgedParams) {
  const periods = p.periodsPerYear ?? PERIODS;
  const yld = p.stakeApy / periods;
  const drag = (p.hedgeBpsYr ?? 0) / 1e4 / periods;
  const haircut = totalRiskHaircutYr(p.risk) / periods;
  const entry = i === 0 ? (p.entryBps ?? 0) / 1e4 : 0;
  const fund = Number.isFinite(f) ? f : 0;
  return yld + fund - drag - haircut - entry;
}

describe("totalRiskHaircutYr — the omitted-risk penalty aggregation", () => {
  it("sums the three penalty components (bps/yr → fraction/yr)", () => {
    expect(totalRiskHaircutYr({ unbondBpsYr: 100, slashingBpsYr: 50, depegBpsYr: 25 })).toBeCloseTo(175 / 1e4, 15);
  });

  it("empty/undefined haircut is exactly zero (default = no haircut)", () => {
    expect(totalRiskHaircutYr()).toBe(0);
    expect(totalRiskHaircutYr({})).toBe(0);
  });

  it("is monotone non-decreasing in every component", () => {
    const r = lcg(1);
    for (let t = 0; t < 40; t++) {
      const base: RiskHaircut = { unbondBpsYr: between(r, 0, 200), slashingBpsYr: between(r, 0, 200), depegBpsYr: between(r, 0, 200) };
      const more: RiskHaircut = { ...base, slashingBpsYr: (base.slashingBpsYr ?? 0) + between(r, 0, 100) };
      expect(totalRiskHaircutYr(more)).toBeGreaterThanOrEqual(totalRiskHaircutYr(base) - 1e-15);
    }
  });

  it("clamps negative / non-finite penalty components to 0 (a 'risk' can never ADD yield)", () => {
    expect(totalRiskHaircutYr({ unbondBpsYr: -100, slashingBpsYr: NaN, depegBpsYr: 50 })).toBeCloseTo(50 / 1e4, 15);
    expect(totalRiskHaircutYr({ unbondBpsYr: Infinity, slashingBpsYr: -Infinity })).toBe(0);
  });
});

describe("stakingHedgedReturns — net-yield arithmetic", () => {
  it("matches the closed form yld + funding − drag − haircut − entry at every period", () => {
    const r = lcg(2);
    const n = 30;
    const f = randFunding(r, n);
    const p: StakingHedgedParams = { stakeApy: ETH, hedgeBpsYr: 8, entryBps: 5, risk: { unbondBpsYr: 30, slashingBpsYr: 10, depegBpsYr: 20 } };
    const out = stakingHedgedReturns(f, p);
    expect(out).toHaveLength(n);
    out.forEach((v, i) => expect(v).toBeCloseTo(expectedNet(f[i], i, p), 15));
  });

  it("STAKING ADDS exactly stakeApy/periods over the plain funding control, period by period (sans entry/drag)", () => {
    const r = lcg(3);
    const n = 20;
    const f = randFunding(r, n);
    const staked = stakingHedgedReturns(f, { stakeApy: SOL, hedgeBpsYr: 0, entryBps: 0 });
    const plain = plainFundingReturns(f, { hedgeBpsYr: 0, entryBps: 0 });
    for (let i = 0; i < n; i++) expect(staked[i] - plain[i]).toBeCloseTo(SOL / PERIODS, 15);
  });

  it("the entry cost is charged ONCE on period 0 only (static hold ⇒ ~0 turnover after)", () => {
    const f = [0.0005, 0.0005, 0.0005, 0.0005];
    const withEntry = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 50 });
    const noEntry = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0 });
    expect(noEntry[0] - withEntry[0]).toBeCloseTo(50 / 1e4, 15); // period 0 differs by exactly the round-trip
    for (let i = 1; i < f.length; i++) expect(withEntry[i]).toBeCloseTo(noEntry[i], 15); // later periods identical
  });

  it("respects periodsPerYear: more periods → smaller per-period staking slice", () => {
    const f = [0, 0, 0];
    const daily = stakingHedgedReturns(f, { stakeApy: ETH, periodsPerYear: 365 });
    const hourly = stakingHedgedReturns(f, { stakeApy: ETH, periodsPerYear: 365 * 24 });
    expect(daily[1]).toBeCloseTo(ETH / 365, 15);
    expect(hourly[1]).toBeCloseTo(ETH / (365 * 24), 15);
    expect(hourly[1]).toBeLessThan(daily[1]);
  });

  it("non-finite funding contributes 0 funding that period (treated as if funding were 0)", () => {
    const bad = [NaN, Infinity, -Infinity, undefined, 0.001];
    const out = stakingHedgedReturns(bad, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 });
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(ETH / 365, 15); // just the staking slice, no funding, no entry (entry=0)
    expect(out[4]).toBeCloseTo(ETH / 365 + 0.001, 15);
  });

  it("does not mutate its input funding array", () => {
    const f = [0.001, -0.001, 0.0005];
    const copy = [...f];
    stakingHedgedReturns(f, { stakeApy: ETH });
    expect(f).toEqual(copy);
  });
});

describe("stakingHedgedReturns — economic SIGN correctness", () => {
  it("POSITIVE funding ADDS to the staking yield (short COLLECTS): net > the staking-only baseline", () => {
    const r = lcg(4);
    const n = 15;
    const fPos = Array.from({ length: n }, () => between(r, 0.0005, 0.003)); // strictly positive
    const staked = stakingHedgedReturns(fPos, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 });
    for (let i = 0; i < n; i++) expect(staked[i]).toBeGreaterThan(ETH / 365); // funding tailwind on top of yield
  });

  it("NEGATIVE funding DRAGS the staking yield (short PAYS): net < the staking-only baseline", () => {
    const r = lcg(5);
    const n = 15;
    const fNeg = Array.from({ length: n }, () => between(r, -0.003, -0.0005)); // strictly negative
    const staked = stakingHedgedReturns(fNeg, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 });
    for (let i = 0; i < n; i++) expect(staked[i]).toBeLessThan(ETH / 365);
  });

  it("funding sign symmetry: flipping funding sign reflects net around the staking-only baseline", () => {
    const r = lcg(6);
    const n = 18;
    const f = randFunding(r, n);
    const base = stakingHedgedReturns(f.map(() => 0), { stakeApy: SOL, entryBps: 0, hedgeBpsYr: 0 });
    const plus = stakingHedgedReturns(f, { stakeApy: SOL, entryBps: 0, hedgeBpsYr: 0 });
    const minus = stakingHedgedReturns(f.map((x) => -x), { stakeApy: SOL, entryBps: 0, hedgeBpsYr: 0 });
    for (let i = 0; i < n; i++) expect((plus[i] + minus[i]) / 2).toBeCloseTo(base[i], 15);
  });

  it("with positive structural funding the cumulative net beats the plain funding carry (staking is additive value)", () => {
    const r = lcg(7);
    const n = 90;
    const f = Array.from({ length: n }, () => between(r, -0.0005, 0.0015)); // structurally positive
    const staked = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 5, hedgeBpsYr: 0 });
    const plain = plainFundingReturns(f, { entryBps: 5, hedgeBpsYr: 0 });
    expect(sum(staked)).toBeGreaterThan(sum(plain)); // staking yield always ADDS over the same window
  });
});

describe("stakingHedgedReturns — fee / cost monotonicity", () => {
  it("higher hedge drag never INCREASES any per-period net return", () => {
    const r = lcg(8);
    const n = 30;
    const f = randFunding(r, n);
    const lo = stakingHedgedReturns(f, { stakeApy: ETH, hedgeBpsYr: 0 });
    const hi = stakingHedgedReturns(f, { stakeApy: ETH, hedgeBpsYr: 50 });
    for (let i = 0; i < n; i++) expect(hi[i]).toBeLessThanOrEqual(lo[i] + 1e-15);
  });

  it("higher entry cost never increases the period-0 net (and leaves later periods untouched)", () => {
    const r = lcg(9);
    const n = 12;
    const f = randFunding(r, n);
    const lo = stakingHedgedReturns(f, { stakeApy: SOL, entryBps: 0 });
    const hi = stakingHedgedReturns(f, { stakeApy: SOL, entryBps: 100 });
    expect(hi[0]).toBeLessThan(lo[0]);
    for (let i = 1; i < n; i++) expect(hi[i]).toBeCloseTo(lo[i], 15);
  });

  it("higher total cost never increases the SUMMED net return (drag is a non-negative aggregate)", () => {
    const r = lcg(10);
    const n = 40;
    const f = randFunding(r, n);
    const cheap = stakingHedgedReturns(f, { stakeApy: ETH, hedgeBpsYr: 0, entryBps: 0 });
    const dear = stakingHedgedReturns(f, { stakeApy: ETH, hedgeBpsYr: 80, entryBps: 30 });
    expect(sum(dear)).toBeLessThanOrEqual(sum(cheap) + 1e-12);
  });
});

describe("stakingHedgedReturns — the OMITTED-RISK haircut LOWERS net", () => {
  it("applying ANY risk haircut lowers every per-period net vs the no-haircut case", () => {
    const r = lcg(11);
    const n = 25;
    const f = randFunding(r, n);
    const clean = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 });
    const haircut = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0, risk: { unbondBpsYr: 40, slashingBpsYr: 20, depegBpsYr: 30 } });
    for (let i = 0; i < n; i++) expect(haircut[i]).toBeLessThan(clean[i]);
  });

  it("the haircut drop equals the summed penalty / periods, per period (each risk is an explicit, additive cost)", () => {
    const r = lcg(12);
    const n = 20;
    const f = randFunding(r, n);
    const risk: RiskHaircut = { unbondBpsYr: 35, slashingBpsYr: 15, depegBpsYr: 25 };
    const clean = stakingHedgedReturns(f, { stakeApy: SOL, entryBps: 0, hedgeBpsYr: 0 });
    const hc = stakingHedgedReturns(f, { stakeApy: SOL, entryBps: 0, hedgeBpsYr: 0, risk });
    const drop = (35 + 15 + 25) / 1e4 / PERIODS;
    for (let i = 0; i < n; i++) expect(clean[i] - hc[i]).toBeCloseTo(drop, 15);
  });

  it("each of the three named risks (unbond / slashing / depeg) independently lowers net", () => {
    const f = [0.0005, 0.0005, 0.0005];
    const base = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0 });
    for (const key of ["unbondBpsYr", "slashingBpsYr", "depegBpsYr"] as const) {
      const one = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, risk: { [key]: 50 } });
      one.forEach((v, i) => expect(v).toBeLessThan(base[i]));
    }
  });

  it("a big enough haircut can flip a marginally-positive carry NEGATIVE (the marketed APR was masking tail risk)", () => {
    const f = Array.from({ length: 60 }, () => 0); // pure staking yield, zero funding
    const marketed = annualizedApr(stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0 }), PERIODS);
    expect(marketed).toBeGreaterThan(0); // ~3.2% headline
    // unbond+slashing+depeg dwarf the 3.2% yield → risk-adjusted APR is negative
    const riskAdj = annualizedApr(stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, risk: { unbondBpsYr: 200, slashingBpsYr: 100, depegBpsYr: 100 } }), PERIODS);
    expect(riskAdj).toBeLessThan(0);
  });

  it("a zero/negative haircut is a no-op (defaults stay honest, never silently boost)", () => {
    const r = lcg(13);
    const f = randFunding(r, 15);
    const base = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0 });
    const zero = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, risk: { unbondBpsYr: 0 } });
    const neg = stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 0, risk: { unbondBpsYr: -500 } }); // clamped
    expect(zero).toEqual(base);
    expect(neg).toEqual(base);
  });
});

describe("plainFundingReturns — the staking-yield-free control", () => {
  it("carries NO staking yield: equals raw funding minus drag/entry", () => {
    const r = lcg(14);
    const n = 12;
    const f = randFunding(r, n);
    const out = plainFundingReturns(f, { hedgeBpsYr: 20, entryBps: 5 });
    const drag = 20 / 1e4 / PERIODS;
    out.forEach((v, i) => expect(v).toBeCloseTo(f[i] - drag - (i === 0 ? 5 / 1e4 : 0), 15));
  });

  it("zero funding + zero costs → exactly flat (a hedge with no funding and no yield earns nothing)", () => {
    const out = plainFundingReturns([0, 0, 0, 0], { hedgeBpsYr: 0, entryBps: 0 });
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("non-finite funding contributes 0 (no NaN leaks into the control)", () => {
    const out = plainFundingReturns([NaN, undefined, Infinity, 0.001], { hedgeBpsYr: 0, entryBps: 0 });
    expect(out.slice(0, 3).every((v) => v === 0)).toBe(true);
    expect(out[3]).toBeCloseTo(0.001, 15);
  });
});

describe("degenerate inputs", () => {
  it("empty funding → empty returns (both staked and plain)", () => {
    expect(stakingHedgedReturns([], { stakeApy: ETH })).toEqual([]);
    expect(plainFundingReturns([], { hedgeBpsYr: 0 })).toEqual([]);
    expect(annualizedApr([], PERIODS)).toBe(0);
  });

  it("ZERO stake yield collapses staking-hedged to the plain funding carry (no staking edge)", () => {
    const r = lcg(15);
    const f = randFunding(r, 20);
    const staked = stakingHedgedReturns(f, { stakeApy: 0, hedgeBpsYr: 7, entryBps: 5 });
    const plain = plainFundingReturns(f, { hedgeBpsYr: 7, entryBps: 5 });
    expect(staked).toEqual(plain);
  });

  it("ZERO funding leaves only the staking slice minus costs every period (constant after entry)", () => {
    const out = stakingHedgedReturns([0, 0, 0, 0, 0], { stakeApy: SOL, hedgeBpsYr: 0, entryBps: 0 });
    expect(out.every((v) => Math.abs(v - SOL / 365) < 1e-15)).toBe(true);
  });

  it("ZERO stake AND ZERO funding AND ZERO cost → exactly flat", () => {
    const out = stakingHedgedReturns([0, 0, 0], { stakeApy: 0, hedgeBpsYr: 0, entryBps: 0 });
    expect(out).toEqual([0, 0, 0]);
  });

  it("constant funding → constant net after period 0 (entry only hits the first period)", () => {
    const out = stakingHedgedReturns([0.0007, 0.0007, 0.0007, 0.0007], { stakeApy: ETH, entryBps: 5 });
    const tail = out.slice(1);
    expect(tail.every((v) => Math.abs(v - tail[0]) < 1e-15)).toBe(true);
    expect(out[0]).toBeLessThan(tail[0]); // period 0 paid the entry
  });
});

describe("annualizedApr", () => {
  it("equals mean-per-period × periodsPerYear", () => {
    const r = lcg(16);
    const ret = Array.from({ length: 50 }, () => between(r, -0.001, 0.001));
    expect(annualizedApr(ret, PERIODS)).toBeCloseTo((sum(ret) / ret.length) * PERIODS, 15);
  });
});

describe("feeRobustness — survives X bps/yr extra cost", () => {
  it("stress lowers the APR vs base (more cost ⇒ lower stressed net)", () => {
    const r = lcg(17);
    const f = randFunding(r, 90);
    const fr = feeRobustness(f, { stakeApy: ETH, entryBps: 5 }, 30, 0);
    expect(fr.stressAprNet).toBeLessThan(fr.baseAprNet);
    expect(fr.stressBpsYr).toBe(30);
  });

  it("is monotone in the stress: a bigger stress can only make stressAprNet smaller (never larger)", () => {
    const r = lcg(18);
    const f = randFunding(r, 80);
    const p: StakingHedgedParams = { stakeApy: SOL, entryBps: 5 };
    let prev = feeRobustness(f, p, 0, 0).stressAprNet;
    for (const s of [10, 25, 50, 100, 250]) {
      const cur = feeRobustness(f, p, s, 0).stressAprNet;
      expect(cur).toBeLessThanOrEqual(prev + 1e-12);
      prev = cur;
    }
  });

  it("survives is a boundary-inclusive gate at the floor (stressAprNet ≥ floor passes)", () => {
    // pure staking yield 3.2%/yr, no funding/entry → stressing by exactly 320 bps/yr lands net APR at ~0
    const f = Array.from({ length: 100 }, () => 0);
    const atFloor = feeRobustness(f, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 }, 320, 0);
    expect(atFloor.stressAprNet).toBeCloseTo(0, 9);
    expect(atFloor.survives).toBe(true); // ≥ floor is inclusive
    const below = feeRobustness(f, { stakeApy: ETH, entryBps: 0, hedgeBpsYr: 0 }, 321, 0);
    expect(below.stressAprNet).toBeLessThan(0);
    expect(below.survives).toBe(false);
  });

  it("a fat positive-funding carry survives a moderate stress; a thin one does not", () => {
    const fat = Array.from({ length: 120 }, () => 0.0015); // ~164%/yr funding — survives anything sane
    const thin = Array.from({ length: 120 }, () => 0);     // bare 3.2% staking yield only
    expect(feeRobustness(fat, { stakeApy: ETH, entryBps: 5 }, 100, 0).survives).toBe(true);
    expect(feeRobustness(thin, { stakeApy: ETH, entryBps: 5 }, 500, 0).survives).toBe(false);
  });

  it("the risk haircut is carried INTO the robustness check (a risk-laden carry is harder to survive)", () => {
    const r = lcg(19);
    const f = randFunding(r, 90);
    const clean = feeRobustness(f, { stakeApy: ETH, entryBps: 5 }, 20, 0);
    const risky = feeRobustness(f, { stakeApy: ETH, entryBps: 5, risk: { unbondBpsYr: 100, slashingBpsYr: 50, depegBpsYr: 50 } }, 20, 0);
    expect(risky.stressAprNet).toBeLessThan(clean.stressAprNet);
  });

  it("negative / non-finite stress is clamped to 0 (no negative 'stress' that secretly ADDS yield)", () => {
    const r = lcg(20);
    const f = randFunding(r, 40);
    const p: StakingHedgedParams = { stakeApy: ETH, entryBps: 5 };
    const base = feeRobustness(f, p, 0, 0);
    expect(feeRobustness(f, p, -100, 0).stressAprNet).toBeCloseTo(base.stressAprNet, 12);
    expect(feeRobustness(f, p, NaN, 0).stressAprNet).toBeCloseTo(base.stressAprNet, 12);
  });
});

describe("NO-LOOKAHEAD — period i depends only on inputs ≤ i", () => {
  it("perturbing an INTERIOR funding[k] changes ONLY the net at period k (never a past/other period)", () => {
    const r = lcg(21);
    const n = 30;
    const f = randFunding(r, n);
    const p: StakingHedgedParams = { stakeApy: ETH, entryBps: 5, hedgeBpsYr: 8, risk: { unbondBpsYr: 30 } };
    const base = stakingHedgedReturns(f, p);
    const k = 13;
    const f2 = [...f];
    f2[k] = f2[k] + 0.05; // strong perturbation of a single interior funding print
    const pert = stakingHedgedReturns(f2, p);
    for (let i = 0; i < n; i++) {
      if (i === k) expect(pert[i]).not.toBeCloseTo(base[i], 12);
      else expect(pert[i]).toBeCloseTo(base[i], 15);
    }
  });

  it("perturbing a FUTURE funding value cannot change any earlier net (strictly causal)", () => {
    const r = lcg(22);
    const n = 25;
    const f = randFunding(r, n);
    const p: StakingHedgedParams = { stakeApy: SOL, entryBps: 5 };
    const base = stakingHedgedReturns(f, p);
    const k = 18;
    const f2 = [...f];
    f2[k] = 9; // absurd future spike
    const pert = stakingHedgedReturns(f2, p);
    expect(pert.slice(0, k)).toEqual(base.slice(0, k)); // prefix unchanged
  });

  it("appending future periods never rewrites the prefix net (streaming-stable)", () => {
    const r = lcg(23);
    const head = randFunding(r, 20);
    const tail = randFunding(r, 15);
    const p: StakingHedgedParams = { stakeApy: ETH, entryBps: 5, hedgeBpsYr: 8 };
    const headOut = stakingHedgedReturns(head, p);
    const fullOut = stakingHedgedReturns([...head, ...tail], p);
    expect(fullOut.slice(0, head.length)).toEqual(headOut);
  });

  it("plainFundingReturns is equally causal (interior perturbation is local)", () => {
    const r = lcg(24);
    const n = 28;
    const f = randFunding(r, n);
    const base = plainFundingReturns(f, { hedgeBpsYr: 10, entryBps: 5 });
    const k = 11;
    const f2 = [...f];
    f2[k] = f2[k] - 0.04;
    const pert = plainFundingReturns(f2, { hedgeBpsYr: 10, entryBps: 5 });
    for (let i = 0; i < n; i++) {
      if (i === k) expect(pert[i]).not.toBeCloseTo(base[i], 12);
      else expect(pert[i]).toBeCloseTo(base[i], 15);
    }
  });
});

describe("determinism", () => {
  it("same inputs reproduce identical net-return vectors", () => {
    const build = () => {
      const r = lcg(77);
      const f = randFunding(r, 30);
      return stakingHedgedReturns(f, { stakeApy: ETH, entryBps: 5, hedgeBpsYr: 8, risk: { unbondBpsYr: 40, slashingBpsYr: 20, depegBpsYr: 30 } });
    };
    expect(build()).toEqual(build());
  });
});
