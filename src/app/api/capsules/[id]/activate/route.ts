import { NextResponse } from "next/server";
import { z } from "zod";
import { activateCapsule } from "@/lib/arena/championship";

export const dynamic = "force-dynamic";

const Body = z.object({
  activated_by: z.string().min(1),
  bypass: z.boolean().optional(),
  window_days: z.number().int().positive().max(60).optional(),
}).strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof Body>;
  try { body = Body.parse(await req.json()); }
  catch (err) { return NextResponse.json({ error: "invalid body", details: (err as Error).message }, { status: 400 }); }
  const result = activateCapsule(id, body.activated_by, { bypass: body.bypass, windowDays: body.window_days });
  if (!result.ok) return NextResponse.json(result, { status: 422 });
  return NextResponse.json(result);
}
