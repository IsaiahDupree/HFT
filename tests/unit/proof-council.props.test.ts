import { describe, it, expect } from "vitest";
import {
  proofCouncil, renderProofCouncil, wilsonLowerBound, DEFAULT_PROOF_THRESHOLDS,
  type StrategyEvidence, type ProofThresholds, type ProofVerdict,
} from "@/lib/backtest/proof-council";

// ──────────────────────────────────────────────────────────────────────────
// Deterministic seeded LCG (Numerical Recipes constants). No Math.random,
// no Date — every "randomized" case is fully reproducible across runs.
// ──────────────────────────────────────────────────────────────────────────
function lcg(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}
const randInt = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const randFloat = (rnd: () => number, lo: number, hi: number) => lo + rnd() * (hi - lo);

// A robustness-clean edge whose every gauntlet bar is cleared → ADVOCATE_APPROVED.
const HARDENED = (): StrategyEvidence => ({
  label: "mom-5d", bars: 800, feeBps: 10,
  oosSharpeAnn: 1.4, fullSharpeAnn: 1.6, oosHold: 5, variants: 6,
  pbo: 0.12, dsr: 0.98, cumPnlPct: 23, regimesCovered: 3,
});
const PENNY = (): StrategyEvidence => ({
  label: "penny", objective: "penny_lock", bars: 252, sampleUnit: "trades",
  feeBps: 0, nTrades: 252, winRate: 0.972, netRoiPct: 1.3,
});

const VERDICTS: ProofVerdict[] = ["ADVOCATE_APPROVED", "PROVE_IT", "REPAIR_FIRST"];

