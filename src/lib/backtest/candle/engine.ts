/**
 * Candle backtest engine — runs a daily position series over a real OHLC history
 * and reports PnL%, annualized Sharpe, max drawdown, trades, win-rate, vs a
 * buy-and-hold baseline. Deterministic, no lookahead (position[i] is held over
 * bar i→i+1, decided from info ≤ close[i]). Charges a turnover fee per change.
 */
export type DailyCandle = { start_unix: number; open: number; high: number; low: number; close: number; volume: number };

export type CandleResult = {
  bars: number;
  pnlPct: number;
  sharpe: number;       // annualized (√365)
  maxDdPct: number;
  trades: number;
  winRate: number;
  finalEquity: number;
  buyHoldPct: number;
};

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** `positions[i]` ∈ [-1,1] held during bar i→i+1. feeBps charged on |Δposition|.
 *  `periodsPerYear` annualizes Sharpe (daily=365, hourly=8760). */
export function runCandleBacktest(candles: DailyCandle[], positions: number[], opts: { feeBps?: number; periodsPerYear?: number } = {}): CandleResult {
  const feeBps = opts.feeBps ?? 10;
  const periodsPerYear = opts.periodsPerYear ?? 365;
  let equity = 1, peak = 1, maxDd = 0;
  const rets: number[] = [];
  let trades = 0, wins = 0, entryEquity = 0;
  let inPos = false;

  for (let i = 0; i < candles.length - 1; i++) {
    const pos = positions[i] ?? 0;
    const prev = i > 0 ? (positions[i - 1] ?? 0) : 0;
    const gross = pos * (candles[i + 1].close / candles[i].close - 1);
    const fee = Math.abs(pos - prev) * (feeBps / 1e4);
    const net = gross - fee;
    rets.push(net);
    equity *= 1 + net;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);

    if (pos !== 0 && !inPos) { inPos = true; entryEquity = equity; trades++; }
    if (pos === 0 && inPos) { inPos = false; if (equity > entryEquity) wins++; }
  }
  if (inPos && equity > entryEquity) wins++;

  const sd = std(rets);
  const sharpe = sd > 0 ? (mean(rets) / sd) * Math.sqrt(periodsPerYear) : 0;
  const buyHoldPct = candles.length > 1 ? (candles[candles.length - 1].close / candles[0].close - 1) * 100 : 0;
  return {
    bars: candles.length,
    pnlPct: (equity - 1) * 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDdPct: Math.round(maxDd * 1000) / 10,
    trades,
    winRate: trades > 0 ? Math.round((wins / trades) * 1000) / 10 : 0,
    finalEquity: Math.round(equity * 1000) / 1000,
    buyHoldPct: Math.round(buyHoldPct * 10) / 10,
  };
}
