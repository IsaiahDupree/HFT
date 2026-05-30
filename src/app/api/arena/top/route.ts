import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/**
 * All-time top agents (across every generation, dead or alive), ranked by
 * realized PnL. Useful when a freshly-bred gen shows all-zero on the
 * leaderboard and you want to know who actually made money over the run.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "10")));
  // Pull metrics from paper_trades directly so a cash rebalance that zeroed
  // trades_count on paper_agents doesn't hide actual historical winners.
  const rows = db().prepare(
    `SELECT pa.id, pa.name, pa.generation, pa.alive,
            pa.cash_usd_start, pa.cash_usd_current, pa.unrealized_pnl_usd,
            json_extract(pa.genome_json, '$.kind') AS kind,
            COUNT(pt.id) AS trades_count,
            SUM(CASE WHEN pt.realized_pnl_usd > 0 THEN 1 ELSE 0 END) AS wins_count,
            COALESCE(SUM(pt.realized_pnl_usd), 0) AS realized_pnl_usd,
            COALESCE(SUM(pt.realized_pnl_usd), 0) + pa.unrealized_pnl_usd AS net_pnl_usd
       FROM paper_agents pa
       JOIN paper_trades pt ON pt.paper_agent_id = pa.id
      GROUP BY pa.id
      ORDER BY net_pnl_usd DESC
      LIMIT ?`,
  ).all(limit) as Array<{
    id: number; name: string; generation: number; alive: 0 | 1;
    cash_usd_start: number; cash_usd_current: number;
    realized_pnl_usd: number; unrealized_pnl_usd: number;
    trades_count: number; wins_count: number;
    kind: string; net_pnl_usd: number;
  }>;
  return NextResponse.json({ count: rows.length, top: rows });
}
