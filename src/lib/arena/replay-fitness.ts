/**
 * In-memory replay-fitness — runs a genome through a historical window of
 * snapshots WITHOUT writing to paper_trades or paper_agents. Used by the
 * capsule activation gate to check whether a champion holds up out-of-sample
 * before being granted real money.
 *
 * Uses the SAME `decide`/`applySignal`/`markToMarket` pipeline as the live
 * arena so the score is directly comparable to a real run.
 */
import { iterTickContexts } from "./context";
import { applySignal, decide, markToMarket } from "./sim";
import { scoreAgent } from "./score";
import type { Genome } from "./genome";
import type { LiveAgent, Position } from "./types";

export type ReplayFitnessResult = {
  pnl_pct: number;
  max_dd_pct: number;
  fitness: number;
  trades_count: number;
  win_rate: number;
  starting_cash: number;
  ending_equity: number;
  ticks: number;
};

export type ReplayFitnessOpts = {
  startIso?: string;             // default: now - 14 days
  endIso?: string;               // default: now
  tickIntervalMin?: number;      // default: 5
  startingCash?: number;         // default: 1000
};

/** Drive a genome through history; return final fitness metrics. */
export function computeReplayFitness(genome: Genome, opts: ReplayFitnessOpts = {}): ReplayFitnessResult {
  const startIso = opts.startIso ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
  const endIso = opts.endIso ?? new Date().toISOString();
  const interval = opts.tickIntervalMin ?? 5;
  const cash = opts.startingCash ?? 1000;

  // Build an in-memory LiveAgent — no DB writes.
  const agent: LiveAgent = {
    id: -1, name: "replay", generation: -1, parent_paper_agent_id: null,
    genome_json: JSON.stringify(genome), introduced_by: "replay",
    cash_usd_start: cash, cash_usd_current: cash, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: cash, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 0, wins_count: 0, alive: 1, is_elite: 0, retire_reason: null, retired_at: null,
    created_at: startIso, updated_at: startIso,
    genome, positions: [] as Position[],
  };

  let ticks = 0;
  const rng = Math.random;
  for (const ctx of iterTickContexts({ start: startIso, end: endIso, tickIntervalMin: interval })) {
    ticks += 1;
    const sig = decide(agent, ctx, rng);
    if (sig.kind !== "hold") {
      applySignal(agent, sig, ctx, -1);
    }
    markToMarket(agent, ctx);
  }

  const s = scoreAgent(agent);
  // Locked principal counts toward ending equity (same bug-fix as scoreAgent).
  let openPrincipal = 0;
  for (const p of agent.positions) openPrincipal += p.size_usd;
  return {
    pnl_pct: s.pnl_pct,
    max_dd_pct: s.max_dd_pct,
    fitness: s.fitness,
    trades_count: s.trades_count,
    win_rate: s.win_rate,
    starting_cash: agent.cash_usd_start,
    ending_equity: agent.cash_usd_current + openPrincipal + agent.unrealized_pnl_usd,
    ticks,
  };
}
