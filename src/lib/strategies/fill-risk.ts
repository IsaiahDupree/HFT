/**
 * fill-risk — microstructure fill-risk model for the merge-maker's resting bids.
 *
 * Direct TypeScript port of TradingBot2 research/lastminute/rails/fill_risk.py
 * (itself ported from polymarket_lp_tool/passive_liquidity/fill_risk.py,
 * reviewed-benign 2026-06-11). DEFAULT PARAMETERS ARE COPIED VERBATIM and must
 * NOT be tuned on any single backtest window — the whole point of the G3-V3 test
 * is to measure fill_risk's effect with its shipped thresholds, not to overfit
 * them to 7 hours of data.
 *
 * The problem (confirmed on G3-V2): with the cost-guard, locked margin is fixed
 * and the paired(≤10) bucket is profitable; 100% of the remaining loss is
 * directional residual from unpaired inventory that forms when the tape runs one
 * way and keeps hitting our resting BUY on that side. The static unpaired cap
 * catches the *count*; fill_risk catches the *moment* — directional tape
 * pressure against our resting side in real time — so the maker widens/pulls
 * BEFORE accumulating the inventory that bleeds.
 *
 * Score in [0,1] → level LOW/MODERATE/ELEVATED/HIGH → widen the at-risk side by
 * N ticks (or pull it on HIGH). Pure; caller feeds recent trades + book touch.
 */

export const LOW = "LOW";
export const MODERATE = "MODERATE";
export const ELEVATED = "ELEVATED";
export const HIGH = "HIGH";
export type FillRiskLevel = "LOW" | "MODERATE" | "ELEVATED" | "HIGH";

export type FrTrade = { ts: number; side: string; size: number };

/** A trade that HITS our resting side is the adverse signal; same-side adds barely matter. */
export function directionalWeight(orderSide: string, tradeSide: string): number {
  const o = (orderSide || "").toUpperCase();
  const t = (tradeSide || "").toUpperCase();
  if ((o === "BUY" && t === "SELL") || (o === "SELL" && t === "BUY")) return 1.0;
  if (o === t && (o === "BUY" || o === "SELL")) return 0.3;
  return 0.5;
}

/**
 * Blended [0,1] activity over the last windowS seconds: directionally-weighted
 * trade COUNT and SIZE, each squashed by its denom. Higher = more pressure
 * against orderSide. `now` and trade ts share the same clock/unit (seconds).
 */
export function windowActivity(
  trades: ReadonlyArray<FrTrade>, now: number, windowS: number, orderSide: string,
  countDenom = 2.0, sizeDenom = 1000.0,
): number {
  let c = 0, s = 0;
  for (const tr of trades) {
    const ts = tr.ts;
    if (ts === undefined || ts === null || now - ts > windowS) continue;
    const w = directionalWeight(orderSide, tr.side ?? "");
    c += w;
    s += w * (Number(tr.size) || 0);
  }
  const countTerm = countDenom ? Math.min(1.0, c / countDenom) : 0.0;
  const sizeTerm = sizeDenom ? Math.min(1.0, s / sizeDenom) : 0.0;
  return Math.max(countTerm, sizeTerm);
}

/** [0,1] — how exposed our resting price is to being hit. At/inside the touch ≈1; far behind ≈0. */
export function bookProximityRisk(
  orderSide: string, price: number, bestBid: number, bestAsk: number, tick: number, ticksScale = 3.0,
): number {
  const t = Math.max(tick, 1e-9);
  let behind = (orderSide || "").toUpperCase() === "BUY" ? (bestBid - price) / t : (price - bestAsk) / t;
  behind = Math.max(0.0, behind);
  return 1.0 / (1.0 + behind / ticksScale);
}

/**
 * Combined fill-risk [0,1] = activity * (floor + proxMult * book_proximity).
 * Activity blends a 30 s spike with a 3600 s trend (spike-boosted). All denoms
 * and weights are the reference defaults.
 */
