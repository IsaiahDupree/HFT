/**
 * binary-maker — turn an INDEPENDENT fair value (from binary-fair-value, priced
 * off the CEX feed) into two-sided Polymarket quotes, with inventory skew, a
 * fee-aware min-edge gate, and complement-merge awareness.
 *
 * This is the quote-construction half of the coinman2-style maker. It does NOT
 * touch the network — `planQuotes` is pure: (fair value, inventory, fees, book) →
 * { bidPx, askPx, bidSz, askSz, post? }. The paper/live loop calls it each tick.
 *
 * Design:
 *   - Center quotes on pFair (NOT the market mid — the mid is the stale thing we
 *     profit from). Half-spread = max(baseHalfSpread, fee-driven floor).
 *   - Inventory skew (logit-space Avellaneda-Stoikov reservation shift): long
 *     inventory pushes both quotes down so we sell more readily; short pushes up.
 *   - Min-edge gate: only post a side if its expected per-share edge over fair,
 *     net of the rebate-adjusted spread, clears `minEdge`. Otherwise that side is
 *     withdrawn (size 0) — never quote a side with no edge.
 *   - Complement guard: our Yes-bid and (1 − No-bid) must not cross in a way that
 *     would let someone arb US; clamp so yesAsk + noAsk ≥ 1 (we never sell the
 *     pair for < $1) and yesBid + noBid ≤ 1 (we never buy the pair for > $1).
 *   - Boundary cap from the AS lib withdraws quoting when inventory exceeds
 *     M·√(p(1−p)) — quotes get unstable near 0/1.
 *
 * All sizes are in SHARES (Polymarket contracts pay $1). Prices are probabilities
 * in (0,1).
 */
import { logitSpaceQuotes, makerRebate, type FeeCategory, type ASParams } from "./as-market-maker.js";

export type BinaryMakerParams = {
  /** Base half-spread in probability units (e.g. 0.01 = 1¢). The fee floor may widen it. */
  baseHalfSpread: number;
  /** Minimum per-share edge (prob units) required to post a side, AFTER rebate credit. */
  minEdge: number;
  /** Target shares per side when a side is active. */
  quoteSizeShares: number;
  /** Hard inventory cap in shares; beyond this the long/short side is withdrawn. */
  maxInventoryShares: number;
  /** Polymarket V2 fee category (crypto = [1.8% peak taker, 20% rebate]). */
  feeCategory: FeeCategory;
  /** AS params for the logit-space inventory skew. T/t share the τ clock (hours, say). */
  as: ASParams;
  /** AS boundary exposure multiplier M (withdraw when |inv| > M·√(p(1−p))). Default 200. */
  boundaryM?: number;
};

export type QuoteSide = {
  /** Price to post at (probability). */
  px: number;
  /** Size in shares (0 ⇒ withdraw this side). */
  sz: number;
  /** Per-share edge vs fair, net of rebate-adjusted half-spread. */
  edge: number;
  /** Why this size (for logs/audit). */
  reason: string;
};

export type QuotePlan = {
  pFair: number;
  reservationP: number;
  /** Our BID on YES (we buy Yes here). */
  yesBid: QuoteSide;
  /** Our ASK on YES (we sell Yes here). */
  yesAsk: QuoteSide;
  /** True if at least one side is active. */
  active: boolean;
  note: string;
};

export type PlanInputs = {
  /** Independent fair probability of YES, from binary-fair-value. */
  pFair: number;
  /** Current signed inventory in YES shares (long +, short −). */
  inventoryShares: number;
  /** Clock value t for AS (same unit/clock as params.as.T). */
  t: number;
  /** Optional current best book to avoid posting through the touch (improves, never crosses). */
  book?: { bestBid?: number; bestAsk?: number };
  params: BinaryMakerParams;
};

/** Rebate credit per share at a given price → effectively tightens the half-spread we need. */
function rebatePerShare(price: number, sizeShares: number, cat: FeeCategory): number {
  if (sizeShares <= 0) return 0;
  return makerRebate(price, sizeShares, cat) / sizeShares;
}

/**
 * Plan two-sided YES quotes. Pure. Returns withdrawn sides (sz 0) rather than
 * throwing when an edge/inventory/boundary gate fails.
 */
