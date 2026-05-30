/**
 * Arbitrage detection + sizing.
 *
 * Two surfaces:
 *  1. **Single-market arb** (`findSingleMarketArbs`) — YES/NO outcome tokens
 *     where `ask_yes + ask_no < $1 - fee_buffer`. Fully implemented; this is
 *     what 41% of conditions exhibited in the 2025 Probabilistic Forest paper.
 *
 *  2. **Combinatorial arb** (`findCombinatorialArbs`) — multi-market arbs
 *     where dependent conditions across markets produce a violation. The
 *     general case is intractable (#P-hard); we ship a brute-force fallback
 *     for n <= 12 outcomes + an interface where a Frank-Wolfe + IP solver
 *     drops in later.
 *
 *  3. **Position sizing** — `kellyFraction` (standard) and `cappedArbSize`
 *     (the article's "50% of orderbook depth" rule).
 *
 * Background references:
 *   arxiv:2508.03474 — Saguillo et al., empirical $40M extraction from Polymarket
 *   arxiv:1606.02825 — Kroer et al., Frank-Wolfe + IP for arbitrage-free CMM
 */

export type OrderBookSummary = {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size?: string;
  tick_size?: string;
};

export type MarketPair = {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
};

export type SingleMarketArb = {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  bestYesAsk: number;
  yesAskSize: number;
  bestNoAsk: number;
  noAskSize: number;
  sumOfAsks: number;
  rawEdgePerShare: number;          // $1 - (yes_ask + no_ask)  (gross)
  edgeAfterFeesPerShare: number;    // gross - fee buffer
  maxExecutableShares: number;      // min(yes ask size, no ask size, depth cap)
  expectedProfitUsd: number;        // edgeAfterFees * shares
  qualityScore: number;             // edge_bps × log10(shares) — for ranking
};

