/**
 * Aggregates paper_agent fitness across the last N generations, grouped by
 * `introduced_by` (mutate-programmatic | mutate-llm | survivor-carryover |
 * init). Lets you answer "is the LLM-mutated cohort actually doing better
 * than the cheap programmatic mutator?"
 *
 * Used by scripts/arena-compare-mutation.ts and /arena/mutations.
 */
import { db } from "@/lib/db/client";
import { scoreAgent } from "./score";
import type { PaperAgentRow } from "./types";

export type MutationCohort = {
  introduced_by: string;
  n_agents: number;
  avg_fitness: number;
  med_fitness: number;
  avg_pnl_pct: number;
  avg_dd_pct: number;
  total_trades: number;
  win_rate: number;          // wins / trades, across all agents in cohort
  top_fitness: number;
  bottom_fitness: number;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function compareMutationCohorts(opts: { lastN?: number } = {}): { cohorts: MutationCohort[]; gens_considered: number[]; total_agents: number } {
  const lastN = opts.lastN ?? 5;
  // Find the most recent N generations (sealed OR open).
  const gens = (db().prepare(
    `SELECT gen_number FROM paper_generations ORDER BY gen_number DESC LIMIT ?`,
  ).all(lastN) as Array<{ gen_number: number }>).map((r) => r.gen_number);
  if (gens.length === 0) return { cohorts: [], gens_considered: [], total_agents: 0 };

  const placeholders = gens.map(() => "?").join(",");
  const agents = db().prepare(
    `SELECT * FROM paper_agents WHERE generation IN (${placeholders})`,
  ).all(...gens) as PaperAgentRow[];

  const groups = new Map<string, PaperAgentRow[]>();
  for (const a of agents) {
    const key = a.introduced_by;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  const cohorts: MutationCohort[] = [];
  for (const [introduced_by, rows] of groups) {
    const scores = rows.map((r) => scoreAgent(r));
    const fitnesses = scores.map((s) => s.fitness);
    const totalTrades = rows.reduce((acc, r) => acc + r.trades_count, 0);
    const totalWins = rows.reduce((acc, r) => acc + r.wins_count, 0);
    cohorts.push({
      introduced_by,
      n_agents: rows.length,
      avg_fitness: fitnesses.reduce((s, x) => s + x, 0) / fitnesses.length,
      med_fitness: median(fitnesses),
      avg_pnl_pct: scores.reduce((s, x) => s + x.pnl_pct, 0) / scores.length,
      avg_dd_pct: scores.reduce((s, x) => s + x.max_dd_pct, 0) / scores.length,
      total_trades: totalTrades,
      win_rate: totalTrades > 0 ? totalWins / totalTrades : 0,
      top_fitness: Math.max(...fitnesses),
      bottom_fitness: Math.min(...fitnesses),
    });
  }
  cohorts.sort((a, b) => b.avg_fitness - a.avg_fitness);
  return { cohorts, gens_considered: gens.sort((a, b) => a - b), total_agents: agents.length };
}
