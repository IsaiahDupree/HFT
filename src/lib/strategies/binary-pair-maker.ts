/**
 * binary-pair-maker — the MERGE-MAKER quote planner: the strategy the verified
 * winners actually run (coinman2 / Bonereaper / 0x6db568e6 — see
 * docs/wallets/SWEEP-2026-06-11-ROUND2.md and EDGES.md "Polymarket program").
 *
 * Structure: post maker BUY bids on BOTH tokens of a binary (YES and NO) such
 * that the paired cost is locked below $1:
 *
 *     bidYES + bidNO ≤ 1 − mergeMargin − feeBuffer
 *
 * When both bids fill, the matched shares form a complete set redeemable for
 * exactly $1 (merge) — income = 1 − (fillYES + fillNO) + rebates, RISKLESS at
 * the pair level. Directional risk only lives in the UNPAIRED remainder, which
 * is capped structurally (maxUnpairedShares) and bled off by quoting only the
 * pairing side once the cap is hit. This replaces the naked maker's adverse-
 * selection exposure with an inventory≈0 loop (RAILS-REVIEW finding 9c;
 * naked-FV quoting was formally demoted 2026-06-11 — the market mid out-
 * forecasts our fair value, so profit must come from STRUCTURE, not forecast).
 *
 * The fair value still matters, but only for SAFETY, not edge: each side's bid
 * is capped at (its fair − safetyEdge) so we never overpay for a leg the CEX
 * feed says is rich. The budget constraint is what makes the money.
 *
 * Pure: (fair, books, inventory, τ) → bids. No network. Venue tick = $0.01.
 */

export type PairMakerParams = {
  /** Shares per bid per side. Calibration: profitable updown makers run $1–14 median fills. */
  quoteSizeShares: number;
  /** Locked margin per merged set, e.g. 0.02 ⇒ pay ≤ $0.98 for the pair. */
  mergeMargin: number;
  /** Safety buffer for fees/adverse ticks inside the pair budget, e.g. 0.005. */
  feeBuffer: number;
  /** Cap on |yesShares − noShares| (the directional remainder). The exhaust. */
  maxUnpairedShares: number;
  /** Below this τ (seconds) quote ONLY the side that pairs up existing inventory. */
  tauFloorSec: number;
  /** Each bid must also sit at least this far under its own fair value, e.g. 0.01. */
  safetyEdge: number;
};

export type SideBook = { bestBid: number; bestAsk: number };

export type PairPlanInputs = {
  /** Independent fair P(YES) from binary-fair-value. */
  pFair: number;
  /** Top of book for each token. */
  yesBook: SideBook;
  noBook: SideBook;
  /** Current long share inventories (pair maker only ever BUYS). */
  yesShares: number;
  noShares: number;
  /** Seconds to expiry. */
  tauSec: number;
  params: PairMakerParams;
};

export type PairBid = { px: number; sz: number; reason: string } | null;

export type PairPlan = {
  yesBid: PairBid;
  noBid: PairBid;
  /** Shares currently mergeable (min of the two inventories). */
  mergeable: number;
  /** Signed unpaired exposure: +ve = excess YES. */
  unpaired: number;
  note: string;
};

const TICK = 0.01; // Polymarket venue tick — sub-cent quotes are not real

/** Round DOWN to the venue tick and clamp to a postable range. */
export function toTick(px: number): number {
  const t = Math.floor(px / TICK + 1e-9) * TICK;
  return Math.min(0.99, Math.max(0.01, Math.round(t * 100) / 100));
}

/**
 * Plan the two maker bids. Returns null sides rather than throwing; every
 * withdrawal carries a reason so the paper loop can attribute behavior.
 */
