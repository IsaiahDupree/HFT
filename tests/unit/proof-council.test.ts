import { describe, it, expect } from "vitest";
import {
  proofCouncil, renderProofCouncil, wilsonLowerBound, DEFAULT_PROOF_THRESHOLDS,
  type StrategyEvidence,
} from "@/lib/backtest/proof-council";

// A robustness-clean edge (clears every gauntlet bar).
const HARDENED = (): StrategyEvidence => ({
  label: "mom-5d", bars: 800, feeBps: 10,
  oosSharpeAnn: 1.4, fullSharpeAnn: 1.6, oosHold: 5, variants: 6,
  pbo: 0.12, dsr: 0.98, cumPnlPct: 23, regimesCovered: 3,
});

describe("proof-council — verdict logic", () => {
  it("ADVOCATE_APPROVED when every gauntlet bar is cleared", () => {
    const r = proofCouncil(HARDENED());
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.action).toMatch(/promote/i);
    expect(r.skeptic).toHaveLength(1);
    expect(r.skeptic[0]).toMatch(/no audit blockers.*live-smoke/i);
    // advocate states what is proven
    expect(r.advocate.some((a) => /OOS ann\.Sharpe 1\.40 HELD/.test(a))).toBe(true);
    expect(r.advocate.some((a) => /Deflated-Sharpe 0\.98/.test(a))).toBe(true);
    expect(r.advocate.some((a) => /PBO 0\.12/.test(a))).toBe(true);
    expect(r.advocate.some((a) => /cumulative PnL \+23\.0%/.test(a))).toBe(true);
  });

  it("PROVE_IT when robust OOS but Deflated-Sharpe is short of the bar", () => {
    const r = proofCouncil({ ...HARDENED(), dsr: 0.80 });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /Deflated-Sharpe 0\.80 short of 0\.95/.test(s))).toBe(true);
    expect(r.advocate.some((a) => /OOS ann\.Sharpe/.test(a))).toBe(true); // still advocates the real positives
  });

  it("PROVE_IT on borderline PBO (between clean and hard)", () => {
    const r = proofCouncil({ ...HARDENED(), pbo: 0.38 });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /PBO 0\.38 ≥ 0\.3/.test(s))).toBe(true);
  });

  it("PROVE_IT when only one regime is covered", () => {
    const r = proofCouncil({ ...HARDENED(), regimesCovered: 1 });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /1 market regime/.test(s))).toBe(true);
  });

  it("PROVE_IT when the robustness stats were never computed (e.g. a PnL-only run)", () => {
    const r = proofCouncil({ label: "x", bars: 400, feeBps: 5, cumPnlPct: 4, oosSharpeAnn: undefined, pbo: undefined, dsr: undefined });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /no walk-forward OOS Sharpe/.test(s))).toBe(true);
    expect(r.skeptic.some((s) => /PBO not computed/.test(s))).toBe(true);
    expect(r.skeptic.some((s) => /Deflated-Sharpe not computed/.test(s))).toBe(true);
  });
});

describe("proof-council — REPAIR_FIRST blockers", () => {
  it("faded OOS Sharpe (≤ 0) is a blocker", () => {
    const r = proofCouncil({ ...HARDENED(), oosSharpeAnn: -0.3 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /FADED out-of-sample/.test(s))).toBe(true);
  });
  it("overfit PBO (> hard) is a blocker", () => {
    const r = proofCouncil({ ...HARDENED(), pbo: 0.7 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /overfit/.test(s))).toBe(true);
  });
  it("negative net-fee PnL is a blocker", () => {
    const r = proofCouncil({ ...HARDENED(), cumPnlPct: -8 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /negative net of 10bps/.test(s))).toBe(true);
  });
  it("a too-short sample is a blocker (named by sampleUnit)", () => {
    const r = proofCouncil({ label: "dydx", bars: 5, sampleUnit: "fills", feeBps: 0, cumPnlPct: 0.5 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /sample only 5 fills/.test(s))).toBe(true);
  });
  it("a minority of variants holding OOS is a blocker (selection is noise)", () => {
    const r = proofCouncil({ ...HARDENED(), oosHold: 2, variants: 6 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /2\/6 variants held OOS/.test(s))).toBe(true);
  });
  it("blockers still surface the advocate's proven positives (balanced, not one-sided)", () => {
    const r = proofCouncil({ ...HARDENED(), oosSharpeAnn: -0.3 });
    expect(r.advocate.length).toBeGreaterThan(0); // the council still states what IS proven
  });
});

