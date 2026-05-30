/**
 * Maker strategies for the L2 backtester. Each is a callback invoked after every
 * market event; it cancel-replaces resting quotes via the engine API. Orders are
 * post-only makers (they never cross — we floor the bid / ceil the ask to tick).
 */
import { logit, logitSpaceQuotes, microprice, sigmoid, type ASParams } from "@/lib/strategies/as-market-maker";
import type { L2Backtester, Strategy } from "./engine";
import { SignalEngine } from "./signals";

type Quotes = { bidOid?: number; askOid?: number };

function snapBid(p: number, tick: number): number { return Math.max(tick, Math.floor(p / tick) * tick); }
function snapAsk(p: number, tick: number): number { return Math.min(1 - tick, Math.ceil(p / tick) * tick); }

function withdraw(bt: L2Backtester, st: Quotes, ts: number): void {
  if (st.bidOid != null) { bt.cancel(ts, st.bidOid); st.bidOid = undefined; }
  if (st.askOid != null) { bt.cancel(ts, st.askOid); st.askOid = undefined; }
}

/** Phase-3 baseline: symmetric constant half-spread around the mid. */
export function constantSpreadStrategy(halfSpread: number, size: number): Strategy {
  const st: Quotes = {};
  return (bt, ev) => {
    if (ev.kind !== "book") return;
    const mid = bt.mid();
    if (mid <= 0 || mid >= 1) { withdraw(bt, st, ev.ts); return; }
    const bid = snapBid(mid - halfSpread, bt.tick);
    const ask = snapAsk(mid + halfSpread, bt.tick);
    if (bid >= ask) return;
    withdraw(bt, st, ev.ts);
    st.bidOid = bt.placeLimit(ev.ts, "bid", bid, size);
    st.askOid = bt.placeLimit(ev.ts, "ask", ask, size);
  };
}

/**
 * Avellaneda-Stoikov maker in LOGIT space, inventory-skewed, boundary-capped.
 * Uses a fixed steady-state horizon (t=0) so the half-spread doesn't collapse at
 * session end. Withdraws when the microprice hits a boundary or inventory exceeds
 * the boundary cap |q| ≤ M·√(p(1-p)).
 */
export function asMmStrategy(params: ASParams, opts: { size: number; maxExposureM?: number }): Strategy {
  const st: Quotes = {};
  return (bt, ev) => {
    if (ev.kind !== "book") return;
    const pMid = microprice(bt.book.bidPx, bt.book.bidSz, bt.book.askPx, bt.book.askSz);
    if (pMid <= 0 || pMid >= 1) { withdraw(bt, st, ev.ts); return; }
    const q = logitSpaceQuotes(pMid, bt.inventory, 0, params, opts.maxExposureM ?? 100);
    if (!q) { withdraw(bt, st, ev.ts); return; } // over boundary inventory cap
    const bid = snapBid(q.bid, bt.tick);
    const ask = snapAsk(q.ask, bt.tick);
    if (bid >= ask) { withdraw(bt, st, ev.ts); return; }
    withdraw(bt, st, ev.ts);
    st.bidOid = bt.placeLimit(ev.ts, "bid", bid, opts.size);
    st.askOid = bt.placeLimit(ev.ts, "ask", ask, opts.size);
  };
}

/**
 * AS-with-signals (handbook §9): logit reservation skewed by an OFI-driven drift
 * (`betaOfi·OFI` — the calibrated forward Δlogit), inventory-skewed, with a VPIN
 * toxicity gate (widen, or withdraw if `vpinWithdraw`, when toxicity is high).
 * `betaOfi` is fit per-venue via `calibrateOfiAlpha` — it is the alpha.
 */
export function asMmSignalStrategy(
  params: ASParams,
  opts: { size: number; betaOfi: number; vpinThreshold?: number; vpinWiden?: number; vpinWithdraw?: boolean; maxExposureM?: number },
): Strategy {
  const st: Quotes = {};
  const sig = new SignalEngine();
  const M = opts.maxExposureM ?? 100;
  return (bt, ev) => {
    if (ev.kind === "place" || ev.kind === "cancel") return; // not market data
    const s = sig.onEvent(ev); // accumulates on book+trade; returns Signals on book
    if (ev.kind !== "book" || !s) return;
    const pMid = s.microprice;
    if (pMid <= 0 || pMid >= 1) { withdraw(bt, st, ev.ts); return; }
    if (Math.abs(bt.inventory) > Math.floor(M * Math.sqrt(pMid * (1 - pMid)))) { withdraw(bt, st, ev.ts); return; }

    const toxic = s.vpin > (opts.vpinThreshold ?? Infinity);
    if (toxic && opts.vpinWithdraw) { withdraw(bt, st, ev.ts); return; }

    const tau = params.T;
    const sig2 = params.sigma * params.sigma;
    // x_res = x_mid + α-skew(OFI) − inventory-skew  (steady-state τ = T)
    const xRes = logit(pMid) + opts.betaOfi * s.ofi - bt.inventory * params.gamma * sig2 * tau;
    let halfSpread = params.gamma * sig2 * tau + (2 / params.gamma) * Math.log(1 + params.gamma / params.kappa);
    if (toxic) halfSpread *= opts.vpinWiden ?? 2; // widen on adverse-selection toxicity

    const bid = snapBid(sigmoid(xRes - halfSpread), bt.tick);
    const ask = snapAsk(sigmoid(xRes + halfSpread), bt.tick);
    if (bid >= ask) { withdraw(bt, st, ev.ts); return; }
    withdraw(bt, st, ev.ts);
    st.bidOid = bt.placeLimit(ev.ts, "bid", bid, opts.size);
    st.askOid = bt.placeLimit(ev.ts, "ask", ask, opts.size);
  };
}

/** Acceptance baseline: places nothing — must return PnL exactly 0. */
export const doNothingStrategy: Strategy = () => {};
