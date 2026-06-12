/**
 * queue-fill — honest queue-position maker-fill estimation.
 *
 * The paper-track fill model fills a freshly-repriced quote against old prints
 * with assumed front-of-queue priority and infinite print size (see
 * docs/research/RAILS-REVIEW-2026-06-11.md finding 4 — net-optimistic where it
 * hurts). This module replaces that optimism with price-time-priority queue
 * accounting, the same idea as the evan-kolberg execution model
 * (docs/research/EVAN-KOLBERG-BACKTESTER-ASSESS.md "Execution realism"):
 *
 *   - We join the BACK of the queue: queue ahead = visible resting size at our
 *     price level at the moment we post. (The L2 feed shows other participants
 *     only — our paper order is not in the real book.)
 *   - Later size increases at our level arrive BEHIND us (price-time priority).
 *   - Size decreases without a trade are cancellations, attributed pro-rata
 *     across ahead/behind by default ("prorata"); "behind" (cancels never help
 *     us — pessimistic bound) and "ahead" (optimistic bound) are available to
 *     bracket the estimate.
 *   - A trade AT our price on our side consumes the queue ahead first; only the
 *     excess fills us; any further excess consumes the queue behind.
 *   - A trade THROUGH our price (strictly better for the aggressor) means the
 *     whole level was swept — we fill in full at OUR price.
 *
 * Known honesty boundaries (documented, not hidden):
 *   - If the feed delivers the post-trade book update BEFORE the trade print,
 *     the size drop is first counted as a cancellation and then the trade also
 *     consumes queue — optimistic double count. PMXT raw carries books only;
 *     keep trades from a separate source ordered after the book state they hit.
 *   - L2 is market-by-price, not market-by-order: true queue position is
 *     unknowable from MBP; pro-rata cancellation is the standard neutral
 *     assumption, hence the bracketing modes.
 *
 * Pure functions, no I/O, deterministic.
 */

export type Side = "bid" | "ask";

export type RestingQuote = {
  side: Side;
  price: number;
  size: number;
  /** When the order was acknowledged at the venue (same clock as the events). */
  postedTs: number;
};

/** Visible resting size (other participants) at the quote's price level. */
export type LevelEvent = { ts: number; kind: "level"; size: number };
/** A print from the trade tape. `aggressor` is the taker side. */
export type TradeEvent = { ts: number; kind: "trade"; price: number; size: number; aggressor: "BUY" | "SELL" };
export type QueueEvent = LevelEvent | TradeEvent;

export type QueueFill = { ts: number; price: number; qty: number };

export type CancelMode = "prorata" | "behind" | "ahead";

export type QueueState = {
  /** Visible size still ahead of us at our price. We fill only after this is consumed. */
  queueAhead: number;
  /** Size that arrived at our level after we posted (behind us). */
  queueBehind: number;
  /** Our unfilled remainder. */
  remaining: number;
  fills: QueueFill[];
};

export type QueueFillResult = {
  fills: QueueFill[];
  filledQty: number;
  remaining: number;
  /** ts of the first/last partial fill, or undefined if never touched. */
  firstFillTs?: number;
  lastFillTs?: number;
  fullyFilled: boolean;
  endState: QueueState;
};

const EPS = 1e-9;

/** Visible size at `price` in a top-N ladder of [price, size] rows (0 if absent). */
export function levelSizeAt(levels: ReadonlyArray<readonly [number, number]>, price: number, eps: number = 1e-6): number {
  for (const [px, sz] of levels) if (Math.abs(px - price) <= eps) return sz;
  return 0;
}

/** Join the back of the queue: everything visible at post time is ahead of us. */
export function initQueueState(quote: RestingQuote, visibleAtPost: number): QueueState {
  return {
    queueAhead: Math.max(0, visibleAtPost),
    queueBehind: 0,
    remaining: Math.max(0, quote.size),
    fills: [],
  };
}

/**
 * New visible size at our level (excluding us). Growth joins behind us;
 * shrinkage (with no trade between observations) is cancellation, attributed
 * per `mode`. Returns a new state — input is not mutated.
 */
