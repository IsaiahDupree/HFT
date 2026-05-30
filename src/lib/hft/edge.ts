// Edge calculator. Implements the user's "every trade must pass" formula:
//
//   expected_edge_bps > fees_bps + spread_bps + slippage_bps
//                     + latency_penalty_bps + adverse_selection_bps
//
// Splits into maker vs taker branches because the maker branch nets the
// rebate and ignores the spread-crossing cost.

import { Venue, roundTripFeeBps } from "./venues";

export type EdgeInputs = {
  /** Trade notional, USD. */
  notionalUsd: number;
  /** Operator's estimated true edge, in basis points (1 bp = 0.01%). */
  expectedEdgeBps: number;
  /** Top-of-book spread observed at the venue, basis points. */
  spreadBps: number;
  /** Operator's expected slippage on the trade, basis points. */
  slippageBps: number;
  /** Latency cost approximation — bps lost to stale fair value. */
  latencyPenaltyBps: number;
  /** Adverse-selection haircut — bps lost on average because you only fill when you're wrong. */
  adverseSelectionBps: number;
  /** "maker" places passive, "taker" crosses the spread. */
  side: "maker" | "taker";
  /** Trades per day. Drives the EV summary. */
  fillsPerDay: number;
  /** Fraction of placed orders that actually fill (0..1). */
  fillRate: number;
};

export type EdgeResult = {
  /** All-in cost in bps for one fill. */
  costBps: number;
  /** Expected edge minus cost, bps per fill. */
  netEdgeBps: number;
  /** True if netEdgeBps > 0. */
  passes: boolean;
  /** Net edge in dollars per fill. */
  perFillUsd: number;
  /** Expected fills per day = fillsPerDay * fillRate. */
  effectiveFillsPerDay: number;
  /** Daily PnL estimate (USD). */
  expectedDailyUsd: number;
  /** Annualised PnL estimate (USD). */
  expectedAnnualUsd: number;
  /** Breakeven required edge in bps (cost line). */
  breakevenEdgeBps: number;
};

const DEFAULT_INPUTS: Required<Pick<EdgeInputs, "spreadBps" | "slippageBps" | "latencyPenaltyBps" | "adverseSelectionBps" | "fillRate" | "fillsPerDay" | "side">> = {
  spreadBps: 4,
  slippageBps: 1,
  latencyPenaltyBps: 1,
  adverseSelectionBps: 2,
  fillRate: 0.4,
  fillsPerDay: 200,
  side: "maker",
};

export function computeEdge(venue: Venue, input: Partial<EdgeInputs> & { expectedEdgeBps: number; notionalUsd: number }): EdgeResult {
  const i: EdgeInputs = { ...DEFAULT_INPUTS, ...input } as EdgeInputs;
  const fees = roundTripFeeBps(venue, i.side);

  // Taker pays the crossed spread; maker captures it (or part of it) but
  // suffers adverse selection. We let the operator-supplied bps reflect that
  // separately — we don't double-count the spread on the maker branch.
  const spreadCost = i.side === "taker" ? i.spreadBps : 0;

  const costBps = fees + spreadCost + i.slippageBps + i.latencyPenaltyBps + i.adverseSelectionBps;
  const netEdgeBps = i.expectedEdgeBps - costBps;
  const perFillUsd = (netEdgeBps / 1e4) * i.notionalUsd;
  const effectiveFillsPerDay = i.fillsPerDay * i.fillRate;
  const expectedDailyUsd = perFillUsd * effectiveFillsPerDay;

  return {
    costBps,
    netEdgeBps,
    passes: netEdgeBps > 0,
    perFillUsd,
    effectiveFillsPerDay,
    expectedDailyUsd,
    expectedAnnualUsd: expectedDailyUsd * 365,
    breakevenEdgeBps: costBps,
  };
}

/** Rank venues by net expected PnL for a fixed strategy spec. */
export function rankVenues(
  venues: Venue[],
  input: Partial<EdgeInputs> & { expectedEdgeBps: number; notionalUsd: number },
): { venueId: string; venueName: string; result: EdgeResult }[] {
  return venues
    .map((v) => ({ venueId: v.id, venueName: v.name, result: computeEdge(v, input) }))
    .sort((a, b) => b.result.expectedDailyUsd - a.result.expectedDailyUsd);
}