describe("proof-council — Wilson floor + win-rate advocate", () => {
  it("adds a Wilson-floor line when discrete win evidence is present", () => {
    const r = proofCouncil({ ...HARDENED(), winRate: 0.904, nTrades: 1235 });
    expect(r.advocate.some((a) => /win 90\.4% on 1235 trades, Wilson floor/.test(a))).toBe(true);
  });
  it("wilsonLowerBound is below the point estimate and tightens with n", () => {
    expect(wilsonLowerBound(90, 100)).toBeLessThan(0.9);
    expect(wilsonLowerBound(900, 1000)).toBeGreaterThan(wilsonLowerBound(90, 100)); // same rate, more n → higher floor
  });
  it("wilsonLowerBound is bounded to [0,1] and 0 on no trials", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeLessThanOrEqual(1);
    expect(wilsonLowerBound(0, 10)).toBeGreaterThanOrEqual(0);
  });
});

describe("proof-council — rendering + determinism", () => {
  it("renders the canonical PROOF COUNCIL block", () => {
    const text = renderProofCouncil(proofCouncil(HARDENED()));
    expect(text).toMatch(/^PROOF COUNCIL: ADVOCATE_APPROVED\naction: /);
    expect(text).toContain("\nadvocate:\n+ ");
    expect(text).toContain("\nskeptic:\n- ");
  });
  it("is deterministic", () => {
    expect(proofCouncil(HARDENED())).toEqual(proofCouncil(HARDENED()));
    expect(renderProofCouncil(proofCouncil({ ...HARDENED(), dsr: 0.8 }))).toBe(renderProofCouncil(proofCouncil({ ...HARDENED(), dsr: 0.8 })));
  });
  it("thresholds are configurable (a stricter DSR bar flips approve→prove-it)", () => {
    const strict = { ...DEFAULT_PROOF_THRESHOLDS, dsrClean: 0.99 };
    expect(proofCouncil(HARDENED()).verdict).toBe("ADVOCATE_APPROVED");
    expect(proofCouncil(HARDENED(), strict).verdict).toBe("PROVE_IT"); // dsr 0.98 < 0.99 now a gap
  });
});

