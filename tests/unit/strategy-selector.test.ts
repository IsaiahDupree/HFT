import { describe, it, expect } from "vitest";
import { strategyNetReturns, groundTruthBest, deterministicSelect, naiveSelect, majorityVote, scoreRun, type MarketFeatures, type Strategy } from "@/lib/exec/strategy-selector";

const F = (over: Partial<MarketFeatures> = {}): MarketFeatures => ({
  fundingApr: 0, fundingPersistence: 0.8, hedgeAvailable: true, basisAnnApr: 0, ivMinusRv: 0, stakeApy: 0, tailRisk: 0, riskFreeApr: 4.5, ...over,
});

describe("strategyNetReturns — the economic ground-truth", () => {
  it("unhedgeable funding is undeployable (−100), never the answer", () => {
    expect(strategyNetReturns(F({ fundingApr: 40, hedgeAvailable: false })).funding_carry).toBe(-100);
  });
  it("sit_out pays exactly the risk-free rate", () => {
    expect(strategyNetReturns(F({ riskFreeApr: 4.5 })).sit_out).toBe(4.5);
  });
  it("high tail risk haircuts every risky sleeve toward the floor", () => {
    const calm = strategyNetReturns(F({ basisAnnApr: 20, tailRisk: 0 })).calendar_basis;
    const stormy = strategyNetReturns(F({ basisAnnApr: 20, tailRisk: 1 })).calendar_basis;
    expect(stormy).toBeLessThan(calm);
  });
});

describe("groundTruthBest picks the economically dominant strategy", () => {
  it("fat hedgeable persistent funding, calm → funding_carry", () => {
    expect(groundTruthBest(F({ fundingApr: 30, fundingPersistence: 0.95, hedgeAvailable: true, tailRisk: 0.1 }))).toBe("funding_carry");
  });
  it("everything thin → sit_out (take the T-bill)", () => {
    // funding 6% (nets ~2.4 after fees), basis 3%, IV gap 2, stake 3% — all below the 4.5% risk-free floor
    expect(groundTruthBest(F({ fundingApr: 6, basisAnnApr: 3, ivMinusRv: 2, stakeApy: 3, riskFreeApr: 4.5 }))).toBe("sit_out");
  });
  it("steep contango, nothing else → calendar_basis", () => {
    expect(groundTruthBest(F({ basisAnnApr: 25, fundingApr: 11, riskFreeApr: 4.5 }))).toBe("calendar_basis");
  });
  it("wide implied−realized, calm → vol_risk_premium", () => {
    expect(groundTruthBest(F({ ivMinusRv: 30, tailRisk: 0.1, riskFreeApr: 4.5 }))).toBe("vol_risk_premium");
  });
});

describe("the controls", () => {
  it("deterministicSelect equals groundTruthBest on the same features (correct model)", () => {
    const f = F({ fundingApr: 25, hedgeAvailable: true, basisAnnApr: 8, tailRisk: 0.2 });
    expect(deterministicSelect(f)).toBe(groundTruthBest(f));
  });
  it("TRAP 1: fat funding but NO hedge — naive is fooled (picks funding), truth is not", () => {
    const f = F({ fundingApr: 45, hedgeAvailable: false, riskFreeApr: 4.5 });
    expect(naiveSelect(f)).toBe("funding_carry");          // fooled by the biggest raw number
    expect(groundTruthBest(f)).not.toBe("funding_carry");  // the hedge constraint rules it out
  });
  it("TRAP 2: fat IV gap but extreme tail — naive picks VRP, truth flees to safety", () => {
    const f = F({ ivMinusRv: 25, tailRisk: 1, basisAnnApr: 2, riskFreeApr: 4.5 });
    expect(naiveSelect(f)).toBe("vol_risk_premium");
    expect(groundTruthBest(f)).toBe("sit_out");
  });
});

describe("majorityVote", () => {
  it("returns the plurality pick", () => {
    expect(majorityVote(["funding_carry", "sit_out", "funding_carry"])).toBe("funding_carry");
  });
  it("breaks ties deterministically by STRATEGIES order", () => {
    expect(majorityVote(["sit_out", "funding_carry"])).toBe("funding_carry"); // funding_carry earlier in order
  });
});

describe("scoreRun", () => {
  it("computes exact-match accuracy and APR regret vs the clean net returns", () => {
    const truths: Strategy[] = ["funding_carry", "sit_out"];
    const picks: Strategy[] = ["funding_carry", "calendar_basis"];
    const nets = [
      { funding_carry: 20, calendar_basis: 5, vol_risk_premium: 0, staking_hedged: 0, sit_out: 4.5 },
      { funding_carry: 0, calendar_basis: 2, vol_risk_premium: 0, staking_hedged: 0, sit_out: 4.5 },
    ];
    const s = scoreRun(picks, truths, nets);
    expect(s.accuracy).toBe(0.5);                       // 1 of 2 exact
    expect(s.meanRegretApr).toBeCloseTo(((20 - 20) + (4.5 - 2)) / 2, 9); // regret only on the wrong pick
  });
});
