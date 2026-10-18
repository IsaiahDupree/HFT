import { NextResponse } from "next/server";
import { listAliveAgentsAcrossGens } from "@/lib/arena/db";
import { rankAgents } from "@/lib/arena/score";

export const dynamic = "force-dynamic";

export async function GET() {
  const agents = listAliveAgentsAcrossGens();
  const ranked = rankAgents(agents).map(({ agent, score }) => ({
    id: agent.id, name: agent.name, generation: agent.generation,
    parent_paper_agent_id: agent.parent_paper_agent_id,
    cash_usd_current: agent.cash_usd_current, realized_pnl_usd: agent.realized_pnl_usd,
    unrealized_pnl_usd: agent.unrealized_pnl_usd, trades_count: agent.trades_count,
    score,
  }));
  return NextResponse.json({ ranked });
}
