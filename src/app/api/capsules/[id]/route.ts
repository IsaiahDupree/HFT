import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteCapsule, getCapsule, setStatus, updateRealtime } from "@/lib/capsules/store";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["draft", "paper", "live", "paused", "stopped", "closed"]).optional(),
  realtime: z
    .object({
      current_pnl_usd: z.number().optional(),
      daily_pnl_usd: z.number().optional(),
      capital_deployed_usd: z.number().nonnegative().optional(),
      capital_available_usd: z.number().nonnegative().optional(),
      open_positions: z.number().int().nonnegative().optional(),
      trades_today: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const capsule = getCapsule(id);
  if (!capsule) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ capsule });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const existing = getCapsule(id);
  if (!existing) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 });

  if (parsed.data.status) setStatus(id, parsed.data.status);
  if (parsed.data.realtime) updateRealtime(id, parsed.data.realtime);
  return NextResponse.json({ ok: true, capsule: getCapsule(id) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteCapsule(id);
  return NextResponse.json({ ok: true });
}
