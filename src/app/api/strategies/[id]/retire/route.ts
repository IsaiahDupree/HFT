import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: stratIdRaw } = await params;
  const strategyId = Number(stratIdRaw);
  if (!strategyId) return NextResponse.json({ error: "strategyId required" }, { status: 400 });
  const handle = db();
  const strat = handle.prepare("SELECT * FROM strategies WHERE id = ?").get(strategyId) as any;
  if (!strat) return NextResponse.json({ error: "strategy not found" }, { status: 404 });
  if (strat.status === "retired") return NextResponse.json({ ok: true, already: true });
  handle.prepare("UPDATE strategies SET status = 'retired' WHERE id = ?").run(strategyId);
  insertEvolutionEvent({
    agent_id: strat.agent_id,
    strategy_id: strategyId,
    event_type: "retirement",
    summary: `Retired strategy "${strat.name}"`,
    payload_json: "{}",
  });
  return NextResponse.json({ ok: true });
}
