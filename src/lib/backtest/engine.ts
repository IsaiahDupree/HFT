import { db } from "@/lib/db/client";
import {
  applyLatency,
  getFillFn,
  latencyMsToSnapshots,
  type FillModel,
} from "./fill-model";
import type {
  BacktestResult,
  BacktestState,
  Decision,
  DecisionFn,
  SnapshotPoint,
  Trade,
} from "./types";

/**
 * Backtester — replays a sequence of market snapshots through a decision
 * function and returns a TradingBot-style arena score
 * (`pnl_pct − k * max_dd_pct`, default k=2.0).
 *
 * Decision functions are pure and stateless across runs; the engine carries
 * the trade state on the operator's behalf. Designed so a research-loop
 * evaluator can score a proposed strategy_version before promoting it.
 */

export type RunOptions = {
  startingCash?: number;     // default $1000
  dragPenalty?: number;      // arena score weight on max_dd_pct, default 2.0
  fillModel?: FillModel;     // 'midpoint' (default) | 'walk_book'
  latencyMs?: number;        // 0 (default). Decision at snap[i] fills at snap[i+delay].
};

export function runBacktest(
  snapshots: SnapshotPoint[],
  decide: DecisionFn,
  opts: RunOptions = {},
): BacktestResult {
  const startingCash = opts.startingCash ?? 1000;
  const k = opts.dragPenalty ?? 2.0;
  const fillFn = getFillFn(opts.fillModel ?? "midpoint");
  const latencySnapshots = latencyMsToSnapshots(snapshots, opts.latencyMs ?? 0);

  const state: BacktestState = {
    cash: startingCash,
    openTrade: null,
    closedTrades: [],
    equityHistory: [],
  };

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const decision = decide(snap, state);
    // Latency model: a decision at index i fills against snapshot[i + delay].
    // Hold decisions skip the lookup since there's nothing to fill.
    const fillSnap = decision.action === "hold"
      ? snap
      : applyLatency(snapshots, i, latencySnapshots);
    applyDecision(decision, fillSnap, state, fillFn);
    state.equityHistory.push(markEquity(state, snap, fillFn));
  }

  // Force-close any open trade at the last seen price for a clean PnL.
  if (state.openTrade) {
    const last = snapshots[snapshots.length - 1];
    const fill = fillFn({ side: state.openTrade.side, action: "close", snapshot: last, size: state.openTrade.size });
    const exitPrice = fill.price ?? state.openTrade.entryPrice;
    state.openTrade.exitPrice = exitPrice;
    state.openTrade.exitSnapshotAt = last.captured_at;
    state.openTrade.pnl = (exitPrice - state.openTrade.entryPrice) * state.openTrade.size;
    state.cash += state.openTrade.size * exitPrice;
    state.closedTrades.push(state.openTrade);
    state.openTrade = null;
  }

  return summarize(state, startingCash, k);
}

type FillFn = ReturnType<typeof getFillFn>;

function applyDecision(decision: Decision, snap: SnapshotPoint, state: BacktestState, fillFn: FillFn): void {
  if (decision.action === "hold") return;
  if (decision.action === "enter" && state.openTrade == null) {
    const fill = fillFn({ side: decision.side, action: "open", snapshot: snap, size: decision.size });
    if (fill.price == null || fill.filledSize <= 0) return;
    const cost = fill.filledSize * fill.price;
    if (cost > state.cash) return; // not enough cash, silently skip
    state.cash -= cost;
    state.openTrade = {
      side: decision.side,
      entryPrice: fill.price,
      entrySnapshotAt: snap.captured_at,
      exitPrice: null,
      exitSnapshotAt: null,
      size: fill.filledSize,
      pnl: 0,
    };
    return;
  }
  if (decision.action === "exit" && state.openTrade != null) {
    const t = state.openTrade;
    const fill = fillFn({ side: t.side, action: "close", snapshot: snap, size: t.size });
    const price = fill.price ?? t.entryPrice;
    t.exitPrice = price;
    t.exitSnapshotAt = snap.captured_at;
    t.pnl = (price - t.entryPrice) * t.size;
    state.cash += t.size * price;
    state.closedTrades.push(t);
    state.openTrade = null;
  }
}

function markEquity(state: BacktestState, snap: SnapshotPoint, fillFn: FillFn): number {
  if (state.openTrade) {
    // Mark-to-market uses the closing price (what we'd receive if we exited now).
    const fill = fillFn({ side: state.openTrade.side, action: "close", snapshot: snap, size: state.openTrade.size });
    const price = fill.price ?? state.openTrade.entryPrice;
    return state.cash + state.openTrade.size * price;
  }
  return state.cash;
}

function summarize(state: BacktestState, startingCash: number, k: number): BacktestResult {
  const endingEquity = state.equityHistory[state.equityHistory.length - 1] ?? state.cash;
  const pnlUsd = endingEquity - startingCash;
  const pnlPct = startingCash > 0 ? pnlUsd / startingCash : 0;

  let peak = startingCash;
  let maxDD = 0;
  for (const eq of state.equityHistory) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = peak > 0 ? maxDD / peak : 0;

  const tradesCount = state.closedTrades.length;
  const wins = state.closedTrades.filter((t) => t.pnl > 0).length;
  const winRate = tradesCount > 0 ? wins / tradesCount : 0;

  // Star-Algorithm arena formula. Multiplying by 100 normalizes both to %
  // (pnl_pct=0.20 means "+20%") so the score is interpretable as a percentage.
  const score = pnlPct * 100 - k * maxDDPct * 100;

  return {
    startingCash,
    endingEquity,
    pnlUsd,
    pnlPct,
    tradesCount,
    winRate,
    maxDrawdownUsd: maxDD,
    maxDrawdownPct: maxDDPct,
    score,
    trades: state.closedTrades,
  };
}

// -------------------------------------------------- snapshot loader

export function loadSnapshotsForToken(tokenId: string, limit = 1000): SnapshotPoint[] {
  return db()
    .prepare(
      `SELECT token_id, question, midpoint, spread, yes_price, no_price, volume_24h, captured_at
         FROM market_snapshots
         WHERE token_id = ?
         ORDER BY captured_at ASC
         LIMIT ?`,
    )
    .all(tokenId, limit) as SnapshotPoint[];
}

// -------------------------------------------------- example decision functions

/** Buy YES when midpoint dips below threshold, sell when it recovers above exitAt. */
export function thresholdMeanReversion(opts: {
  buyBelow: number;
  sellAbove: number;
  sizeShares: number;
}): DecisionFn {
  return (snap, state) => {
    const mid = snap.midpoint;
    if (mid == null) return { action: "hold" };
    if (state.openTrade == null && mid < opts.buyBelow) {
      return { action: "enter", side: "YES", size: opts.sizeShares };
    }
    if (state.openTrade != null && mid > opts.sellAbove) {
      return { action: "exit" };
    }
    return { action: "hold" };
  };
}
