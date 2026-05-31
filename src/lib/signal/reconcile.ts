/**
 * Shadow reconciliation — did the ETH:5m signals we ROUTED (dry-run) actually win?
 * This is the arm-on-evidence gate: separate from the 2dollar-bot's paper ledger,
 * it checks each routed signal against its OWN window's outcome (close>open from
 * 1-min candles) and reports realized would-be PnL + Wilson-bounded win rate.
 *
 * Pure functions — unit-tested. The DB/candle join lives in scripts/signal-reconcile.ts.
 */
import { wilsonLower } from "@/lib/oracle/lift";

export type RoutedSignal = {
  asset: string;
  recurrence: string;
  side: string; // UP | DOWN | YES | NO
  entry_price: number;
  window_end_ts: number;
};

/** Reconcile one routed signal against its window outcome (resolvedUp = close>open).
 *  Returns won/pnl (null when the outcome is unknown — window not yet resolved). */
export function reconcileOne(sig: RoutedSignal, resolvedUp: boolean | null, stake = 2):
  { sideUp: boolean; won: boolean | null; pnl: number | null } {
  const sideUp = ["UP", "YES"].includes(String(sig.side).toUpperCase());
  if (resolvedUp == null) return { sideUp, won: null, pnl: null };
  const won = resolvedUp === sideUp;
  const e = sig.entry_price;
  const pnl = e > 0 && e < 1 ? (won ? (stake * (1 - e)) / e : -stake) : 0;
  return { sideUp, won, pnl: Number(pnl.toFixed(4)) };
}

export type ReconSummary = {
  n: number; // resolved signals
  wins: number;
  win: number;
  winCiLow: number;
  pnl: number; // total realized would-be PnL
  roi: number; // pnl / total staked
  pending: number; // routed but window not yet resolved
};

export function summarize(reconciled: Array<{ won: boolean | null; pnl: number | null }>, stake = 2): ReconSummary {
  const resolved = reconciled.filter((r) => r.won !== null);
  const n = resolved.length;
  const wins = resolved.filter((r) => r.won).length;
  const pnl = resolved.reduce((a, r) => a + (r.pnl ?? 0), 0);
  return {
    n,
    wins,
    win: n ? Number((wins / n).toFixed(4)) : 0,
    winCiLow: n ? Number(wilsonLower(wins, n).toFixed(4)) : 0,
    pnl: Number(pnl.toFixed(2)),
    roi: n ? Number((pnl / (n * stake)).toFixed(4)) : 0,
    pending: reconciled.length - n,
  };
}
