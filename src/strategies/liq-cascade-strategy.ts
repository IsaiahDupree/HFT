/**
 * liq-cascade-strategy — near-HFT fade strategy driven by on-chain liquidation
 * events from DeFi (NAVI/Morpho) as a leading signal for CEX price cascades.
 *
 * EDGE HYPOTHESIS:
 *   Large DeFi liquidations ($50k+) force rapid collateral sales that propagate to
 *   CEX markets and cause a short-term price overshoot. The on-chain event is
 *   detectable (with 0-60s latency) BEFORE or concurrent with the CEX cascade peak.
 *   Fading the move within a 30-60 minute hold window captures the reversion.
 *
 * SIGNAL REQUIREMENTS (all must pass to open a position):
 *   1. On-chain liq event ≥ MIN_LIQ_USD in a recognized token (BTC/ETH/SOL/…)
 *   2. CEX 1m bar moved ≥ MIN_MOVE_BPS in the same direction within the last 5 bars
 *   3. dYdX OBI confirms directional pressure (OBI same sign as the cascade)
 *   4. No open position in this market (one-at-a-time per market)
 *
 * EXECUTION:
 *   - Enter: limit order at best_bid − ENTRY_OFFSET_BPS (long) or best_ask + ENTRY_OFFSET_BPS (short)
 *   - Exit:  limit order at entry ± TAKE_PROFIT_BPS, or market order after HOLD_MINUTES
 *   - All risk checks via the HFT-work RiskEngine
 *
 * ANTI-OVERFIT GUARDRAILS:
 *   - No in-sample parameter tuning on live data
 *   - Forward paper-track REQUIRED before live allocation
 *   - Daily loss halt carried from config
 *   - Walk-forward test in backtest-liq-cascade.ts validates the params used here
 */

import type { BookLevel } from "../lib/hft/dydx/signals.js";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type LiquidationEvent = {
  ts: number;
  venue: "navi" | "morpho";
  type: string;
  collateral_symbol: string | null;
  collateral_usd: number;
  debt_symbol: string | null;
  debt_usd: number;
  health_factor: number | null;
  profit_usd: number | null;
};

export type Bar1m = { t: number; o: number; h: number; l: number; c: number; v: number };

export type MarketState = {
  market: string;          // dYdX market id, e.g. "BTC-USD"
  oracle: number;
  bids: BookLevel[];
  asks: BookLevel[];
  recentBars: Bar1m[];     // last 10 1m bars, newest last
};

export type StrategyConfig = {
  minLiqUsd: number;             // minimum DeFi liquidation size to trigger a signal
  minMoveBps: number;            // minimum CEX 5-bar move to confirm cascade
  obiConfirmThreshold: number;   // OBI absolute value required to confirm direction
  entryOffsetBps: number;        // how far inside the book to post the limit entry
  takeProfitBps: number;         // target reversion relative to entry
  stopLossBps: number;           // hard stop loss relative to entry
  holdMinutes: number;           // fallback exit horizon
  maxPositionUsd: number;        // max notional per position
  dailyLossHaltUsd: number;      // halt trading if daily realized loss exceeds this
  signalWindowMs: number;        // how long a liq event remains actionable (ms)
};

export const DEFAULT_CONFIG: StrategyConfig = {
  minLiqUsd: 50_000,
  minMoveBps: 50,
  obiConfirmThreshold: 0.15,
  entryOffsetBps: 3,
  takeProfitBps: 40,
  stopLossBps: 20,
  holdMinutes: 45,
  maxPositionUsd: 2_000,
  dailyLossHaltUsd: 200,
  signalWindowMs: 5 * 60 * 1000, // event actionable for 5 minutes
};

// ──────────────────────────────────────────────────────────────
// Token → dYdX market mapping
// ──────────────────────────────────────────────────────────────

const COLLATERAL_TO_MARKET: Record<string, string> = {
  WBTC: "BTC-USD", BTCB: "BTC-USD", BTC: "BTC-USD",
  WETH: "ETH-USD", ETH: "ETH-USD",
  WSOL: "SOL-USD", SOL: "SOL-USD",
  cbBTC: "BTC-USD",
  USDC: "",  // stable — no directional trade
  USDT: "",
};

export function collateralToMarket(symbol: string | null): string | null {
  if (!symbol) return null;
  const m = COLLATERAL_TO_MARKET[symbol.toUpperCase()];
  return m || null;
}

// ──────────────────────────────────────────────────────────────
// Signal generation
// ──────────────────────────────────────────────────────────────

export type TradeSignal = {
  market: string;
  dir: 1 | -1;          // +1 = long (fade a down-cascade), -1 = short (fade up-cascade)
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  sizeUsd: number;
  reason: string;
  liqEvent: LiquidationEvent;
};

/** Compute the 5-bar return of the most recent bars (newest last). */
function recentMoveRet(bars: Bar1m[], windowBars: number): number {
  if (bars.length < windowBars + 1) return 0;
  const now = bars[bars.length - 1]!.c;
  const past = bars[bars.length - 1 - windowBars]!.c;
  return (now - past) / past;
}

/** Derive a trade signal from a liquidation event + current market state.
 *  Returns null if any signal gate fails. */
