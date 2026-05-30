import { describe, expect, it } from "vitest";
import { solveArbLp, solveColumnGen, type LpOutcome, type LpConstraint } from "@/lib/polymarket/lp";

describe("solveArbLp — single-market basket", () => {
  it.each([
    { yes: 0.4, no: 0.5, expectArb: true },
    { yes: 0.45, no: 0.5, expectArb: true },
    { yes: 0.48, no: 0.47, expectArb: true },
    { yes: 0.5, no: 0.5, expectArb: false },
    { yes: 0.51, no: 0.5, expectArb: false },
    { yes: 0.6, no: 0.5, expectArb: false },
    { yes: 0.05, no: 0.05, expectArb: true },
    { yes: 0.01, no: 0.01, expectArb: true },
  ])("yes=$yes no=$no → arb=$expectArb", async ({ yes, no, expectArb }) => {
    const outcomes: LpOutcome[] = [
      { id: "y", price: yes, depth: 100, marketId: "m" },
      { id: "n", price: no, depth: 100, marketId: "m" },
    ];
    const r = await solveArbLp(outcomes);
    if (expectArb) {
      expect(r).not.toBeNull();
      expect(r!.edgeUsd).toBeGreaterThan(0);
      expect(r!.costUsd).toBeLessThan(r!.guaranteedPayoutUsd);
    } else {
      expect(r).toBeNull();
    }
  });

  it("returns null on empty outcomes", async () => {
    expect(await solveArbLp([])).toBeNull();
  });

  it("respects depth caps", async () => {
    const outcomes: LpOutcome[] = [
      { id: "y", price: 0.4, depth: 7, marketId: "m" },
      { id: "n", price: 0.4, depth: 7, marketId: "m" },
    ];
    const r = await solveArbLp(outcomes);
    expect(r!.basketShares).toBeLessThanOrEqual(7);
  });
});

describe("solveArbLp — multi-market with dependencies", () => {
  const cases = [
    {
      name: "dep prunes need for trump_no",
      outcomes: [
        { id: "trump_yes", price: 0.45, depth: 80, marketId: "A" },
        { id: "trump_no", price: 0.55, depth: 80, marketId: "A" },
        { id: "rep5_yes", price: 0.25, depth: 60, marketId: "B" },
        { id: "rep5_no", price: 0.65, depth: 60, marketId: "B" },
      ] as LpOutcome[],
      deps: [{ ifTrue: ["rep5_yes"], thenTrue: ["trump_yes"] }] as LpConstraint[],
      expectArb: true,
    },
    {
      name: "expensive markets, no arb",
      outcomes: [
        { id: "a_y", price: 0.7, depth: 50, marketId: "A" },
        { id: "a_n", price: 0.32, depth: 50, marketId: "A" },
        { id: "b_y", price: 0.6, depth: 50, marketId: "B" },
        { id: "b_n", price: 0.42, depth: 50, marketId: "B" },
      ] as LpOutcome[],
      deps: [] as LpConstraint[],
      expectArb: false,
    },
  ];

  it.each(cases)("$name", async ({ outcomes, deps, expectArb }) => {
    const r = await solveArbLp(outcomes, deps);
    if (expectArb) {
      expect(r).not.toBeNull();
      expect(r!.edgeUsd).toBeGreaterThan(0);
    } else {
      expect(r).toBeNull();
    }
  });
});

describe("solveColumnGen — agreement with direct LP", () => {
  it("matches direct LP on a 2-market problem", async () => {
    const outcomes: LpOutcome[] = [
      { id: "trump_yes", price: 0.45, depth: 80, marketId: "A" },
      { id: "trump_no", price: 0.55, depth: 80, marketId: "A" },
      { id: "rep5_yes", price: 0.25, depth: 60, marketId: "B" },
      { id: "rep5_no", price: 0.65, depth: 60, marketId: "B" },
    ];
    const deps: LpConstraint[] = [{ ifTrue: ["rep5_yes"], thenTrue: ["trump_yes"] }];
    const direct = await solveArbLp(outcomes, deps);
    const colGen = await solveColumnGen(outcomes, deps);
    expect(colGen!.edgeUsd).toBeCloseTo(direct!.edgeUsd, 4);
  });
});

describe("solveArbLp — parameterized 3-market grid", () => {
  // Sweep 3 markets with various ask combinations
  const priceLevels = [0.1, 0.3, 0.5, 0.7, 0.9];
  const cases: Array<{ a: number; b: number; c: number }> = [];
  for (const a of priceLevels) {
    for (const b of priceLevels) {
      for (const c of priceLevels) {
        cases.push({ a, b, c });
      }
    }
  }

  it.each(cases)("yes prices a=$a b=$b c=$c — handles cleanly", async ({ a, b, c }) => {
    const outcomes: LpOutcome[] = [
      { id: "A_y", price: a, depth: 50, marketId: "A" },
      { id: "A_n", price: 1 - a + 0.05, depth: 50, marketId: "A" },
      { id: "B_y", price: b, depth: 50, marketId: "B" },
      { id: "B_n", price: 1 - b + 0.05, depth: 50, marketId: "B" },
      { id: "C_y", price: c, depth: 50, marketId: "C" },
      { id: "C_n", price: 1 - c + 0.05, depth: 50, marketId: "C" },
    ];
    const r = await solveArbLp(outcomes);
    // Either a valid solution with positive edge, or null
    if (r) {
      expect(r.edgeUsd).toBeGreaterThan(0);
      expect(r.costUsd).toBeGreaterThan(0);
    }
  });
});
