/**
 * Quick smoke tests of the LP-based arb solver. Run with `npx tsx scripts/test-lp.ts`.
 * Three cases:
 *  1. Single-market YES+NO arb (asks sum to 0.95) — should find a basket buy.
 *  2. Single-market with asks summing to $1.02 — should return null.
 *  3. Two-market dependency arb (Trump wins PA AND Republicans win PA by 5+).
 */
import "./_env.ts";
import { solveArbLp, solveColumnGen, type LpOutcome } from "../src/lib/polymarket/lp.ts";

async function run() {
  console.log("Case 1: single-market arb (0.48 + 0.47 = 0.95)");
  const c1: LpOutcome[] = [
    { id: "yes", price: 0.48, depth: 100, marketId: "m1" },
    { id: "no", price: 0.47, depth: 100, marketId: "m1" },
  ];
  console.log("  ", await solveArbLp(c1));

  console.log("\nCase 2: no arb (0.52 + 0.50 = 1.02)");
  const c2: LpOutcome[] = [
    { id: "yes", price: 0.52, depth: 100, marketId: "m1" },
    { id: "no", price: 0.50, depth: 100, marketId: "m1" },
  ];
  console.log("  ", await solveArbLp(c2));

  console.log("\nCase 3: two-market dependency arb");
  // Market A: Trump wins PA — YES(0.45) / NO(0.55)
  // Market B: Republicans win PA by 5+ — YES(0.25) / NO(0.65)  → sum=0.90, naive arb already
  // Dependency: "Republicans 5+" → "Trump wins PA"  (if B_yes then A_yes)
  // Combined arb: short Trump_no, long Republicans_yes? Actually for our purposes the LP
  // will discover the basket that costs least and pays $1 in every state.
  const c3: LpOutcome[] = [
    { id: "trump_yes", price: 0.45, depth: 80, marketId: "A" },
    { id: "trump_no", price: 0.55, depth: 80, marketId: "A" },
    { id: "rep5_yes", price: 0.25, depth: 60, marketId: "B" },
    { id: "rep5_no", price: 0.65, depth: 60, marketId: "B" },
  ];
  console.log("  no constraints:", await solveArbLp(c3, []));
  console.log("  with rep5_yes → trump_yes:", await solveArbLp(c3, [{ ifTrue: ["rep5_yes"], thenTrue: ["trump_yes"] }]));

  console.log("\nCase 4: column-generation (same as Case 3 but routed through solveColumnGen)");
  console.log("  ", await solveColumnGen(c3, [{ ifTrue: ["rep5_yes"], thenTrue: ["trump_yes"] }]));
}

run().catch((err) => { console.error(err); process.exit(1); });