export function deriveSignal(
  event: LiquidationEvent,
  state: MarketState,
  cfg: StrategyConfig,
  nowMs: number,
): TradeSignal | null {
  // Gate 1: event freshness
  if (nowMs - event.ts > cfg.signalWindowMs) return null;

  // Gate 2: minimum size
  const liqUsd = Math.max(event.collateral_usd, event.debt_usd);
  if (liqUsd < cfg.minLiqUsd) return null;

  // Gate 3: known market
  const market = collateralToMarket(event.collateral_symbol);
  if (!market || market !== state.market) return null;

  // Gate 4: confirm CEX cascade (5-bar window)
  const moveBps = recentMoveRet(state.recentBars, 5) * 10_000;
  if (Math.abs(moveBps) < cfg.minMoveBps) return null;

  // Gate 5: OBI same direction as cascade (confirms real pressure)
  const bidSum = state.bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
  const askSum = state.asks.slice(0, 5).reduce((s, l) => s + l.size, 0);
  const total = bidSum + askSum;
  const obi = total > 0 ? (bidSum - askSum) / total : 0;

  const cascadeIsDown = moveBps < 0;
  const obiConfirmsDown = obi < -cfg.obiConfirmThreshold;
  const obiConfirmsUp = obi > cfg.obiConfirmThreshold;

  if (cascadeIsDown && !obiConfirmsDown) return null;
  if (!cascadeIsDown && !obiConfirmsUp) return null;

  // Fade: go opposite the cascade
  const dir: 1 | -1 = cascadeIsDown ? 1 : -1;

  const bestBid = state.bids[0]?.price ?? state.oracle;
  const bestAsk = state.asks[0]?.price ?? state.oracle;
  const mid = (bestBid + bestAsk) / 2;

  const offsetFrac = cfg.entryOffsetBps / 10_000;
  const entryPrice = dir === 1
    ? bestBid * (1 - offsetFrac)   // long: buy slightly below best bid
    : bestAsk * (1 + offsetFrac);  // short: sell slightly above best ask

  const tpFrac = cfg.takeProfitBps / 10_000;
  const slFrac = cfg.stopLossBps / 10_000;
  const takeProfitPrice = dir === 1 ? entryPrice * (1 + tpFrac) : entryPrice * (1 - tpFrac);
  const stopLossPrice = dir === 1 ? entryPrice * (1 - slFrac) : entryPrice * (1 + slFrac);

  const sizeUsd = Math.min(cfg.maxPositionUsd, liqUsd * 0.01); // size ≤ 1% of liq notional

  return {
    market,
    dir,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    sizeUsd,
    reason: `liq ${event.venue} ${liqUsd.toFixed(0)}USD hf=${event.health_factor?.toFixed(3) ?? "?"} move=${moveBps.toFixed(1)}bps obi=${obi.toFixed(3)} mid=${mid.toFixed(2)}`,
    liqEvent: event,
  };
}

// ──────────────────────────────────────────────────────────────
// Risk state
// ──────────────────────────────────────────────────────────────

export type OpenPosition = {
  market: string;
  dir: 1 | -1;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  sizeUsd: number;
  openedAt: number;
  holdDeadline: number;
  signalReason: string;
};

export class LiqCascadeRiskState {
  private openPositions = new Map<string, OpenPosition>();
  private dailyRealizedUsd = 0;
  private dayKey = "";

  constructor(private cfg: StrategyConfig) {}

  private checkDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dayKey) { this.dailyRealizedUsd = 0; this.dayKey = today; }
  }

  isHalted(): boolean {
    this.checkDay();
    return this.dailyRealizedUsd <= -this.cfg.dailyLossHaltUsd;
  }

  hasOpenPosition(market: string): boolean {
    return this.openPositions.has(market);
  }

  openPosition(signal: TradeSignal, nowMs: number): OpenPosition {
    const pos: OpenPosition = {
      market: signal.market,
      dir: signal.dir,
      entryPrice: signal.entryPrice,
      takeProfitPrice: signal.takeProfitPrice,
      stopLossPrice: signal.stopLossPrice,
      sizeUsd: signal.sizeUsd,
      openedAt: nowMs,
      holdDeadline: nowMs + this.cfg.holdMinutes * 60_000,
      signalReason: signal.reason,
    };
    this.openPositions.set(signal.market, pos);
    return pos;
  }

  closePosition(market: string, exitPrice: number, reason: string): number {
    const pos = this.openPositions.get(market);
    if (!pos) return 0;
    this.openPositions.delete(market);
    const ret = (exitPrice - pos.entryPrice) / pos.entryPrice;
    const pnlUsd = pos.dir * ret * pos.sizeUsd;
    this.checkDay();
    this.dailyRealizedUsd += pnlUsd;
    console.log(
      `  [close ${market}] price=${exitPrice.toFixed(4)} reason=${reason}` +
      ` pnl=${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}USD daily=${this.dailyRealizedUsd.toFixed(2)}USD`,
    );
    return pnlUsd;
  }

  checkExits(
    market: string,
    currentPrice: number,
    nowMs: number,
  ): "take-profit" | "stop-loss" | "hold-expired" | null {
    const pos = this.openPositions.get(market);
    if (!pos) return null;
    if (pos.dir === 1) {
      if (currentPrice >= pos.takeProfitPrice) return "take-profit";
      if (currentPrice <= pos.stopLossPrice) return "stop-loss";
    } else {
      if (currentPrice <= pos.takeProfitPrice) return "take-profit";
      if (currentPrice >= pos.stopLossPrice) return "stop-loss";
    }
    if (nowMs >= pos.holdDeadline) return "hold-expired";
    return null;
  }

  getOpenPositions(): Map<string, OpenPosition> {
    return this.openPositions;
  }

  getDailyPnlUsd(): number { return this.dailyRealizedUsd; }
}
