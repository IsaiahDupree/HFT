/**
 * LLM oracle budget guard — refuses calls once the daily $ cap is hit.
 *
 * Reads ARENA_LLM_ORACLE_DAILY_USD (default $1) and sums `cost_usd` from
 * `llm_call_log` for today (UTC). When the sum crosses the cap, all calls
 * (including cache misses) refuse — cache hits still serve because they cost
 * nothing.
 *
 * Spec: `docs/prds/lunar-inspired-arena-strategies.md` §6.5.R5 cost cap.
 */
import { db } from "@/lib/db/client";

export function defaultDailyBudgetUsd(): number {
  return Number(process.env.ARENA_LLM_ORACLE_DAILY_USD ?? "1");
}

/** USD spent on LLM oracle calls so far today (UTC). Cache hits count as $0. */
export function todaysOracleSpendUsd(): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM llm_call_log
      WHERE called_at >= date('now')
        AND cache_hit = 0`,
  ).get() as { total: number };
  return row.total ?? 0;
}

export type BudgetStatus = {
  spent_usd: number;
  cap_usd: number;
  remaining_usd: number;
  allowed: boolean;
};

export function checkBudget(): BudgetStatus {
  const cap = defaultDailyBudgetUsd();
  const spent = todaysOracleSpendUsd();
  const remaining = Math.max(0, cap - spent);
  return { spent_usd: spent, cap_usd: cap, remaining_usd: remaining, allowed: spent < cap };
}
