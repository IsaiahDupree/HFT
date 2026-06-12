/**
 * Unit tests for the binary-maker quote engine. Deterministic. We verify:
 *   - quotes center on pFair (not the market mid), straddling it
 *   - the min-edge gate withdraws a side whose edge < min
 *   - inventory skew shifts the reservation the correct direction
 *   - the hard inventory cap withdraws the side that would breach it
 *   - the AS boundary cap withdraws both sides at extreme inventory
 *   - rebate credit widens the effective edge (richer category posts more)
 *   - book-aware posting never crosses the touch
 *   - mergeableSets accounting
 */
import { describe, it, expect } from "vitest";
import { planQuotes, mergeableSets, type BinaryMakerParams } from "@/lib/strategies/binary-maker";
import type { ASParams } from "@/lib/strategies/as-market-maker";

const AS: ASParams = { gamma: 0.1, sigma: 0.3, kappa: 1.5, T: 1 };

function params(over: Partial<BinaryMakerParams> = {}): BinaryMakerParams {
  return {
    baseHalfSpread: 0.02,
    minEdge: 0.005,
    quoteSizeShares: 100,
    maxInventoryShares: 500,
    feeCategory: "crypto",
    as: AS,
    boundaryM: 200,
    ...over,
  };
}

describe("planQuotes", () => {
  it("centers two-sided quotes around pFair, straddling it", () => {
    const plan = planQuotes({ pFair: 0.6, inventoryShares: 0, t: 0, params: params() });
    expect(plan.active).toBe(true);
    expect(plan.yesBid.px).toBeLessThan(0.6);
    expect(plan.yesAsk.px).toBeGreaterThan(0.6);
    expect(plan.yesBid.sz).toBe(100);
    expect(plan.yesAsk.sz).toBe(100);
  });

  it("does NOT center on a stale market mid — only pFair matters", () => {
    // Two different books, same pFair → same center (book only prevents crossing).
    const a = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params(), book: { bestBid: 0.40, bestAsk: 0.42 } });
    const b = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params(), book: { bestBid: 0.58, bestAsk: 0.60 } });
    // The reservation (fair center) is identical regardless of where the market is quoting.
    expect(a.reservationP).toBeCloseTo(b.reservationP, 9);
  });

  it("withdraws a side whose edge is below minEdge", () => {
    // Tiny half-spread but a high min-edge → both sides too thin to post.
    const plan = planQuotes({
      pFair: 0.5,
      inventoryShares: 0,
      t: 0,
      params: params({ baseHalfSpread: 0.002, minEdge: 0.05 }),
    });
    expect(plan.yesBid.sz).toBe(0);
    expect(plan.yesAsk.sz).toBe(0);
    expect(plan.active).toBe(false);
  });

  it("skews the reservation DOWN when long inventory (wants to sell)", () => {
    // Keep |inv| under the AS boundary cap (at p=0.5, M=200 → cap 100).
    const flat = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params() });
    const long = planQuotes({ pFair: 0.5, inventoryShares: 50, t: 0, params: params() });
    expect(long.reservationP).toBeLessThan(flat.reservationP);
  });

  it("skews the reservation UP when short inventory (wants to buy)", () => {
    const flat = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params() });
    const short = planQuotes({ pFair: 0.5, inventoryShares: -50, t: 0, params: params() });
    expect(short.reservationP).toBeGreaterThan(flat.reservationP);
  });

  it("withdraws the buy side at the hard inventory cap (boundary M set high so the cap binds)", () => {
    const plan = planQuotes({
      pFair: 0.5,
      inventoryShares: 450, // +100 would breach 500
      t: 0,
      params: params({ maxInventoryShares: 500, boundaryM: 100000 }),
    });
    expect(plan.yesBid.sz).toBe(0);
    expect(plan.yesBid.reason).toMatch(/inv cap/);
    // sell side may still be active (reduces inventory) if it clears the edge gate
  });

  it("withdraws both sides past the AS boundary cap (inventory near boundary)", () => {
    // boundaryCap = floor(M·√(p(1-p))); at p=0.5, M=200 → cap 100. inv 150 > cap.
    const plan = planQuotes({
      pFair: 0.5,
      inventoryShares: 150,
      t: 0,
      params: params({ boundaryM: 200, maxInventoryShares: 100000 }),
    });
    expect(plan.active).toBe(false);
    expect(plan.note).toMatch(/boundary/);
  });

  it("richer rebate category produces a larger posted edge at the same price", () => {
    const cryptoEdge = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params({ feeCategory: "crypto" }) }).yesBid.edge;
    const financeEdge = planQuotes({ pFair: 0.5, inventoryShares: 0, t: 0, params: params({ feeCategory: "finance" }) }).yesBid.edge;
    // finance = 50% rebate share vs crypto 20% → more rebate credit → larger net edge.
    expect(financeEdge).toBeGreaterThan(cryptoEdge);
  });

  it("may post inside the spread but never crosses the touch", () => {
    // Wide market 0.45/0.55, tight fair-centered quotes 0.49/0.51 → should post
    // INSIDE the spread (improving the touch), not get pinned to the touch.
    const plan = planQuotes({
      pFair: 0.5,
      inventoryShares: 0,
      t: 0,
      params: params({ baseHalfSpread: 0.01, minEdge: 0.0001 }),
      book: { bestBid: 0.45, bestAsk: 0.55 },
    });
    // never marketable: bid strictly below bestAsk, ask strictly above bestBid.
    if (plan.yesBid.sz > 0) expect(plan.yesBid.px).toBeLessThan(0.55);
    if (plan.yesAsk.sz > 0) expect(plan.yesAsk.px).toBeGreaterThan(0.45);
    // and here it genuinely improves (posts inside 0.45/0.55).
    expect(plan.yesBid.px).toBeGreaterThan(0.45);
    expect(plan.yesAsk.px).toBeLessThan(0.55);
  });

  it("clamps a crossing quote back to non-marketable when fair is past the touch", () => {
    // Fair 0.60 but market is 0.45/0.55: our bid would be ~0.59 (≥ bestAsk) → clamp below ask.
    const plan = planQuotes({
      pFair: 0.6,
      inventoryShares: 0,
      t: 0,
      params: params({ baseHalfSpread: 0.01, minEdge: 0.0001 }),
      book: { bestBid: 0.45, bestAsk: 0.55 },
    });
    if (plan.yesBid.sz > 0) expect(plan.yesBid.px).toBeLessThan(0.55);
  });

  it("quotes stay strictly inside (0,1)", () => {
    for (const pFair of [0.02, 0.1, 0.5, 0.9, 0.98]) {
      const plan = planQuotes({ pFair, inventoryShares: 0, t: 0, params: params() });
      expect(plan.yesBid.px).toBeGreaterThan(0);
      expect(plan.yesBid.px).toBeLessThan(1);
      expect(plan.yesAsk.px).toBeGreaterThan(0);
      expect(plan.yesAsk.px).toBeLessThan(1);
    }
  });

  it("returns inactive on an unusable fair value", () => {
    expect(planQuotes({ pFair: 0, inventoryShares: 0, t: 0, params: params() }).active).toBe(false);
    expect(planQuotes({ pFair: 1, inventoryShares: 0, t: 0, params: params() }).active).toBe(false);
    expect(planQuotes({ pFair: NaN, inventoryShares: 0, t: 0, params: params() }).active).toBe(false);
  });
});

describe("mergeableSets", () => {
  it("merges the matched min(yes,no) shares and books the discount as profit", () => {
    // bought 100 Yes @0.48 and 100 No @0.49 → pair cost 0.97 → $0.03/set profit
    const r = mergeableSets(100, 100, 0.48, 0.49);
    expect(r.sets).toBe(100);
    expect(r.profitUsd).toBeCloseTo(100 * 0.03, 9);
  });
  it("limited by the shallower leg", () => {
    expect(mergeableSets(100, 30, 0.5, 0.45).sets).toBe(30);
  });
  it("zero when a leg is empty or negative", () => {
    expect(mergeableSets(100, 0, 0.5, 0.5).sets).toBe(0);
    expect(mergeableSets(-5, 100, 0.5, 0.5).sets).toBe(0);
  });
  it("negative profit if the pair cost more than $1 (a loss to merge)", () => {
    const r = mergeableSets(10, 10, 0.6, 0.55); // pair 1.15 > 1
    expect(r.profitUsd).toBeLessThan(0);
  });
});