/** Top-of-book numbers extracted from an OrderBookSummary. */
function topAsk(book: OrderBookSummary): { price: number; size: number } | null {
  // Polymarket convention: asks[0] is best (lowest); see test-results.json for shape.
  const a = book.asks?.[0];
  if (!a) return null;
  const price = Number(a.price);
  const size = Number(a.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
  return { price, size };
}

/**
 * For each pair, compute the YES+NO ask-side arbitrage. Returns only
 * candidates with positive `edgeAfterFeesPerShare`.
 *
 * `feeBps` defaults to 50bps round-trip — covers standard taker fees on
 * non-15m-crypto markets. For the dynamic-fee crypto markets the caller
 * should pass the per-market actual.
 *
 * `depthCapFraction` defaults to 0.5 — matches the article's "50% of
 * orderbook depth" rule.
 */
export function findSingleMarketArbs(
  pairs: Array<{ pair: MarketPair; yesBook: OrderBookSummary | null; noBook: OrderBookSummary | null }>,
  opts: { feeBps?: number; depthCapFraction?: number; minProfitUsd?: number } = {},
): SingleMarketArb[] {
  const feeBps = opts.feeBps ?? 50;
  const depthCap = opts.depthCapFraction ?? 0.5;
  const minProfit = opts.minProfitUsd ?? 0.10;
  const out: SingleMarketArb[] = [];

  for (const row of pairs) {
    if (!row.yesBook || !row.noBook) continue;
    const yes = topAsk(row.yesBook);
    const no = topAsk(row.noBook);
    if (!yes || !no) continue;

    const sum = yes.price + no.price;
    const grossEdge = 1 - sum;
    const feeShare = (feeBps / 10_000) * 1; // applied to the $1 settled value
    const netEdge = grossEdge - feeShare;
    if (netEdge <= 0) continue;

    const executableShares = Math.floor(Math.min(yes.size, no.size) * depthCap);
    if (executableShares <= 0) continue;

    const profit = netEdge * executableShares;
    if (profit < minProfit) continue;

    out.push({
      conditionId: row.pair.conditionId,
      question: row.pair.question,
      yesTokenId: row.pair.yesTokenId,
      noTokenId: row.pair.noTokenId,
      bestYesAsk: yes.price,
      yesAskSize: yes.size,
      bestNoAsk: no.price,
      noAskSize: no.size,
      sumOfAsks: sum,
      rawEdgePerShare: grossEdge,
      edgeAfterFeesPerShare: netEdge,
      maxExecutableShares: executableShares,
      expectedProfitUsd: profit,
      qualityScore: (netEdge * 10_000) * Math.log10(Math.max(2, executableShares)),
    });
  }
  return out.sort((a, b) => b.qualityScore - a.qualityScore);
}

/**
 * Modified Kelly fraction for a binary outcome.
 *   f* = (b * p - q) / b      where b = odds-to-1, p = win prob, q = 1-p
 * `executionFailureRate` shrinks the Kelly to account for partial fills /
 * adverse selection — passes through as `f * (1 - executionFailureRate)`.
 */
export function kellyFraction(p: number, oddsToOne: number, executionFailureRate = 0.1): number {
  if (oddsToOne <= 0 || p <= 0 || p >= 1) return 0;
  const q = 1 - p;
  const f = (oddsToOne * p - q) / oddsToOne;
  if (f <= 0) return 0;
  return Math.max(0, Math.min(1, f * (1 - executionFailureRate)));
}

/**
 * Combinatorial arb scaffolding. Real production deployments solve the
 * Bregman projection via Frank-Wolfe + Gurobi IP (see arxiv:1606.02825).
 * This stub returns:
 *   - exact result via brute force when n <= 12,
 *   - `null` + a `requiresSolver: true` flag when n > 12 (caller should
 *     dispatch to an external solver process).
 *
 * The shape is fixed so the caller's plumbing stays stable regardless of which
 * solver implementation is wired in below.
 */
export type CombinatorialMarket = {
  conditionId: string;
  question: string;
  // Vector of (token_id, ask_price, ask_size) — one entry per outcome.
  outcomes: Array<{ tokenId: string; askPrice: number; askSize: number; label: string }>;
};

export type CombinatorialArb = {
  basket: Array<{ conditionId: string; tokenId: string; price: number; sharesToBuy: number; label: string }>;
  totalCostUsd: number;
  guaranteedPayoutUsd: number;
  edgeUsd: number;
  notes: string;
};

export type CombinatorialResult =
  | { kind: "found"; arbs: CombinatorialArb[] }
  | { kind: "no-arb" }
  | { kind: "requires-solver"; conditionCount: number; reason: string };

export type DependencyConstraint = {
  /** "if all `ifTrue` outcomes hold in the world state, then at least one `thenTrue` outcome must too" */
  ifTrue: string[]; // token ids
  thenTrue: string[];
};

export async function findCombinatorialArbs(
  markets: CombinatorialMarket[],
  dependencyConstraints: DependencyConstraint[] = [],
  opts: { depthCapFraction?: number } = {},
): Promise<CombinatorialResult> {
  const depthCap = opts.depthCapFraction ?? 0.5;
  const totalOutcomes = markets.reduce((acc, m) => acc + m.outcomes.length, 0);
  if (totalOutcomes === 0) return { kind: "no-arb" };

  // Build LP outcome list with capped depth (the article's 50%-of-book rule).
  const { solveArbLp, solveColumnGen } = await import("./lp");
  const lpOutcomes = markets.flatMap((m) => m.outcomes.map((o) => ({
    id: o.tokenId,
    price: o.askPrice,
    depth: Math.floor(o.askSize * depthCap),
    label: o.label,
    marketId: m.conditionId,
  })));

  const solution = totalOutcomes <= 14
    ? await solveArbLp(lpOutcomes, dependencyConstraints)
    : await solveColumnGen(lpOutcomes, dependencyConstraints);

  if (!solution) return { kind: "no-arb" };

  const basket: CombinatorialArb["basket"] = [];
  for (const m of markets) {
    for (const o of m.outcomes) {
      const shares = solution.shares[o.tokenId] ?? 0;
      if (shares > 0) {
        basket.push({ conditionId: m.conditionId, tokenId: o.tokenId, price: o.askPrice, sharesToBuy: shares, label: o.label });
      }
    }
  }
  return {
    kind: "found",
    arbs: [{
      basket,
      totalCostUsd: solution.costUsd,
      guaranteedPayoutUsd: solution.guaranteedPayoutUsd,
      edgeUsd: solution.edgeUsd,
      notes: `LP solver (${totalOutcomes <= 14 ? "direct" : "column-gen"}); basket=${solution.basketShares} shares`,
    }],
  };
}