// ════════════════════════════════════════════════════════════════════════
describe("wilsonLowerBound — numeric invariants — properties", () => {
  it("always lands in [0,1] across a seeded sweep of (wins,n,z)", () => {
    const rnd = lcg(101);
    for (let i = 0; i < 200; i++) {
      const n = randInt(rnd, 1, 5000);
      const wins = randInt(rnd, 0, n);
      const z = randFloat(rnd, 0.5, 3.0);
      const lb = wilsonLowerBound(wins, n, z);
      expect(lb).toBeGreaterThanOrEqual(0);
      expect(lb).toBeLessThanOrEqual(1);
    }
  });

  it("never exceeds the observed win rate (it is a LOWER bound)", () => {
    const rnd = lcg(202);
    for (let i = 0; i < 200; i++) {
      const n = randInt(rnd, 1, 4000);
      const wins = randInt(rnd, 0, n);
      const rate = wins / n;
      const lb = wilsonLowerBound(wins, n);
      // tiny epsilon for float wobble
      expect(lb).toBeLessThanOrEqual(rate + 1e-12);
    }
  });

  it("at a fixed rate, more trials never lowers the floor (monotone non-decreasing in n)", () => {
    // rate held at 0.9 across multiplying sample sizes
    const ns = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let prev = -1;
    for (const n of ns) {
      const lb = wilsonLowerBound(Math.round(0.9 * n), n);
      expect(lb).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = lb;
    }
    // and it strictly improves end to end
    expect(wilsonLowerBound(4500, 5000)).toBeGreaterThan(wilsonLowerBound(9, 10));
  });

  it("at fixed rate, the floor converges UP toward the rate as n grows", () => {
    const rate = 0.75;
    const small = wilsonLowerBound(Math.round(rate * 30), 30);
    const big = wilsonLowerBound(Math.round(rate * 8000), 8000);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(rate); // still strictly a lower bound below the point estimate
    expect(rate - big).toBeLessThan(rate - small); // gap to the rate shrinks
  });

  it("a wider z (more confidence) never raises the lower bound", () => {
    const rnd = lcg(303);
    for (let i = 0; i < 60; i++) {
      const n = randInt(rnd, 5, 3000);
      const wins = randInt(rnd, 1, n - 1); // keep it off the 0/1 boundaries
      const tight = wilsonLowerBound(wins, n, 1.0);
      const wide = wilsonLowerBound(wins, n, 2.58);
      expect(wide).toBeLessThanOrEqual(tight + 1e-12);
    }
  });

  it("returns exactly 0 for any non-positive n", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(5, 0)).toBe(0);
    expect(wilsonLowerBound(3, -10)).toBe(0);
  });

  it("clamps wins outside [0,n]: wins>n behaves like a perfect record, wins<0 like zero wins", () => {
    // wins/n is clamped to [0,1] inside, so wins=2n collapses to rate=1
    expect(wilsonLowerBound(200, 100)).toBe(wilsonLowerBound(100, 100));
    expect(wilsonLowerBound(-50, 100)).toBe(wilsonLowerBound(0, 100));
  });

  it("a perfect record (wins=n) yields a floor strictly between 0 and 1 and rising with n", () => {
    const a = wilsonLowerBound(20, 20);
    const b = wilsonLowerBound(500, 500);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });

  it("a zero record (wins=0) yields exactly 0 regardless of n", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(0, 1000)).toBe(0);
  });

  it("is symmetric-ish: the floor for rate p is below 1 minus the ceiling intuition (p=0.5 stays under 0.5)", () => {
    const rnd = lcg(404);
    for (let i = 0; i < 40; i++) {
      const n = randInt(rnd, 4, 2000);
      const half = Math.round(0.5 * n);
      expect(wilsonLowerBound(half, n)).toBeLessThan(0.5);
    }
  });

  it("is a pure function — identical args give identical output (no hidden state)", () => {
    const rnd = lcg(505);
    for (let i = 0; i < 50; i++) {
      const n = randInt(rnd, 1, 1000);
      const wins = randInt(rnd, 0, n);
      const z = randFloat(rnd, 1, 2.6);
      expect(wilsonLowerBound(wins, n, z)).toBe(wilsonLowerBound(wins, n, z));
    }
  });

  it("default z (1.96 ≈ 95%) is the value used when z is omitted", () => {
    expect(wilsonLowerBound(90, 100)).toBe(wilsonLowerBound(90, 100, 1.96));
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — verdict is always one of three and structurally well-formed — properties", () => {
  it("returns a verdict from the closed set over a seeded fuzz of edge evidence", () => {
    const rnd = lcg(111);
    for (let i = 0; i < 250; i++) {
      const ev: StrategyEvidence = {
        label: `f${i}`,
        bars: randInt(rnd, 1, 1500),
        feeBps: randInt(rnd, 0, 50),
        oosSharpeAnn: rnd() < 0.8 ? randFloat(rnd, -1, 3) : undefined,
        oosHold: randInt(rnd, 0, 8),
        variants: randInt(rnd, 0, 8),
        pbo: rnd() < 0.8 ? randFloat(rnd, 0, 1) : undefined,
        dsr: rnd() < 0.8 ? randFloat(rnd, 0, 1) : undefined,
        cumPnlPct: rnd() < 0.8 ? randFloat(rnd, -30, 40) : undefined,
        regimesCovered: randInt(rnd, 0, 4),
        maxDdPct: rnd() < 0.6 ? randFloat(rnd, 0, 0.6) : undefined,
      };
      const r = proofCouncil(ev);
      expect(VERDICTS).toContain(r.verdict);
      expect(Array.isArray(r.advocate)).toBe(true);
      expect(Array.isArray(r.skeptic)).toBe(true);
      expect(typeof r.action).toBe("string");
      expect(r.action.length).toBeGreaterThan(0);
    }
  });

  it("REPAIR_FIRST always carries at least one skeptic blocker (never an empty blocker list)", () => {
    const rnd = lcg(222);
    let seen = 0;
    for (let i = 0; i < 300; i++) {
      const ev: StrategyEvidence = {
        label: "f", bars: randInt(rnd, 1, 1000), feeBps: 5,
        oosSharpeAnn: randFloat(rnd, -1, 2),
        cumPnlPct: randFloat(rnd, -20, 30),
        pbo: randFloat(rnd, 0, 1),
        maxDdPct: randFloat(rnd, 0, 0.6),
        oosHold: randInt(rnd, 0, 8), variants: randInt(rnd, 0, 8),
      };
      const r = proofCouncil(ev);
      if (r.verdict === "REPAIR_FIRST") { seen++; expect(r.skeptic.length).toBeGreaterThan(0); }
    }
    expect(seen).toBeGreaterThan(0); // the fuzz actually exercised the blocker path
  });

  it("PROVE_IT always carries at least one gap in the skeptic list", () => {
    const rnd = lcg(333);
    let seen = 0;
    for (let i = 0; i < 300; i++) {
      // bias toward no-blocker-but-incomplete: positive PnL, long sample, some stat missing
      const ev: StrategyEvidence = {
        label: "f", bars: randInt(rnd, 100, 1000), feeBps: 5,
        cumPnlPct: randFloat(rnd, 1, 30),
        oosSharpeAnn: rnd() < 0.5 ? randFloat(rnd, 0.1, 2) : undefined,
        pbo: rnd() < 0.5 ? randFloat(rnd, 0, 0.5) : undefined,
        dsr: rnd() < 0.5 ? randFloat(rnd, 0.5, 1) : undefined,
        regimesCovered: randInt(rnd, 0, 3),
      };
      const r = proofCouncil(ev);
      if (r.verdict === "PROVE_IT") { seen++; expect(r.skeptic.length).toBeGreaterThan(0); }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("ADVOCATE_APPROVED always carries exactly one skeptic line and it mentions the next proof", () => {
    const rnd = lcg(444);
    let seen = 0;
    for (let i = 0; i < 80; i++) {
      const ev = { ...HARDENED(), liveSmokeBars: rnd() < 0.5 ? randInt(rnd, 10, 500) : undefined };
      const r = proofCouncil(ev);
      if (r.verdict === "ADVOCATE_APPROVED") {
        seen++;
        expect(r.skeptic).toHaveLength(1);
        expect(r.skeptic[0]).toMatch(/no audit blockers/i);
        expect(r.skeptic[0]).toMatch(/live-smoke continuation/i);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("the action string is verdict-consistent (approve→promote, repair→do NOT deploy, prove→research)", () => {
    expect(proofCouncil(HARDENED()).action).toMatch(/promote/i);
    expect(proofCouncil({ ...HARDENED(), cumPnlPct: -5 }).action).toMatch(/do NOT deploy/i);
    expect(proofCouncil({ ...HARDENED(), dsr: 0.5 }).action).toMatch(/research/i);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — a strategy failing its own objective is never ADVOCATE_APPROVED — properties", () => {
  it("penny_lock with non-positive net ROI is never approved (fails the net-positive objective)", () => {
    const rnd = lcg(555);
    for (let i = 0; i < 120; i++) {
      const ev: StrategyEvidence = {
        ...PENNY(),
        nTrades: randInt(rnd, 100, 3000),
        winRate: randFloat(rnd, 0.9, 1),
        netRoiPct: -randFloat(rnd, 0, 5) - 1e-6, // strictly ≤ 0
      };
      expect(proofCouncil(ev).verdict).not.toBe("ADVOCATE_APPROVED");
      expect(proofCouncil(ev).verdict).toBe("REPAIR_FIRST");
    }
  });

  it("penny_lock with too-few trades is never approved (a high win rate isn't established)", () => {
    const rnd = lcg(666);
    for (let i = 0; i < 120; i++) {
      const n = randInt(rnd, 1, DEFAULT_PROOF_THRESHOLDS.pennyMinTrades - 1);
      const ev: StrategyEvidence = { ...PENNY(), nTrades: n, winRate: 1.0, netRoiPct: 3 };
      expect(proofCouncil(ev).verdict).not.toBe("ADVOCATE_APPROVED");
    }
  });

  it("penny_lock whose Wilson CI-low can't clear break-even is never approved", () => {
    // payoff +0.5/−1 → break-even 2/3 ≈ 66.7%; win rate kept BELOW that → CI-low far below
    const rnd = lcg(777);
    for (let i = 0; i < 80; i++) {
      const ev: StrategyEvidence = {
        ...PENNY(), nTrades: randInt(rnd, 100, 2000),
        winRate: randFloat(rnd, 0.45, 0.6), netRoiPct: randFloat(rnd, 0.01, 0.3),
        avgWinPct: 0.5, avgLossPct: 1,
      };
      expect(proofCouncil(ev).verdict).not.toBe("ADVOCATE_APPROVED");
    }
  });

  it("edge objective with a faded (≤0) OOS Sharpe is never approved (the edge claim is voided)", () => {
    const rnd = lcg(888);
    for (let i = 0; i < 120; i++) {
      const ev = { ...HARDENED(), oosSharpeAnn: -randFloat(rnd, 0, 1.5) };
      expect(proofCouncil(ev).verdict).not.toBe("ADVOCATE_APPROVED");
      expect(proofCouncil(ev).verdict).toBe("REPAIR_FIRST");
    }
  });

  it("edge objective with negative net-fee cumulative PnL is never approved", () => {
    const rnd = lcg(999);
    for (let i = 0; i < 120; i++) {
      const ev = { ...HARDENED(), cumPnlPct: -randFloat(rnd, 0.01, 30) };
      expect(proofCouncil(ev).verdict).toBe("REPAIR_FIRST");
    }
  });

  it("an exactly-zero OOS Sharpe is treated as faded (≤ 0 boundary) and blocks approval", () => {
    expect(proofCouncil({ ...HARDENED(), oosSharpeAnn: 0 }).verdict).toBe("REPAIR_FIRST");
  });

  it("an exactly-zero cumulative PnL is NOT a blocker (< 0 is the bar, not ≤ 0)", () => {
    // zero PnL removes the positive-PnL advocate line but is not negative → not a blocker
    const r = proofCouncil({ ...HARDENED(), cumPnlPct: 0 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /cumulative PnL/.test(a))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — maxDd ceiling is a universal monotone blocker — properties", () => {
  it("any drawdown strictly above the ceiling blocks approval under the edge objective", () => {
    const rnd = lcg(1212);
    const ceil = DEFAULT_PROOF_THRESHOLDS.ddCeil;
    for (let i = 0; i < 120; i++) {
      const dd = ceil + randFloat(rnd, 1e-4, 0.5);
      const r = proofCouncil({ ...HARDENED(), maxDdPct: dd });
      expect(r.verdict).toBe("REPAIR_FIRST");
      expect(r.skeptic.some((s) => /ceiling/.test(s))).toBe(true);
    }
  });

  it("a drawdown at or below the ceiling never adds a drawdown blocker (boundary is inclusive-OK)", () => {
    const rnd = lcg(1313);
    const ceil = DEFAULT_PROOF_THRESHOLDS.ddCeil;
    for (let i = 0; i < 120; i++) {
      const dd = randFloat(rnd, 0, ceil); // [0, ceil]
      const r = proofCouncil({ ...HARDENED(), maxDdPct: dd });
      expect(r.verdict).toBe("ADVOCATE_APPROVED");
      expect(r.advocate.some((a) => /within the .* ceiling/.test(a))).toBe(true);
    }
  });

  it("exactly AT the ceiling is allowed (the breach test is strict >)", () => {
    const r = proofCouncil({ ...HARDENED(), maxDdPct: DEFAULT_PROOF_THRESHOLDS.ddCeil });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
  });

  it("raising the ceiling threshold can rescue a previously-blocking drawdown (monotone in ddCeil)", () => {
    const dd = 0.35;
    expect(proofCouncil({ ...HARDENED(), maxDdPct: dd }).verdict).toBe("REPAIR_FIRST");
    const loose: ProofThresholds = { ...DEFAULT_PROOF_THRESHOLDS, ddCeil: 0.5 };
    expect(proofCouncil({ ...HARDENED(), maxDdPct: dd }, loose).verdict).toBe("ADVOCATE_APPROVED");
  });

  it("the ceiling also blocks the penny_lock objective for any over-ceiling drawdown", () => {
    const rnd = lcg(1414);
    for (let i = 0; i < 60; i++) {
      const dd = DEFAULT_PROOF_THRESHOLDS.ddCeil + randFloat(rnd, 1e-3, 0.4);
      const r = proofCouncil({ ...PENNY(), maxDdPct: dd });
      expect(r.verdict).toBe("REPAIR_FIRST");
      expect(r.skeptic.some((s) => /ceiling/.test(s))).toBe(true);
    }
  });

  it("lowering the ceiling can demote an otherwise-approved edge to REPAIR_FIRST", () => {
    const ev = { ...HARDENED(), maxDdPct: 0.2 };
    expect(proofCouncil(ev).verdict).toBe("ADVOCATE_APPROVED");
    const strict: ProofThresholds = { ...DEFAULT_PROOF_THRESHOLDS, ddCeil: 0.1 };
    expect(proofCouncil(ev, strict).verdict).toBe("REPAIR_FIRST");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — monotone threshold tightening never IMPROVES a verdict — properties", () => {
  // ordering of severity: APPROVED is "best", REPAIR_FIRST is "worst"
  const rank: Record<ProofVerdict, number> = { ADVOCATE_APPROVED: 2, PROVE_IT: 1, REPAIR_FIRST: 0 };

  it("a stricter DSR bar can only hold or worsen the verdict, never improve it", () => {
    const rnd = lcg(1515);
    for (let i = 0; i < 60; i++) {
      const ev = { ...HARDENED(), dsr: randFloat(rnd, 0.8, 1) };
      const base = proofCouncil(ev).verdict;
      const strict = proofCouncil(ev, { ...DEFAULT_PROOF_THRESHOLDS, dsrClean: 0.999 }).verdict;
      expect(rank[strict]).toBeLessThanOrEqual(rank[base]);
    }
  });

  it("a longer minBars requirement can only hold or worsen the verdict for a fixed sample", () => {
    const rnd = lcg(1616);
    for (let i = 0; i < 60; i++) {
      const bars = randInt(rnd, 40, 400);
      const ev = { ...HARDENED(), bars };
      const base = proofCouncil(ev).verdict;
      const strict = proofCouncil(ev, { ...DEFAULT_PROOF_THRESHOLDS, minBars: 500 }).verdict;
      expect(rank[strict]).toBeLessThanOrEqual(rank[base]);
    }
  });

  it("a stricter pboClean bar can only hold or worsen an approved edge", () => {
    const rnd = lcg(1717);
    for (let i = 0; i < 60; i++) {
      const ev = { ...HARDENED(), pbo: randFloat(rnd, 0, 0.29) };
      const base = proofCouncil(ev).verdict;
      const strict = proofCouncil(ev, { ...DEFAULT_PROOF_THRESHOLDS, pboClean: 0.05 }).verdict;
      expect(rank[strict]).toBeLessThanOrEqual(rank[base]);
    }
  });

  it("requiring more regimes can only hold or worsen the verdict", () => {
    const rnd = lcg(1818);
    for (let i = 0; i < 60; i++) {
      const ev = { ...HARDENED(), regimesCovered: randInt(rnd, 1, 3) };
      const base = proofCouncil(ev).verdict;
      const strict = proofCouncil(ev, { ...DEFAULT_PROOF_THRESHOLDS, minRegimes: 5 }).verdict;
      expect(rank[strict]).toBeLessThanOrEqual(rank[base]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — blockers dominate gaps (a REPAIR can never be a PROVE_IT) — properties", () => {
  it("adding a hard blocker to any PROVE_IT case forces REPAIR_FIRST", () => {
    const rnd = lcg(1919);
    for (let i = 0; i < 80; i++) {
      const base: StrategyEvidence = {
        label: "g", bars: randInt(rnd, 100, 800), feeBps: 5,
        cumPnlPct: randFloat(rnd, 1, 30),
        oosSharpeAnn: randFloat(rnd, 0.1, 2),
        // leave pbo/dsr out so it's a gap → PROVE_IT
      };
      // ensure the unmodified case is not already a blocker case
      const baseV = proofCouncil(base).verdict;
      if (baseV !== "PROVE_IT") continue;
      // now inject an over-ceiling drawdown blocker
      const withBlocker = { ...base, maxDdPct: 0.9 };
      expect(proofCouncil(withBlocker).verdict).toBe("REPAIR_FIRST");
    }
  });

  it("the advocate list survives a blocker — REPAIR_FIRST still states what was proven", () => {
    const r = proofCouncil({ ...HARDENED(), maxDdPct: 0.9 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.advocate.length).toBeGreaterThan(0); // balanced, not a one-sided pile-on
    expect(r.advocate.some((a) => /OOS ann\.Sharpe/.test(a))).toBe(true);
  });

  it("multiple simultaneous blockers all appear in the skeptic list", () => {
    const r = proofCouncil({ ...HARDENED(), bars: 5, cumPnlPct: -10, oosSharpeAnn: -1 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.length).toBeGreaterThanOrEqual(3);
    expect(r.skeptic.some((s) => /too short/.test(s))).toBe(true);
    expect(r.skeptic.some((s) => /negative/.test(s))).toBe(true);
    expect(r.skeptic.some((s) => /FADED/.test(s))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — OOS variant-hold selection logic — properties", () => {
  it("with >1 variants, holding at most half is a blocker; holding a majority is an advocate line", () => {
    // half or fewer → blocker
    const block = proofCouncil({ ...HARDENED(), oosHold: 3, variants: 6 }); // exactly half
    expect(block.verdict).toBe("REPAIR_FIRST");
    expect(block.skeptic.some((s) => /3\/6 variants held OOS/.test(s))).toBe(true);
    // strict majority → advocate, no block
    const ok = proofCouncil({ ...HARDENED(), oosHold: 5, variants: 6 });
    expect(ok.verdict).toBe("ADVOCATE_APPROVED");
    expect(ok.advocate.some((a) => /5\/6 variants held OOS/.test(a))).toBe(true);
  });

  it("a single-variant run (variants=1) is never blocked on the hold-fraction rule", () => {
    // the > 1 guard means variants=1 cannot trigger the selection-noise blocker
    const r = proofCouncil({ ...HARDENED(), oosHold: 0, variants: 1 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.skeptic.some((s) => /variants held OOS/.test(s))).toBe(false);
  });

  it("variants=0 yields an undefined hold fraction and contributes neither advocate nor blocker", () => {
    const r = proofCouncil({ ...HARDENED(), oosHold: 0, variants: 0 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /variants held OOS/.test(a))).toBe(false);
    expect(r.skeptic.some((s) => /variants held OOS/.test(s))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("renderProofCouncil — always lists advocate AND skeptic — properties", () => {
  it("every verdict renders a header, an action line, an advocate section and a skeptic section", () => {
    const cases: StrategyEvidence[] = [
      HARDENED(),
      { ...HARDENED(), dsr: 0.5 },        // PROVE_IT
      { ...HARDENED(), cumPnlPct: -10 },  // REPAIR_FIRST
      PENNY(),
      { ...PENNY(), netRoiPct: -1 },      // penny REPAIR_FIRST
    ];
    for (const ev of cases) {
      const r = proofCouncil(ev);
      const text = renderProofCouncil(r);
      expect(text).toMatch(new RegExp(`^PROOF COUNCIL: ${r.verdict}\\n`));
      expect(text).toContain("action: ");
      expect(text).toContain("\nadvocate:\n");
      expect(text).toContain("\nskeptic:\n");
    }
  });

  it("when the advocate list is empty, render substitutes the placeholder line (never an empty section)", () => {
    // no positive metrics at all → empty advocate; force a blocker so it routes through
    const ev: StrategyEvidence = { label: "bare", bars: 3, feeBps: 0 };
    const r = proofCouncil(ev);
    expect(r.advocate).toHaveLength(0);
    const text = renderProofCouncil(r);
    expect(text).toContain("+ (no metric cleared its bar)");
  });

  it("every advocate line is rendered with a leading '+ ' and every skeptic with a leading '- '", () => {
    const r = proofCouncil({ ...HARDENED(), dsr: 0.5 });
    const text = renderProofCouncil(r);
    for (const a of r.advocate) expect(text).toContain(`+ ${a}`);
    for (const s of r.skeptic) expect(text).toContain(`- ${s}`);
  });

  it("render is a total function over a seeded fuzz — never throws and always contains both sections", () => {
    const rnd = lcg(2020);
    for (let i = 0; i < 150; i++) {
      const ev: StrategyEvidence = {
        label: "z", bars: randInt(rnd, 1, 1000), feeBps: randInt(rnd, 0, 30),
        objective: rnd() < 0.4 ? "penny_lock" : "edge",
        nTrades: randInt(rnd, 0, 3000), winRate: randFloat(rnd, 0, 1),
        netRoiPct: rnd() < 0.7 ? randFloat(rnd, -5, 5) : undefined,
        cumPnlPct: rnd() < 0.7 ? randFloat(rnd, -20, 30) : undefined,
        oosSharpeAnn: rnd() < 0.5 ? randFloat(rnd, -1, 2) : undefined,
        pbo: rnd() < 0.5 ? randFloat(rnd, 0, 1) : undefined,
        dsr: rnd() < 0.5 ? randFloat(rnd, 0, 1) : undefined,
        maxDdPct: rnd() < 0.5 ? randFloat(rnd, 0, 0.6) : undefined,
      };
      const text = renderProofCouncil(proofCouncil(ev));
      expect(text).toContain("advocate:");
      expect(text).toContain("skeptic:");
      expect(text.split("\n")[0]).toMatch(/^PROOF COUNCIL: (ADVOCATE_APPROVED|PROVE_IT|REPAIR_FIRST)$/);
    }
  });

  it("the rendered text round-trips the verdict in its first line for any input", () => {
    const rnd = lcg(2121);
    for (let i = 0; i < 60; i++) {
      const ev = { ...HARDENED(), dsr: randFloat(rnd, 0.5, 1), maxDdPct: randFloat(rnd, 0, 0.5) };
      const r = proofCouncil(ev);
      expect(renderProofCouncil(r).startsWith(`PROOF COUNCIL: ${r.verdict}`)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — determinism + purity over the whole pipeline — properties", () => {
  it("identical evidence yields deeply-equal results across a seeded sweep (edge + penny)", () => {
    const rnd = lcg(2222);
    for (let i = 0; i < 120; i++) {
      const penny = rnd() < 0.5;
      const ev: StrategyEvidence = penny
        ? { ...PENNY(), nTrades: randInt(rnd, 0, 3000), winRate: randFloat(rnd, 0, 1), netRoiPct: rnd() < 0.7 ? randFloat(rnd, -3, 3) : undefined }
        : { ...HARDENED(), dsr: randFloat(rnd, 0.5, 1), pbo: randFloat(rnd, 0, 0.6), maxDdPct: randFloat(rnd, 0, 0.5) };
      expect(proofCouncil(ev)).toEqual(proofCouncil(ev));
    }
  });

  it("does not mutate the input evidence object", () => {
    const ev = { ...HARDENED(), maxDdPct: 0.1 };
    const snapshot = JSON.stringify(ev);
    proofCouncil(ev);
    expect(JSON.stringify(ev)).toBe(snapshot);
  });

  it("does not mutate the thresholds object", () => {
    const thr: ProofThresholds = { ...DEFAULT_PROOF_THRESHOLDS };
    const snapshot = JSON.stringify(thr);
    proofCouncil(HARDENED(), thr);
    expect(JSON.stringify(thr)).toBe(snapshot);
  });

  it("render is deterministic — same result renders byte-identical text every call", () => {
    const rnd = lcg(2323);
    for (let i = 0; i < 40; i++) {
      const ev = { ...HARDENED(), dsr: randFloat(rnd, 0.7, 1) };
      const r = proofCouncil(ev);
      expect(renderProofCouncil(r)).toBe(renderProofCouncil(r));
    }
  });

  it("a default-thresholds call equals an explicit-default-thresholds call", () => {
    const rnd = lcg(2424);
    for (let i = 0; i < 40; i++) {
      const ev = { ...HARDENED(), dsr: randFloat(rnd, 0.5, 1), maxDdPct: randFloat(rnd, 0, 0.6) };
      expect(proofCouncil(ev)).toEqual(proofCouncil(ev, DEFAULT_PROOF_THRESHOLDS));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — objective routing edge vs penny_lock — properties", () => {
  it("the objective field alone can flip a verdict for identical metrics (routing is real)", () => {
    const rnd = lcg(2525);
    let flips = 0;
    for (let i = 0; i < 60; i++) {
      const shared = {
        label: "r", bars: 252, sampleUnit: "trades", feeBps: 0,
        nTrades: randInt(rnd, 100, 1000), winRate: randFloat(rnd, 0.93, 1),
        netRoiPct: randFloat(rnd, 0.5, 3),
      } as const;
      const edgeV = proofCouncil({ ...shared, objective: "edge" }).verdict;
      const pennyV = proofCouncil({ ...shared, objective: "penny_lock" }).verdict;
      if (edgeV !== pennyV) flips++;
      // under edge, with no Sharpe/PBO/DSR the best it can be is PROVE_IT
      expect(edgeV).not.toBe("ADVOCATE_APPROVED");
    }
    expect(flips).toBeGreaterThan(0); // the two objectives genuinely diverge
  });

  it("an undefined objective defaults to the edge path (same as objective:'edge')", () => {
    const base = { label: "d", bars: 400, feeBps: 5, cumPnlPct: 4 } as const;
    expect(proofCouncil(base)).toEqual(proofCouncil({ ...base, objective: "edge" }));
  });

  it("penny_lock with a payoff requires the CI-low to clear break-even, not a fixed floor", () => {
    // break-even from payoff +2/−1 = 1/3 ≈ 33.3%; a modest 60% win on 500 clears it comfortably
    const r = proofCouncil({ ...PENNY(), nTrades: 500, winRate: 0.6, netRoiPct: 0.8, avgWinPct: 2, avgLossPct: 1 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /clears the 33\.3% break-even for a \+2%\/−1% payoff/.test(a))).toBe(true);
  });

  it("penny_lock without a payoff falls back to the configured win floor in its messaging", () => {
    const r = proofCouncil(PENNY()); // no avgWin/avgLoss given
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.skeptic[0]).toMatch(/payoff not given/i);
    const floorPct = (DEFAULT_PROOF_THRESHOLDS.pennyWinFloor * 100).toFixed(0);
    expect(r.skeptic[0]).toContain(`${floorPct}% floor`);
  });

  it("penny_lock samples named by sampleUnit propagate the unit into the messaging", () => {
    const r = proofCouncil({ ...PENNY(), sampleUnit: "fills", nTrades: 50, winRate: 1, netRoiPct: 1 });
    // too few trades → blocker that names the unit
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /sample only 50 fills/.test(s))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("proofCouncil — Wilson floor advocate line under the edge objective — properties", () => {
  it("a win-rate floor line appears only when BOTH winRate and a positive nTrades are present", () => {
    const withTrades = proofCouncil({ ...HARDENED(), winRate: 0.88, nTrades: 500 });
    expect(withTrades.advocate.some((a) => /Wilson floor/.test(a))).toBe(true);
    const noN = proofCouncil({ ...HARDENED(), winRate: 0.88, nTrades: 0 });
    expect(noN.advocate.some((a) => /Wilson floor/.test(a))).toBe(false);
    const noRate = proofCouncil({ ...HARDENED(), winRate: undefined, nTrades: 500 });
    expect(noRate.advocate.some((a) => /Wilson floor/.test(a))).toBe(false);
  });

  it("the rendered Wilson floor percentage matches wilsonLowerBound on the rounded win count", () => {
    const winRate = 0.904, nTrades = 1235;
    const r = proofCouncil({ ...HARDENED(), winRate, nTrades });
    const expected = (wilsonLowerBound(Math.round(winRate * nTrades), nTrades) * 100).toFixed(1);
    expect(r.advocate.some((a) => a.includes(`Wilson floor ${expected}%`))).toBe(true);
  });
});
