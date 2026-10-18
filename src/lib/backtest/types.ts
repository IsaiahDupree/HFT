/**
 * Backtest types. Borrowed conceptually from TradingBot/src/sim — kept
 * intentionally narrow for Polymarket binary markets (YES/NO) over
 * market_snapshots rows.
 */

export type SnapshotPoint = {
  token_id: string;
  question: string;
  midpoint: number | null;
  spread: number | null;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  captured_at: string;
};

export type Decision =
  | { action: "enter"; side: "YES" | "NO"; size: number }   // size in shares
  | { action: "exit" }
  | { action: "hold" };

export type DecisionFn = (snapshot: SnapshotPoint, state: BacktestState) => Decision;

export type Trade = {
  side: "YES" | "NO";
  entryPrice: number;
  entrySnapshotAt: string;
  exitPrice: number | null;
  exitSnapshotAt: string | null;
  size: number;       // shares
  pnl: number;        // realized PnL in USD (size * (exitPrice - entryPrice))
};

export type BacktestState = {
  cash: number;
  openTrade: Trade | null;
  closedTrades: Trade[];
  equityHistory: number[]; // mark-to-midpoint equity at each step
};

export type BacktestResult = {
  startingCash: number;
  endingEquity: number;
  pnlUsd: number;
  pnlPct: number;
  tradesCount: number;
  winRate: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  /** Star-Algorithm arena score from TradingBot: pnl_pct − k * max_dd_pct */
  score: number;
  trades: Trade[];
};
