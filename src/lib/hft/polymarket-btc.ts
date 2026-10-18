// Polymarket "BTC Up/Down" binary strategy model.
//
// On Polymarket, a binary market for "BTC up by close" pays $1 on YES if BTC
// finishes higher (and $0 on NO), or vice-versa. Maker fees are 0%, taker fees
// are 1.00% on crypto markets, with a 20% maker rebate from taker volume.
//
// EV per filled YES contract bought at price p, when your model says the true
// probability of YES is q:
//
//   side = maker buys YES at p:
//     EV = q * (1 - p) - (1 - q) * p          // ignoring fees/rebates first
//        = q - p
//   Adjusted for maker rebate (paid as a fraction of taker fee that matched
//   you), and the loss from adverse selection (you only fill when the price
//   was moving away from your fair value):
//     EV_adj = (q - p) + rebate - adverseSelection
//
// We treat probabilities as 0..1, returns as USD per $1 of notional.

export type BinarySide = "yes" | "no";
export type OrderSide = "maker" | "taker";

export type PolyBtcInputs = {
  /** Your model's belief that YES resolves true. 0..1. */
  trueProb: number;
  /** The Polymarket YES price you'd transact at, 0..1. */
  marketYesPrice: number;
  /** Which side you buy. */
  side: BinarySide;
  /** Whether you cross the spread or post a maker quote. */
  order: OrderSide;
  /** Polymarket taker fee on crypto markets, basis points. Default 100 bps (1%). */
  takerFeeBps?: number;
  /** Maker rebate share — fraction of taker fee paid back to maker that filled them. */
  makerRebateShare?: number;
  /** Notional USD per fill. */
  notionalUsd: number;
  /** Fills per day. */
  fillsPerDay: number;
  /** Probability of fill on a posted maker order. */
  makerFillRate?: number;
  /** Average adverse-selection haircut to your model edge, bps. */
  adverseSelectionBps?: number;
};

export type PolyBtcResult = {
  edgeProb: number;
  edgeBps: number;
  feeBps: number;
  rebateBps: number;
  netEdgeBps: number;
  evPerFillUsd: number;
  effectiveFillsPerDay: number;
  expectedDailyUsd: number;
  expectedAnnualUsd: number;
  notes: string[];
};

const DEFAULTS = {
  takerFeeBps: 100,
  makerRebateShare: 0.2,
  makerFillRate: 0.35,
  adverseSelectionBps: 80,
};

export function evalPolyBtc(input: PolyBtcInputs): PolyBtcResult {
  const takerFeeBps = input.takerFeeBps ?? DEFAULTS.takerFeeBps;
  const makerRebateShare = input.makerRebateShare ?? DEFAULTS.makerRebateShare;
  const makerFillRate = input.makerFillRate ?? DEFAULTS.makerFillRate;
  const adverseSelectionBps = input.adverseSelectionBps ?? DEFAULTS.adverseSelectionBps;

  // Buying YES at p when true prob is q: edge = q - p (positive = YES underpriced).
  // Buying NO at p_no = 1 - p when you think true prob of YES is q: edge = (1 - q) - p_no = p - q.
  // The "edge" is symmetric — just flip if buying NO.
  const yesPrice = input.marketYesPrice;
  const noPrice = 1 - yesPrice;

  let edgeProb: number;
  let priceAtFill: number;
  if (input.side === "yes") {
    edgeProb = input.trueProb - yesPrice;
    priceAtFill = yesPrice;
  } else {
    edgeProb = (1 - input.trueProb) - noPrice;
    priceAtFill = noPrice;
  }

  // Convert edge to "per dollar of notional" bps. A contract costs `priceAtFill`
  // and pays at most $1, so the percentage edge on capital is edgeProb / priceAtFill.
  const edgeBps = priceAtFill > 0 ? (edgeProb / priceAtFill) * 1e4 : 0;

  const feeBps = input.order === "taker" ? takerFeeBps : 0;
  const rebateBps = input.order === "maker" ? makerRebateShare * takerFeeBps : 0;
  const adverseSel = input.order === "maker" ? adverseSelectionBps : adverseSelectionBps / 2;

  const netEdgeBps = edgeBps - feeBps + rebateBps - adverseSel;
  const evPerFillUsd = (netEdgeBps / 1e4) * input.notionalUsd;
  const effectiveFillsPerDay = input.order === "maker" ? input.fillsPerDay * makerFillRate : input.fillsPerDay;

  const notes: string[] = [];
  if (edgeProb <= 0) notes.push("Market price is at or above your fair value — no edge on this side.");
  if (input.order === "maker" && rebateBps - feeBps < 0) notes.push("Maker rebate < taker fee.");
  if (priceAtFill < 0.04 || priceAtFill > 0.96) notes.push("Extreme-tail price — fees can dwarf any micro-edge.");
  if (netEdgeBps <= 0) notes.push("Net edge negative after fees + adverse selection. Skip.");
  else notes.push("Net edge positive — clear to size at the configured notional.");

  return {
    edgeProb,
    edgeBps,
    feeBps,
    rebateBps,
    netEdgeBps,
    evPerFillUsd,
    effectiveFillsPerDay,
    expectedDailyUsd: evPerFillUsd * effectiveFillsPerDay,
    expectedAnnualUsd: evPerFillUsd * effectiveFillsPerDay * 365,
    notes,
  };
}

