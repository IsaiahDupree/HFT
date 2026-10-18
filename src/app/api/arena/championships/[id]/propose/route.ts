import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeCapsuleForChampionship } from "@/lib/arena/championship";

export const dynamic = "force-dynamic";

const Body = z.object({
  capital_usd: z.number().positive().max(10000).optional(),
  daily_loss_cap_usd: z.number().positive().optional(),
  total_dd_cap_usd: z.number().positive().optional(),
  max_position_pct: z.number().min(0).max(1).optional(),
  max_open_positions: z.number().int().positive().optional(),
  max_trades_per_day: z.number().int().positive().optional(),
  allowed_venues: z.array(z.enum(["polymarket", "coinbase"])).optional(),
}).strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const championshipId = Number(id);
  if (!Number.isFinite(championshipId)) return NextResponse.json({ error: "invalid championship id" }, { status: 400 });
  let opts: z.infer<typeof Body> = {};
  try {
    if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
      opts = Body.parse(await req.json());
    }
  } catch (err) {
    return NextResponse.json({ error: "invalid body", details: (err as Error).message }, { status: 400 });
  }
  try {
    const result = proposeCapsuleForChampionship(championshipId, opts);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
}
