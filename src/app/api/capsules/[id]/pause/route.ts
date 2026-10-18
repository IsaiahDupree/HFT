import { NextResponse } from "next/server";
import { z } from "zod";
import { pauseCapsule } from "@/lib/arena/championship";

export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().min(1).max(200) }).strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof Body>;
  try { body = Body.parse(await req.json()); }
  catch (err) { return NextResponse.json({ error: "invalid body", details: (err as Error).message }, { status: 400 }); }
  pauseCapsule(id, body.reason);
  return NextResponse.json({ ok: true });
}
