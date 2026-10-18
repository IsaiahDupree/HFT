// Curated HFT-style strategies across venues, used for the side-by-side ranker.
// Each strategy is parameterised so the UI can rank them under a single
// "operator capital + latency + horizon" choice and the same fee assumptions
// surfaced in venues.ts.

import { Venue, venueById } from "./venues";
import { EdgeInputs, computeEdge, EdgeResult } from "./edge";
import { evalPolyBtc, PolyBtcResult, POLY_BTC_STRATEGIES } from "./polymarket-btc";

export type StrategyKind = "spot-mm" | "perp-mm" | "lead-lag" | "basis-arb" | "binary-mm" | "binary-news";

export type HftStrategy = {
  id: string;
  name: string;
  venueId: string;
  kind: StrategyKind;
  description: string;
  /** "How realistic is this for a small/medium operator?" 1..5 */
  practicality: 1 | 2 | 3 | 4 | 5;
  /** Inputs the calculator uses by default. */
  defaults: Partial<EdgeInputs> & { expectedEdgeBps: number };
};

export const HFT_STRATEGIES: HftStrategy[] = [
  {
    id: "cb-advanced-eth-usdc-maker",
    name: "Coinbase Advanced — ETH/USDC maker",
    venueId: "coinbase-advanced",
    kind: "spot-mm",
    description:
      "Quote post-only bids/asks around fair value derived from Kraken+Binance. Capture spread + (sometimes) maker rebate when tiered.",
    practicality: 4,
    defaults: { expectedEdgeBps: 8, side: "maker", spreadBps: 6, slippageBps: 1, latencyPenaltyBps: 3, adverseSelectionBps: 2, fillsPerDay: 120, fillRate: 0.35 },
  },
  {
    id: "cb-exchange-fix-eth-usdc-maker",
    name: "Coinbase Exchange FIX — ETH/USDC maker",
    venueId: "coinbase-exchange",
    kind: "spot-mm",
    description:
      "Institutional FIX 4.4 order entry, low-latency cancels. Suitable for tight quoting and arb against other CEX venues.",
    practicality: 3,
    defaults: { expectedEdgeBps: 6, side: "maker", spreadBps: 3, slippageBps: 0.5, latencyPenaltyBps: 0.5, adverseSelectionBps: 1.5, fillsPerDay: 400, fillRate: 0.5 },
  },
  {
    id: "hyperliquid-btc-perp-mm",
    name: "Hyperliquid — BTC-PERP maker",
    venueId: "hyperliquid",
    kind: "perp-mm",
    description:
      "Quote both sides of the BTC perp around a multi-venue fair-value. Capture spread + maker rebate, hedge inventory on Binance/Bybit if needed.",
    practicality: 4,
    defaults: { expectedEdgeBps: 7, side: "maker", spreadBps: 2.5, slippageBps: 0.5, latencyPenaltyBps: 1, adverseSelectionBps: 2.5, fillsPerDay: 600, fillRate: 0.4 },
  },
  {
    id: "hyperliquid-eth-perp-lead-lag",
    name: "Hyperliquid — ETH perp lead-lag",
    venueId: "hyperliquid",
    kind: "lead-lag",
    description:
      "Use Binance/Bybit ETH-USDT trades as a lead indicator; cross the spread on Hyperliquid when its book lags by > 1 tick.",
    practicality: 3,
    defaults: { expectedEdgeBps: 9, side: "taker", spreadBps: 3, slippageBps: 1, latencyPenaltyBps: 0.5, adverseSelectionBps: 2, fillsPerDay: 90, fillRate: 1 },
  },
  {
    id: "paradex-perp-pro-mm",
    name: "Paradex Pro — perp maker (0% maker)",
    venueId: "paradex",
    kind: "perp-mm",
    description:
      "Post-only quoting on Paradex Pro flow with 0% maker fees. Best when liquidity is shallow enough that adverse selection is manageable.",
    practicality: 3,
    defaults: { expectedEdgeBps: 6, side: "maker", spreadBps: 3, slippageBps: 0.5, latencyPenaltyBps: 1, adverseSelectionBps: 2.5, fillsPerDay: 250, fillRate: 0.35 },
  },
  {
    id: "polymarket-btc-binary-mm",
    name: "Polymarket — BTC binary maker (no taker fee)",
    venueId: "polymarket",
    kind: "binary-mm",
    description:
      "Quote both sides of BTC Up/Down binaries around your fair probability. Maker fee is 0 bps; earn the 20 bps rebate when matched against takers.",
    practicality: 4,
    defaults: { expectedEdgeBps: 35, side: "maker", spreadBps: 10, slippageBps: 4, latencyPenaltyBps: 5, adverseSelectionBps: 18, fillsPerDay: 80, fillRate: 0.3 },
  },
  {
    id: "polymarket-btc-news-taker",
    name: "Polymarket — BTC news taker (1% fee)",
    venueId: "polymarket",
    kind: "binary-news",
    description:
      "Cross the spread on a stale binary right after a macro / on-chain headline. Pays full 100 bps taker fee — only worth it on clear repricings.",
    practicality: 3,
    defaults: { expectedEdgeBps: 220, side: "taker", spreadBps: 30, slippageBps: 10, latencyPenaltyBps: 10, adverseSelectionBps: 25, fillsPerDay: 6, fillRate: 1 },
  },
];

export type RankRow = {
  strategy: HftStrategy;
  venue: Venue;
  result: EdgeResult;
};

export function rankStrategies(notionalUsd: number, edgeMultiplier = 1): RankRow[] {
  return HFT_STRATEGIES.map((s) => {
    const venue = venueById(s.venueId);
    if (!venue) throw new Error(`Unknown venue ${s.venueId}`);
    const result = computeEdge(venue, {
      notionalUsd,
      expectedEdgeBps: (s.defaults.expectedEdgeBps ?? 5) * edgeMultiplier,
      side: s.defaults.side ?? "maker",
      spreadBps: s.defaults.spreadBps,
      slippageBps: s.defaults.slippageBps,
      latencyPenaltyBps: s.defaults.latencyPenaltyBps,
      adverseSelectionBps: s.defaults.adverseSelectionBps,
      fillsPerDay: s.defaults.fillsPerDay,
      fillRate: s.defaults.fillRate,
    });
    return { strategy: s, venue, result };
  }).sort((a, b) => b.result.expectedDailyUsd - a.result.expectedDailyUsd);
}

export type PolyBtcRankRow = {
  id: string;
  name: string;
  horizon: string;
  thesis: string;
  result: PolyBtcResult;
};

/**
 * Score the catalog of Polymarket BTC Up/Down strategies at a given notional.
 * Each strategy carries its own realistic daily fill count; `fillsPerDayMultiplier`
 * scales that uniformly (1.0 = use strategy defaults, 2.0 = "I expect to fill twice as often").
 */
export function rankPolyBtcStrategies(notionalUsd: number, fillsPerDayMultiplier = 1): PolyBtcRankRow[] {
  return POLY_BTC_STRATEGIES.map((s) => ({
    id: s.id,
    name: s.name,
    horizon: s.horizon,
    thesis: s.thesis,
    result: evalPolyBtc({
      ...s.defaultInputs,
      notionalUsd,
      fillsPerDay: s.fillsPerDayDefault * fillsPerDayMultiplier,
    }),
  })).sort((a, b) => b.result.expectedDailyUsd - a.result.expectedDailyUsd);
}
