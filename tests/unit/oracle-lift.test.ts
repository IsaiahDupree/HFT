/**
 * Tests for oracle signal lift (PRD-04 #1/#2 measurability): the Wilson lower
 * bound and the win-rate lift by agreement band / side-straddle / Chainlink zone.
 * Pure — no DB / network.
 */
import { describe, expect, it } from "vitest";
import { wilsonLower, oracleLift, type OraclePair } from "@/lib/oracle/lift";

function pair(over: Partial<OraclePair>): OraclePair {
  return {
    agreement_score: 0.9,
    side_agree: true,
    chainlink_zone: "fresh",
    favored_up: true,
    resolved_up: true,
    ...over,
  };
}

describe("wilsonLower", () => {
  it("is 0 for no samples", () => {
    expect(wilsonLower(0, 0)).toBe(0);
  });
  it("is below the point estimate and within [0,1]", () => {
    const lo = wilsonLower(9, 10);
    expect(lo).toBeLessThan(0.9);
    expect(lo).toBeGreaterThan(0.5);
  });
  it("tightens toward p as n grows", () => {
    expect(wilsonLower(90, 100)).toBeGreaterThan(wilsonLower(9, 10));
  });
});

describe("oracleLift", () => {
  it("high agreement wins more than a straddle (the hypothesis)", () => {
    const pairs: OraclePair[] = [
      // 10 high-agreement windows: favored side wins
      ...Array.from({ length: 10 }, () => pair({ agreement_score: 0.9, side_agree: true, favored_up: true, resolved_up: true })),
      // 10 straddle windows: coin-flippy (half the favored side loses)
      ...Array.from({ length: 10 }, (_, i) =>
        pair({ agreement_score: 0.4, side_agree: false, favored_up: true, resolved_up: i % 2 === 0 }),
      ),
    ];
    const lift = oracleLift(pairs);
    const hi = lift.byAgreement.find((b) => b.label === "agree ≥0.75")!;
    const straddle = lift.bySideAgree.find((b) => b.label === "side STRADDLE")!;
    expect(hi.n).toBe(10);
    expect(hi.win).toBe(1.0);
    expect(hi.winLift).toBeGreaterThan(0); // beats the 75% blended baseline
    expect(straddle.win).toBeCloseTo(0.5, 1);
    expect(straddle.winLift).toBeLessThan(0); // straddles win less
  });

  it("stale chainlink bucket isolates the stale windows", () => {
    const pairs: OraclePair[] = [
      ...Array.from({ length: 5 }, () => pair({ chainlink_zone: "fresh", favored_up: true, resolved_up: true })),
      ...Array.from({ length: 5 }, () => pair({ chainlink_zone: "stale", favored_up: true, resolved_up: false })),
    ];
    const lift = oracleLift(pairs);
    const stale = lift.byZone.find((b) => b.label === "chainlink stale")!;
    expect(stale.n).toBe(5);
    expect(stale.win).toBe(0); // all the stale windows flipped against the favored side
    expect(stale.winLift).toBeLessThan(0);
  });

  it("empty input yields zeroed baseline", () => {
    const lift = oracleLift([]);
    expect(lift.baseline.n).toBe(0);
    expect(lift.baseline.win).toBe(0);
  });
});