/** Catalog of the BTC Up/Down style strategies we benchmark in the UI. */
export type PolyBtcStrategy = {
  id: string;
  name: string;
  horizon: string;
  thesis: string;
  defaultInputs: Omit<PolyBtcInputs, "notionalUsd" | "fillsPerDay">;
  /** Realistic daily fill attempts for THIS strategy. Overrides any caller-supplied default. */
  fillsPerDayDefault: number;
};

export const POLY_BTC_STRATEGIES: PolyBtcStrategy[] = [
  {
    id: "btc-up-5m-maker-mean-revert",
    name: "BTC 5m Up — maker, mean-revert",
    horizon: "5 minutes",
    thesis:
      "Fade extreme intra-window 5m price swings: when implied probability of UP overshoots above the 5m realised-vol-implied prob, sell UP / buy DOWN as maker.",
    defaultInputs: {
      trueProb: 0.48,
      marketYesPrice: 0.55,
      side: "no",
      order: "maker",
      adverseSelectionBps: 60,
      makerFillRate: 0.45,
    },
    // 5m windows: ~288/day. Most days only ~80 windows show enough deviation to quote.
    fillsPerDayDefault: 80,
  },
  {
    id: "btc-up-15m-taker-momentum",
    name: "BTC 15m Up — taker, momentum",
    horizon: "15 minutes",
    thesis:
      "When a 15m up-trend is forming and implied probability still lags realised tape, cross the spread for the UP side.",
    defaultInputs: {
      trueProb: 0.62,
      marketYesPrice: 0.54,
      side: "yes",
      order: "taker",
      adverseSelectionBps: 50,
    },
    // 15m windows: ~96/day. Crossing the spread happens maybe ~12 times when the trend setup actually fires.
    fillsPerDayDefault: 12,
  },
  {
    id: "btc-up-eod-maker-fair-prob",
    name: "BTC EOD Up — maker, fair-prob",
    horizon: "End of day",
    thesis:
      "Quote both sides around your model's fair probability, lean inventory toward the cheaper side, requote on news.",
    defaultInputs: {
      trueProb: 0.52,
      marketYesPrice: 0.50,
      side: "yes",
      order: "maker",
      adverseSelectionBps: 90,
      makerFillRate: 0.3,
    },
    // EOD horizon - one market, ~40 requote opportunities through the day.
    fillsPerDayDefault: 40,
  },
  {
    id: "btc-up-news-taker-burst",
    name: "BTC Up — news-burst, taker",
    horizon: "Event-driven",
    thesis:
      "On a market-moving headline, cross the spread before the book has a chance to reprice the binary.",
    defaultInputs: {
      trueProb: 0.70,
      marketYesPrice: 0.55,
      side: "yes",
      order: "taker",
      adverseSelectionBps: 30,
    },
    // News bursts of this magnitude on BTC are rare — call it ~2/day on average.
    fillsPerDayDefault: 2,
  },
];