export function fillRiskScore(args: {
  trades: ReadonlyArray<FrTrade>; now: number; orderSide: string; price: number;
  bestBid: number; bestAsk: number; tick: number;
  shortS?: number; longS?: number; floor?: number; proxMult?: number;
}): number {
  const shortS = args.shortS ?? 30.0;
  const longS = args.longS ?? 3600.0;
  const floor = args.floor ?? 0.1;
  const proxMult = args.proxMult ?? 0.9;
  const shortAct = windowActivity(args.trades, args.now, shortS, args.orderSide, 2.0, 1000.0);
  const longAct = windowActivity(args.trades, args.now, longS, args.orderSide, 20.0, 5000.0);
  const base = 0.3 * shortAct + 0.7 * longAct;
  const spike = Math.min(1.0, shortAct * 1.5);
  const activity = Math.max(base, 0.5 * spike + 0.5 * base);
  const prox = bookProximityRisk(args.orderSide, args.price, args.bestBid, args.bestAsk, args.tick);
  return Math.min(1.0, activity * (floor + proxMult * prox));
}

export function classify(score: number): FillRiskLevel {
  if (score < 0.25) return LOW;
  if (score < 0.5) return MODERATE;
  if (score < 0.75) return ELEVATED;
  return HIGH;
}

/** How many ticks to back the at-risk side away from the touch, by level. HIGH = pull (caller decides). */
export function widenTicksForLevel(level: FillRiskLevel, baseWiden = 2): number {
  switch (level) {
    case LOW: return 0;
    case MODERATE: return 1;
    case ELEVATED: return baseWiden;
    case HIGH: return Math.trunc(baseWiden * 1.5 + 0.999);
    default: return 0;
  }
}

const TICK = 0.01;

/** A planned bid the overlay can adjust. */
export type FrBid = { px: number; sz: number } | null;

/**
 * Real-time tape reaction on a planned pair (the NEXT lever after the cost
 * guard): per side, score directional fill-risk and back the BUY bid away from
 * the touch — ELEVATED widens N ticks, HIGH pulls the side entirely. Lowering a
 * bid only RAISES merge margin and can't violate the pair budget, so this is
 * strictly safer than the base plan.
 *
 *   shadow=true → compute levels + the counterfactual adjustment but leave the
 *   quotes UNTOUCHED (a clean forward control arm); the caller logs `frShadow`.
 *
 * Pure; returns new bids + the per-side levels. null bids stay null. Direct port
 * of merge_maker.apply_fill_risk_overlay (BUY-only, as the pair maker only buys).
 */
export function applyFillRiskOverlay(args: {
  yesBid: FrBid; noBid: FrBid;
  yesTrades: ReadonlyArray<FrTrade>; noTrades: ReadonlyArray<FrTrade>;
  now: number; // seconds, same clock as trade ts
  yesTouch: { bestBid: number; bestAsk: number };
  noTouch: { bestBid: number; bestAsk: number };
  tick?: number; baseWiden?: number; shadow?: boolean;
}): { yesBid: FrBid; noBid: FrBid; fr: { yes?: FillRiskLevel; no?: FillRiskLevel } } {
  const tick = args.tick ?? TICK;
  const baseWiden = args.baseWiden ?? 2;
  const fr: { yes?: FillRiskLevel; no?: FillRiskLevel } = {};
  const adjust = (bid: FrBid, trades: ReadonlyArray<FrTrade>, touch: { bestBid: number; bestAsk: number }, key: "yes" | "no"): FrBid => {
    if (!bid) return null;
    const score = fillRiskScore({
      trades, now: args.now, orderSide: "BUY", price: bid.px,
      bestBid: touch.bestBid, bestAsk: touch.bestAsk, tick,
    });
    const level = classify(score);
    fr[key] = level;
    let next: FrBid;
    if (level === HIGH) {
      next = null; // pull the hammered side
    } else {
      const wTicks = widenTicksForLevel(level, baseWiden);
      if (wTicks) {
        const nq = Math.round((bid.px - wTicks * tick) * 100) / 100;
        next = nq >= tick ? { px: nq, sz: bid.sz } : null; // don't quote below a tick — pull
      } else {
        next = bid; // LOW: unchanged
      }
    }
    return args.shadow ? bid : next; // shadow: leave the live quote untouched
  };
  return {
    yesBid: adjust(args.yesBid, args.yesTrades, args.yesTouch, "yes"),
    noBid: adjust(args.noBid, args.noTrades, args.noTouch, "no"),
    fr,
  };
}