export function planPairQuotes(inp: PairPlanInputs): PairPlan {
  const p = inp.params;
  const unpaired = inp.yesShares - inp.noShares;
  const mergeable = Math.floor(Math.min(inp.yesShares, inp.noShares));
  const base = { mergeable, unpaired };

  if (!(inp.pFair > 0 && inp.pFair < 1)) {
    return { ...base, yesBid: null, noBid: null, note: "no fair value" };
  }

  // ── raw per-side bids: improve the touch but never cross, never above fair − safetyEdge ──
  const rawSide = (fair: number, book: SideBook): number | null => {
    if (!(book.bestAsk > 0) || !(book.bestAsk <= 1)) return null;
    // join/improve the touch: one tick over the current best bid when possible
    const join = Number.isFinite(book.bestBid) && book.bestBid > 0 ? book.bestBid + TICK : fair - p.safetyEdge;
    const px = toTick(Math.min(join, fair - p.safetyEdge, book.bestAsk - TICK));
    return px >= 0.01 ? px : null;
  };

  let yesPx = rawSide(inp.pFair, inp.yesBook);
  let noPx = rawSide(1 - inp.pFair, inp.noBook);

  // ── the pair budget: bidYES + bidNO ≤ 1 − margin − fees (the actual edge) ──
  const budget = 1 - p.mergeMargin - p.feeBuffer;
  if (yesPx !== null && noPx !== null && yesPx + noPx > budget) {
    // Shave the side that is RICH vs its own fair first (overpaying leg), then
    // split any remainder evenly. Re-tick after shaving.
    let excess = yesPx + noPx - budget;
    const yesRich = yesPx - (inp.pFair - p.safetyEdge); // how far above its cap it sits (≤0 normally)
    const noRich = noPx - (1 - inp.pFair - p.safetyEdge);
    // shave richer side by up to its richness
    if (yesRich > noRich && yesRich > 0) {
      const cut = Math.min(excess, yesRich);
      yesPx -= cut; excess -= cut;
    } else if (noRich > 0) {
      const cut = Math.min(excess, noRich);
      noPx -= cut; excess -= cut;
    }
    yesPx -= excess / 2;
    noPx -= excess / 2;
    yesPx = toTick(yesPx);
    noPx = toTick(noPx);
    // ticking can re-violate by < 1 tick — take it off one side deterministically
    if (yesPx + noPx > budget + 1e-9) yesPx = toTick(yesPx - TICK);
    if (yesPx < 0.01) yesPx = null as any;
    if (noPx !== null && noPx < 0.01) noPx = null as any;
  }

  // ── structural exhaust: unpaired cap — only quote the side that PAIRS ──
  let yesBid: PairBid = yesPx !== null ? { px: yesPx, sz: p.quoteSizeShares, reason: "pair bid" } : null;
  let noBid: PairBid = noPx !== null ? { px: noPx, sz: p.quoteSizeShares, reason: "pair bid" } : null;

  if (unpaired >= p.maxUnpairedShares && yesBid) {
    yesBid = null; // too much excess YES — stop adding; NO bid pairs it down
    if (noBid) noBid.reason = `pairing down excess YES (unpaired ${unpaired})`;
  } else if (-unpaired >= p.maxUnpairedShares && noBid) {
    noBid = null;
    if (yesBid) yesBid.reason = `pairing down excess NO (unpaired ${unpaired})`;
  }

  // ── τ floor: near expiry, never OPEN exposure — only pair down what exists ──
  if (inp.tauSec < p.tauFloorSec) {
    if (unpaired > 0) {
      yesBid = null;
      if (noBid) noBid.reason = `tau-floor reduce-only (unpaired ${unpaired})`;
    } else if (unpaired < 0) {
      noBid = null;
      if (yesBid) yesBid.reason = `tau-floor reduce-only (unpaired ${unpaired})`;
    } else {
      yesBid = null;
      noBid = null;
    }
  }

  const note =
    yesBid || noBid
      ? `fair ${(inp.pFair * 100).toFixed(1)}¢ → yes ${yesBid ? (yesBid.px * 100).toFixed(0) + "¢×" + yesBid.sz : "—"} no ${noBid ? (noBid.px * 100).toFixed(0) + "¢×" + noBid.sz : "—"} (pair ≤ ${(budget * 100).toFixed(0)}¢, unpaired ${unpaired})`
      : `withdrawn (unpaired ${unpaired}, τ ${inp.tauSec.toFixed(0)}s)`;

  return { ...base, yesBid, noBid, note };
}

/**
 * Merge bookkeeping for the paper loop: given current inventories and total
 * costs, merge every complete set at $1. Returns the new state + cash credit.
 */
export function settleMerge(state: {
  yesShares: number; noShares: number;
  /** Total dollars spent on each leg's CURRENT inventory (avg-cost basis). */
  yesCost: number; noCost: number;
}): { merged: number; cashIn: number; lockedMargin: number; next: typeof state } {
  const merged = Math.floor(Math.min(state.yesShares, state.noShares));
  if (merged <= 0) return { merged: 0, cashIn: 0, lockedMargin: 0, next: state };
  const yesAvg = state.yesShares > 0 ? state.yesCost / state.yesShares : 0;
  const noAvg = state.noShares > 0 ? state.noCost / state.noShares : 0;
  const cashIn = merged * 1.0;
  const lockedMargin = merged * (1 - (yesAvg + noAvg));
  const next = {
    yesShares: state.yesShares - merged,
    noShares: state.noShares - merged,
    yesCost: state.yesCost - merged * yesAvg,
    noCost: state.noCost - merged * noAvg,
  };
  return { merged, cashIn, lockedMargin, next };
}