export function applyLevelUpdate(state: QueueState, newVisible: number, mode: CancelMode = "prorata"): QueueState {
  const oldTotal = state.queueAhead + state.queueBehind;
  const visible = Math.max(0, newVisible);
  const delta = visible - oldTotal;
  if (Math.abs(delta) <= EPS) return state;
  if (delta > 0) return { ...state, queueBehind: state.queueBehind + delta };
  const cancelled = -delta;
  let ahead = state.queueAhead;
  let behind = state.queueBehind;
  if (mode === "prorata") {
    if (oldTotal > EPS) {
      ahead -= (cancelled * state.queueAhead) / oldTotal;
      behind -= (cancelled * state.queueBehind) / oldTotal;
    }
  } else if (mode === "behind") {
    // Pessimistic: cancels come from behind us first; queue ahead shrinks last.
    const fromBehind = Math.min(behind, cancelled);
    behind -= fromBehind;
    ahead -= cancelled - fromBehind;
  } else {
    // Optimistic: cancels come from ahead of us first.
    const fromAhead = Math.min(ahead, cancelled);
    ahead -= fromAhead;
    behind -= cancelled - fromAhead;
  }
  return { ...state, queueAhead: Math.max(0, ahead), queueBehind: Math.max(0, behind) };
}

/** Is this print capable of filling our resting quote at all? */
export function tradeHitsQuote(quote: RestingQuote, trade: TradeEvent): boolean {
  if (quote.side === "bid") return trade.aggressor === "SELL" && trade.price <= quote.price + EPS;
  return trade.aggressor === "BUY" && trade.price >= quote.price - EPS;
}

/** Did the print trade THROUGH our price (strictly better for the aggressor)? */
function tradesThrough(quote: RestingQuote, trade: TradeEvent): boolean {
  return quote.side === "bid" ? trade.price < quote.price - EPS : trade.price > quote.price + EPS;
}

/**
 * Apply one print. Price-time priority at our level: queue ahead is consumed
 * first, then us, then the queue behind. A print through our price sweeps the
 * level — full fill of our remainder at OUR price. Returns a new state.
 */
export function applyTrade(state: QueueState, quote: RestingQuote, trade: TradeEvent): QueueState {
  if (state.remaining <= EPS || trade.size <= EPS || !tradeHitsQuote(quote, trade)) return state;
  if (tradesThrough(quote, trade)) {
    const fill: QueueFill = { ts: trade.ts, price: quote.price, qty: state.remaining };
    return { queueAhead: 0, queueBehind: state.queueBehind, remaining: 0, fills: [...state.fills, fill] };
  }
  // Print exactly at our level.
  const consumedAhead = Math.min(state.queueAhead, trade.size);
  let leftover = trade.size - consumedAhead;
  const qty = Math.min(state.remaining, leftover);
  leftover -= qty;
  const consumedBehind = Math.min(state.queueBehind, leftover);
  const fills = qty > EPS ? [...state.fills, { ts: trade.ts, price: quote.price, qty }] : state.fills;
  return {
    queueAhead: state.queueAhead - consumedAhead,
    queueBehind: state.queueBehind - consumedBehind,
    remaining: state.remaining - qty,
    fills,
  };
}

/**
 * Driver: simulate our resting quote against a chronological event stream.
 *
 * `events` must be time-sorted and contain `level` events carrying the visible
 * size at OUR price on OUR side (use `levelSizeAt` on each book update) plus
 * the trade tape. Events before `quote.postedTs` are ignored except that the
 * LAST level observation at-or-before post time seeds the initial queue ahead
 * (that is the book we joined behind). If no level event precedes the post,
 * `fallbackVisibleAtPost` seeds it (default 0 — front of an empty level).
 */
export function simulateQueueFills(
  quote: RestingQuote,
  events: readonly QueueEvent[],
  opts: { cancelMode?: CancelMode; fallbackVisibleAtPost?: number } = {},
): QueueFillResult {
  const mode = opts.cancelMode ?? "prorata";
  let visibleAtPost = opts.fallbackVisibleAtPost ?? 0;
  for (const e of events) {
    if (e.ts > quote.postedTs) break;
    if (e.kind === "level") visibleAtPost = e.size;
  }
  let state = initQueueState(quote, visibleAtPost);
  for (const e of events) {
    if (e.ts <= quote.postedTs) continue; // no lookahead: nothing before our ack can fill us
    if (state.remaining <= EPS) break;
    state = e.kind === "level" ? applyLevelUpdate(state, e.size, mode) : applyTrade(state, quote, e);
  }
  const filledQty = quote.size - state.remaining;
  return {
    fills: state.fills,
    filledQty,
    remaining: state.remaining,
    firstFillTs: state.fills[0]?.ts,
    lastFillTs: state.fills.length ? state.fills[state.fills.length - 1].ts : undefined,
    fullyFilled: state.remaining <= EPS,
    endState: state,
  };
}
