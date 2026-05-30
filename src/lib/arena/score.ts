/**
 * Arena scoring — adapted from TradingBot's Arena leaderboard formula:
 *   fitness = pnl_pct − 2.0 × max_dd_pct
 *
 * Each paper agent maintains running `peak_equity_usd` and `max_drawdown_usd`
 * fields on its row. The score function reads the agent's current state and
 * returns a single number used to rank survivors at generation seal time.
 *
 * Auxiliary metrics (win_rate, sharpe) are exposed for the UI but NOT used
 * in the primary fitness function — Sharpe over short tick windows is too
 * noisy to drive survival pressure reliably.
 */
import type { PaperAgentRow } from "./types";

export type Score = {
  pnl_pct: number;          // (cash_current + unrealized − cash_start) / cash_start
  max_dd_pct: number;       // max_drawdown_usd / peak_equity_usd
  activity_bonus: number;   // min(entries, ACTIVITY_CAP) × ACTIVITY_BONUS_PER_ENTRY
  fitness: number;          // pnl_pct − DD_PENALTY × max_dd_pct + activity_bonus
  win_rate: number;         // wins / trades (0 if no trades)
  trades_count: number;
  entries_count: number;
};

export const DD_PENALTY = 2.0;
/**
 * Activity bonus — rewards agents who *act*, breaks ties in favor of trading
 * over hold-forever. Capped so a spam-clicking agent can't dominate purely on
 * volume — quality still has to show up via pnl_pct.
 *
 * Bonus is per-entry (counts both open and closed positions), not per-round-
 * trip — otherwise an agent with positions still open at gen-seal time gets
 * no credit for taking action. Tuned 2026-05-25 per
 * `docs/prds/arena-agent-decision-framework.md` §6.1.R1.2.
 */
export const ACTIVITY_BONUS_PER_ENTRY = 0.005;  // +0.5 pp per entry
export const ACTIVITY_CAP = 5;                  // saturates at 5 entries → max +2.5 pp

/**
 * Sum of `size_usd` across the agent's currently-open positions. When an
 * agent enters a position, cash is debited by `size_usd`; the principal is
 * "locked" in the position until exit. True equity must include this locked
 * principal — otherwise every open position looks like a loss equal to its
 * own size. (Bug discovered 2026-05-25 when MM agents with $1 entries
 * appeared to lose 1% PnL despite price not moving.)
 *
 * Safe to JSON.parse here — position_basket_json is written by
 * persistAgentTick which always JSON.stringify's a typed array.
 */
function openPrincipalUsd(a: PaperAgentRow): number {
  if (!a.position_basket_json || a.position_basket_json === "[]") return 0;
  try {
    const positions = JSON.parse(a.position_basket_json) as Array<{ size_usd?: number }>;
    let s = 0;
    for (const p of positions) s += Number(p.size_usd ?? 0);
    return s;
  } catch {
    return 0;
  }
}

/**
 * True equity = cash + locked principal (open positions at entry value) +
 * unrealized PnL (mark-to-market change since entry).
 *
 * Equivalent formulation: cash + sum(size_usd × (1 + shareReturn)).
 */
export function liveEquity(a: PaperAgentRow): number {
  return a.cash_usd_current + openPrincipalUsd(a) + a.unrealized_pnl_usd;
}

export function scoreAgent(a: PaperAgentRow): Score {
  const equity = liveEquity(a);
  const pnl_pct = a.cash_usd_start > 0 ? (equity - a.cash_usd_start) / a.cash_usd_start : 0;
  const peak = a.peak_equity_usd > 0 ? a.peak_equity_usd : a.cash_usd_start;
  const max_dd_pct = peak > 0 ? a.max_drawdown_usd / peak : 0;
  const entries = a.entries_count ?? 0; // older fixtures + persisted rows pre-migration
  const activity_bonus = Math.min(entries, ACTIVITY_CAP) * ACTIVITY_BONUS_PER_ENTRY;
  const fitness = pnl_pct - DD_PENALTY * max_dd_pct + activity_bonus;
  const win_rate = a.trades_count > 0 ? a.wins_count / a.trades_count : 0;
  return { pnl_pct, max_dd_pct, activity_bonus, fitness, win_rate, trades_count: a.trades_count, entries_count: entries };
}

/**
 * Rank a list of agents by descending fitness; ties broken by realized PnL,
 * then by *whether the agent has traded at all* (agents that fired at least
 * once outrank pure-0-trade agents), then by id ASC (older agents win on
 * complete ties so newly-injected ones don't get culled before they've had
 * a chance to fire).
 */
export function rankAgents(agents: PaperAgentRow[]): Array<{ agent: PaperAgentRow; score: Score }> {
  return agents
    .map((agent) => ({ agent, score: scoreAgent(agent) }))
    .sort((a, b) => {
      if (b.score.fitness !== a.score.fitness) return b.score.fitness - a.score.fitness;
      if (b.agent.realized_pnl_usd !== a.agent.realized_pnl_usd) return b.agent.realized_pnl_usd - a.agent.realized_pnl_usd;
      // Both 0 PnL → prefer agents that have at least placed a trade
      const aHasTraded = a.agent.trades_count > 0 ? 1 : 0;
      const bHasTraded = b.agent.trades_count > 0 ? 1 : 0;
      if (aHasTraded !== bHasTraded) return bHasTraded - aHasTraded;
      // Still tied → older agent wins (lower id) so fresh injections aren't
      // automatically culled before they've taken a tick.
      return a.agent.id - b.agent.id;
    });
}

/** Pick top-K and bottom-N from a ranked list. Used by `arena:evolve`. */
export function partitionSurvivors(
  ranked: Array<{ agent: PaperAgentRow; score: Score }>,
  survivorPct = 0.5,
): { survivors: typeof ranked; cull: typeof ranked } {
  const k = Math.max(1, Math.floor(ranked.length * survivorPct));
  return { survivors: ranked.slice(0, k), cull: ranked.slice(k) };
}