describe("proof-council — penny-lock certainty objective", () => {
  it("a TINY positive ROI still gets a YES when the win rate is high enough", () => {
    const r = proofCouncil({ label: "penny", objective: "penny_lock", bars: 252, sampleUnit: "trades", feeBps: 0, nTrades: 252, winRate: 0.972, netRoiPct: 1.3 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.action).toMatch(/penny-lock candidate.*left-tail kill/i);
    expect(r.advocate.some((a) => /net ROI \+1\.3%.*net positive even if tiny/.test(a))).toBe(true);
    expect(r.advocate.some((a) => /win 97\.2% on 252 trades, Wilson CI-low 9\d\.\d%/.test(a))).toBe(true);
    expect(r.skeptic[0]).toMatch(/watch for win-rate decay/i);
  });

  it("the OBJECTIVE changes the verdict: the same tiny-ROI evidence is PROVE_IT under 'edge' but APPROVED under 'penny_lock'", () => {
    const base = { label: "x", bars: 252, sampleUnit: "trades", feeBps: 0, nTrades: 252, winRate: 0.972, netRoiPct: 1.3 } as const;
    expect(proofCouncil({ ...base, objective: "edge" }).verdict).toBe("PROVE_IT");          // no Sharpe/PBO/DSR → unproven as an "edge"
    expect(proofCouncil({ ...base, objective: "penny_lock" }).verdict).toBe("ADVOCATE_APPROVED");
  });

  it("with a payoff, it judges the CI-low against the BREAK-EVEN win rate", () => {
    // payoff +1%/−1% → break-even 50%; win 80% on 300 → CI-low well above 50%
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 300, feeBps: 0, nTrades: 300, winRate: 0.8, netRoiPct: 0.6, avgWinPct: 1, avgLossPct: 1 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /clears the 50\.0% break-even for a \+1%\/−1% payoff/.test(a))).toBe(true);
  });

  it("REPAIR_FIRST when the realized ROI is not net positive (fails its own objective)", () => {
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 300, feeBps: 0, nTrades: 300, winRate: 0.95, netRoiPct: -0.4 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /fails its own objective/.test(s))).toBe(true);
  });

  it("REPAIR_FIRST when the win-rate CI-low can't clear break-even (realized + could be luck)", () => {
    // payoff +0.5%/−1% → break-even ~66.7%; win 55% → CI-low far below → not provably repeatable
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 300, feeBps: 0, nTrades: 300, winRate: 0.55, netRoiPct: 0.1, avgWinPct: 0.5, avgLossPct: 1 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /not above the 66\.7% break-even/.test(s))).toBe(true);
  });

  it("REPAIR_FIRST on too few trades (a high win rate isn't established yet)", () => {
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 20, sampleUnit: "trades", feeBps: 0, nTrades: 20, winRate: 1.0, netRoiPct: 2 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /sample only 20 trades/.test(s))).toBe(true);
  });

  it("PROVE_IT when net positive + above break-even but the CI-low margin is razor-thin", () => {
    // payoff 1/1 → break-even 50%; win 54% on 2000 → CI-low ≈ 51.8% → margin < 2pts
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 2000, feeBps: 0, nTrades: 2000, winRate: 0.54, netRoiPct: 0.2, avgWinPct: 1, avgLossPct: 1 });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /margin over break-even is only.*pts/.test(s))).toBe(true);
  });

  it("PROVE_IT when net ROI was never measured (can't confirm the objective)", () => {
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 252, sampleUnit: "trades", feeBps: 0, nTrades: 252, winRate: 0.97 });
    expect(r.verdict).toBe("PROVE_IT");
    expect(r.skeptic.some((s) => /net ROI not measured/.test(s))).toBe(true);
  });

  it("renders + is deterministic for the penny-lock path", () => {
    const ev = { label: "p", objective: "penny_lock" as const, bars: 252, feeBps: 0, nTrades: 252, winRate: 0.972, netRoiPct: 1.3 };
    expect(renderProofCouncil(proofCouncil(ev))).toMatch(/^PROOF COUNCIL: ADVOCATE_APPROVED/);
    expect(proofCouncil(ev)).toEqual(proofCouncil(ev));
  });
});

describe("proof-council — drawdown ceiling (universal blocker)", () => {
  it("a drawdown over the ceiling is a REPAIR_FIRST blocker under the edge objective", () => {
    const r = proofCouncil({ ...HARDENED(), maxDdPct: 0.4 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /max drawdown 40\.0% > 25% ceiling/.test(s))).toBe(true);
  });
  it("a drawdown within the ceiling becomes an advocate line and does not block approval", () => {
    const r = proofCouncil({ ...HARDENED(), maxDdPct: 0.1 });
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /max drawdown 10\.0% within the 25% ceiling/.test(a))).toBe(true);
  });
  it("a drawdown over the ceiling blocks the penny-lock objective too", () => {
    const r = proofCouncil({ label: "p", objective: "penny_lock", bars: 252, feeBps: 0, nTrades: 252, winRate: 0.97, netRoiPct: 1.3, maxDdPct: 0.5 });
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /max drawdown 50\.0% > 25% ceiling/.test(s))).toBe(true);
  });
  it("the ceiling is configurable", () => {
    expect(proofCouncil({ ...HARDENED(), maxDdPct: 0.3 }).verdict).toBe("REPAIR_FIRST");                       // 30% > default 25%
    expect(proofCouncil({ ...HARDENED(), maxDdPct: 0.3 }, { ...DEFAULT_PROOF_THRESHOLDS, ddCeil: 0.4 }).verdict).toBe("ADVOCATE_APPROVED"); // raise ceiling → OK
  });
});