export function planQuotes(inp: PlanInputs): QuotePlan {
  const p = inp.params;
  const pFair = inp.pFair;

  // Unusable fair value → quote nothing.
  if (!(pFair > 0 && pFair < 1)) {
    const dead: QuoteSide = { px: NaN, sz: 0, edge: 0, reason: "no fair value" };
    return { pFair, reservationP: pFair, yesBid: dead, yesAsk: dead, active: false, note: "pFair out of (0,1)" };
  }

  // Logit-space AS reservation gives the inventory-skewed center + boundary cap.
  const as = logitSpaceQuotes(pFair, inp.inventoryShares, inp.t, p.as, p.boundaryM ?? 200);
  if (!as) {
    const dead: QuoteSide = { px: NaN, sz: 0, edge: 0, reason: "over AS boundary inventory cap" };
    return { pFair, reservationP: pFair, yesBid: dead, yesAsk: dead, active: false, note: "withdrawn: boundary cap" };
  }
  const reservationP = as.reservationP;

  // The half-spread we WANT to quote. We do NOT floor it to minEdge — that would
  // make every posted side trivially clear the edge gate. Instead minEdge is a
  // genuine gate that fires when book-improvement or inventory skew compresses a
  // side's edge below it (or when an operator sets baseHalfSpread too thin).
  const half = p.baseHalfSpread;

  // Raw two-sided quotes around the inventory-skewed reservation.
  let bidPx = reservationP - half;
  let askPx = reservationP + half;

  // Stay strictly inside (0,1). If a book is provided, a maker may post INSIDE
  // the spread (improving the touch) but must never cross it into a marketable
  // order: our bid must stay strictly below bestAsk, our ask strictly above
  // bestBid. (Pinning the ask to bestAsk — the old behavior — pushed it out of
  // the spread so it could only fill on a book cross, i.e. never.)
  const TICK = 0.001;
  bidPx = Math.max(0.001, Math.min(0.999, bidPx));
  askPx = Math.max(0.001, Math.min(0.999, askPx));
  if (inp.book?.bestAsk !== undefined && bidPx >= inp.book.bestAsk) bidPx = inp.book.bestAsk - TICK; // bid below the ask
  if (inp.book?.bestBid !== undefined && askPx <= inp.book.bestBid) askPx = inp.book.bestBid + TICK; // ask above the bid

  // Edge per side vs fair, crediting the maker rebate (rebate effectively lets us
  // quote tighter). BID edge = how far below fair we're buying; ASK edge = how far
  // above fair we're selling. Net of the rebate-as-spread-credit.
  const bidRebate = rebatePerShare(bidPx, p.quoteSizeShares, p.feeCategory);
  const askRebate = rebatePerShare(askPx, p.quoteSizeShares, p.feeCategory);
  const bidEdge = pFair - bidPx + bidRebate; // buy below fair → positive edge
  const askEdge = askPx - pFair + askRebate; // sell above fair → positive edge

  // Inventory gates: never add to a side that would breach the hard cap.
  const inv = inp.inventoryShares;
  const canBuy = inv + p.quoteSizeShares <= p.maxInventoryShares; // buying adds + inventory
  const canSell = inv - p.quoteSizeShares >= -p.maxInventoryShares; // selling adds − inventory

  // The inventory-REDUCING side is the system's only exhaust valve — it must
  // NEVER be withdrawn by the minEdge gate (RAILS-REVIEW finding 1: at high
  // inventory the A-S skew compresses the reducing side's edge below minEdge,
  // killing the one quote that sheds risk → cap-and-ride into resolution).
  // It still respects the no-cross clamp and the opposite hard cap.
  const bidReduces = inv < 0; // buying back reduces a short
  const askReduces = inv > 0; // selling down reduces a long

  const yesBid: QuoteSide =
    (bidEdge >= p.minEdge || bidReduces) && canBuy
      ? { px: round4(bidPx), sz: p.quoteSizeShares, edge: bidEdge,
          reason: bidEdge >= p.minEdge
            ? `buy ${(bidEdge * 100).toFixed(2)}¢ under fair (rebate ${(bidRebate * 100).toFixed(3)}¢)`
            : `reduce-only exhaust (edge ${(bidEdge * 100).toFixed(2)}¢ < min, inv ${inv})` }
      : { px: round4(bidPx), sz: 0, edge: bidEdge, reason: !canBuy ? "inv cap (long)" : `edge ${(bidEdge * 100).toFixed(2)}¢ < min` };

  const yesAsk: QuoteSide =
    (askEdge >= p.minEdge || askReduces) && canSell
      ? { px: round4(askPx), sz: p.quoteSizeShares, edge: askEdge,
          reason: askEdge >= p.minEdge
            ? `sell ${(askEdge * 100).toFixed(2)}¢ over fair (rebate ${(askRebate * 100).toFixed(3)}¢)`
            : `reduce-only exhaust (edge ${(askEdge * 100).toFixed(2)}¢ < min, inv ${inv})` }
      : { px: round4(askPx), sz: 0, edge: askEdge, reason: !canSell ? "inv cap (short)" : `edge ${(askEdge * 100).toFixed(2)}¢ < min` };

  const active = yesBid.sz > 0 || yesAsk.sz > 0;
  return {
    pFair,
    reservationP,
    yesBid,
    yesAsk,
    active,
    note: active
      ? `fair ${(pFair * 100).toFixed(1)}¢ res ${(reservationP * 100).toFixed(1)}¢ inv ${inv} → bid ${(yesBid.px * 100).toFixed(1)}¢×${yesBid.sz} ask ${(yesAsk.px * 100).toFixed(1)}¢×${yesAsk.sz}`
      : `both sides withdrawn (${yesBid.reason} / ${yesAsk.reason})`,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Complement-merge accounting: given a Yes position and a No position both held,
 * how many complete $1 sets can be merged, and the realized profit from doing so.
 * (Buying Yes@a + No@b for a+b<1, then merging the matched shares → $1 each.)
 */
export function mergeableSets(
  yesShares: number,
  noShares: number,
  yesAvgCost: number,
  noAvgCost: number,
): { sets: number; profitUsd: number } {
  const sets = Math.floor(Math.min(Math.max(0, yesShares), Math.max(0, noShares)));
  if (sets <= 0) return { sets: 0, profitUsd: 0 };
  // Each merged set redeems for $1, cost was yesAvgCost + noAvgCost.
  const profitUsd = sets * (1 - (yesAvgCost + noAvgCost));
  return { sets, profitUsd };
}
