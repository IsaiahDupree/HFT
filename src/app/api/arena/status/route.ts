import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/**
 * Focused status payload for the sticky header. Cheap enough to poll every 30s.
 */
export async function GET() {
  const openGen = db().prepare(
    `SELECT id, gen_number, tick_count, started_at, n_agents FROM paper_generations
      WHERE sealed_at IS NULL ORDER BY gen_number DESC LIMIT 1`,
  ).get() as { id: number; gen_number: number; tick_count: number | null; started_at: string; n_agents: number } | undefined;

  const aliveTotal = (db().prepare(`SELECT COUNT(*) AS n FROM paper_agents WHERE alive = 1`).get() as { n: number }).n;
  const aliveByKind = db().prepare(
    `SELECT json_extract(genome_json, '$.kind') AS kind, COUNT(*) AS n
       FROM paper_agents WHERE alive = 1 GROUP BY kind ORDER BY n DESC`,
  ).all() as Array<{ kind: string; n: number }>;

  const lastTrade = db().prepare(
    `SELECT id, tick_at, venue, intent, side, size_usd FROM paper_trades ORDER BY id DESC LIMIT 1`,
  ).get() as { id: number; tick_at: string; venue: string; intent: string; side: string; size_usd: number } | undefined;

  const tradesToday = (db().prepare(
    `SELECT COUNT(*) AS n FROM paper_trades WHERE tick_at >= datetime('now', 'start of day')`,
  ).get() as { n: number }).n;

  // Live-money totals — sum across all live/paper capsules with a paper_agent_id.
  // Lets the header strip surface "real money on the line" at a glance.
  const liveMoney = db().prepare(
    `SELECT COUNT(*) AS n_capsules,
            COALESCE(SUM(capital_allocated_usd), 0) AS capital_usd,
            COALESCE(SUM(current_pnl_usd), 0) AS pnl_usd,
            COALESCE(SUM(daily_pnl_usd), 0) AS daily_pnl_usd
       FROM capsules
      WHERE status IN ('live','paper') AND paper_agent_id IS NOT NULL`,
  ).get() as { n_capsules: number; capital_usd: number; pnl_usd: number; daily_pnl_usd: number };

  // AI vs pattern-matcher headcount for the alive population — quick proxy for
  // "is any agent actually reasoning". An agent counts as AI-driven if its top
  // genome kind is llm_probability_oracle, OR if it's a multi_strategy with at
  // least one llm_probability_oracle sub-genome.
  const aiAgents = db().prepare(
    `SELECT COUNT(*) AS n FROM paper_agents
      WHERE alive = 1
        AND (json_extract(genome_json, '$.kind') = 'llm_probability_oracle'
             OR genome_json LIKE '%"kind":"llm_probability_oracle"%')`,
  ).get() as { n: number };

  const evolveEvery = Number(process.env.ARENA_EVOLVE_EVERY ?? "50");

  return NextResponse.json({
    open_generation: openGen ? {
      gen_number: openGen.gen_number,
      tick_count: openGen.tick_count ?? 0,
      tick_target: evolveEvery,
      started_at: openGen.started_at,
      n_agents: openGen.n_agents,
    } : null,
    alive_total: aliveTotal,
    alive_by_kind: aliveByKind,
    ai_agents: aiAgents.n,
    last_trade: lastTrade ?? null,
    trades_today: tradesToday,
    evolve_every: evolveEvery,
    live_money: {
      n_capsules: liveMoney.n_capsules,
      capital_usd: liveMoney.capital_usd,
      current_pnl_usd: liveMoney.pnl_usd,
      daily_pnl_usd: liveMoney.daily_pnl_usd,
    },
  });
}
