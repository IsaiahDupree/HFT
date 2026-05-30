import { NextResponse } from "next/server";
import { getPaperAgent, listTradesForAgent, toLiveAgent } from "@/lib/arena/db";
import { scoreAgent } from "@/lib/arena/score";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isFinite(agentId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const agent = getPaperAgent(agentId);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const live = toLiveAgent(agent);
  return NextResponse.json({
    agent: { ...agent, genome: live.genome, positions: live.positions },
    score: scoreAgent(agent),
    trades: listTradesForAgent(agentId, 200),
  });
}
