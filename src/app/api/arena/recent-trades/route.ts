import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
  const rows = db().prepare(
    `SELECT pt.id, pt.tick_at, pt.venue, pt.market_id, pt.intent, pt.side,
            pt.price, pt.size_usd, pt.realized_pnl_usd, pt.signal_rationale,
            pa.id   AS agent_id,
            pa.name AS agent_name, pa.generation
       FROM paper_trades pt
       JOIN paper_agents pa ON pa.id = pt.paper_agent_id
       ORDER BY pt.id DESC LIMIT ?`,
  ).all(limit) as Array<{
    id: number; tick_at: string; venue: string; market_id: string; intent: string; side: string;
    price: number; size_usd: number; realized_pnl_usd: number | null; signal_rationale: string | null;
    agent_id: number; agent_name: string; generation: number;
  }>;
  return NextResponse.json({ count: rows.length, trades: rows });
}
